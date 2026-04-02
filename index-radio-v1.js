const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error', e => console.error('[Redis]', e.message));
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('rb:token:' + token, JSON.stringify({ createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount }));
  } catch (e) {
    console.error('[Redis] Save failed:', e.message);
  }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    const d = await redis.get('rb:token:' + token);
    return d ? JSON.parse(d) : null;
  } catch (e) {
    return null;
  }
}

const TOKEN_CACHE = new Map();
const IP_CREATES = new Map();
const STATION_CACHE = new Map();
const SEARCH_CACHE = new Map();
const PLAYLIST_CACHE = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX = 90;
const RATE_WINDOW_MS = 60000;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const UA = 'EclipseRadioAddon/1.0.0';
const RB_BASE = process.env.RADIO_BROWSER_BASE || 'https://de1.api.radio-browser.info';

function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : null; }
function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  const saved = await redisLoad(token);
  if (!saved) return null;
  const entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

function checkRateLimit(entry) {
  const now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(t => now - t < RATE_WINDOW_MS);
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed = now;
  entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  const entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

async function rbGet(path, params = {}) {
  try {
    const r = await axios.get(RB_BASE + path, {
      params,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: 15000
    });
    return r.data;
  } catch (e) {
    console.warn('[RB]', path, e.message);
    return null;
  }
}

function detectFormat(url, hls) {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (hls === 1 || u.endsWith('.m3u8')) return 'hls';
  if (u.endsWith('.aac') || u.endsWith('.aacp')) return 'aac';
  if (u.endsWith('.ogg') || u.endsWith('.opus')) return 'ogg';
  if (u.endsWith('.flac')) return 'flac';
  return 'mp3';
}

function stationArtwork(station) {
  return safeUrl(station.favicon) || 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png';
}

function stationSubtitle(station) {
  const bits = [];
  if (station.country) bits.push(cleanText(station.country));
  if (station.language) bits.push(cleanText(station.language));
  if (station.codec) bits.push(cleanText(station.codec) + (station.bitrate ? ' ' + station.bitrate + 'k' : ''));
  return bits.join(' • ');
}

function mapStationToTrack(station) {
  const id = 'rb_st_' + station.stationuuid;
  const obj = {
    id,
    title: cleanText(station.name) || 'Radio Station',
    artist: stationSubtitle(station) || 'Radio Browser',
    album: cleanText(station.tags || station.country || 'Live Radio'),
    duration: null,
    artworkURL: stationArtwork(station),
    streamURL: safeUrl(station.url_resolved) || safeUrl(station.url),
    format: detectFormat(station.url_resolved || station.url, station.hls),
    isLive: true
  };
  STATION_CACHE.set(id, station);
  return obj;
}

function mapStationToAlbum(station) {
  const id = 'rb_st_' + station.stationuuid;
  STATION_CACHE.set(id, station);
  return {
    id,
    title: cleanText(station.name) || 'Radio Station',
    artist: cleanText(station.country || station.language || 'Radio Browser'),
    artworkURL: stationArtwork(station),
    trackCount: 1,
    year: null
  };
}

function mapCountryToPlaylist(c) {
  return {
    id: 'rb_country_' + encodeURIComponent(c.name),
    title: cleanText(c.name) + ' Radio',
    creator: 'Radio Browser',
    artworkURL: null,
    trackCount: parseInt(c.stationcount || 0) || null,
    description: 'Stations from ' + cleanText(c.name)
  };
}

function mapLanguageToPlaylist(l) {
  return {
    id: 'rb_lang_' + encodeURIComponent(l.name),
    title: cleanText(l.name) + ' Radio',
    creator: 'Radio Browser',
    artworkURL: null,
    trackCount: parseInt(l.stationcount || 0) || null,
    description: 'Stations in ' + cleanText(l.name)
  };
}

function mapTagToPlaylist(t) {
  return {
    id: 'rb_tag_' + encodeURIComponent(t.name),
    title: cleanText(t.name) + ' Radio',
    creator: 'Radio Browser',
    artworkURL: null,
    trackCount: parseInt(t.stationcount || 0) || null,
    description: cleanText(t.name) + ' radio stations'
  };
}

function scoreStation(station, q) {
  const needle = cleanText(q).toLowerCase();
  const hay = [station.name, station.tags, station.country, station.language].map(x => cleanText(x).toLowerCase()).join(' | ');
  let score = 0;
  if (cleanText(station.name).toLowerCase() === needle) score += 200;
  if (cleanText(station.name).toLowerCase().startsWith(needle)) score += 90;
  if (hay.includes(needle)) score += 40;
  if (station.lastcheckok === 1) score += 50;
  if ((parseInt(station.clickcount || 0) || 0) > 0) score += Math.min(parseInt(station.clickcount || 0), 50);
  if ((parseInt(station.votes || 0) || 0) > 0) score += Math.min(parseInt(station.votes || 0), 50);
  if ((parseInt(station.bitrate || 0) || 0) >= 128) score += 15;
  if (!safeUrl(station.url_resolved || station.url)) score -= 200;
  return score;
}

async function searchStations(q) {
  const key = cleanText(q).toLowerCase();
  const cached = SEARCH_CACHE.get(key);
  if (cached && Date.now() - cached.ts < SEARCH_TTL_MS) return cached.data;

  const [stations, tags, countries, languages] = await Promise.all([
    rbGet('/json/stations/search', { name: q, limit: 30, hidebroken: true, order: 'clickcount', reverse: true }),
    rbGet('/json/tags/' + encodeURIComponent(q), { order: 'stationcount', reverse: true, limit: 8, hidebroken: true }),
    rbGet('/json/countries/' + encodeURIComponent(q), { order: 'stationcount', reverse: true, limit: 8, hidebroken: true }),
    rbGet('/json/languages/' + encodeURIComponent(q), { order: 'stationcount', reverse: true, limit: 8, hidebroken: true })
  ]);

  const rankedStations = (Array.isArray(stations) ? stations : [])
    .filter(s => safeUrl(s.url_resolved || s.url) && s.lastcheckok === 1)
    .sort((a, b) => scoreStation(b, q) - scoreStation(a, q))
    .slice(0, 20);

  const data = {
    stations: rankedStations,
    tags: Array.isArray(tags) ? tags.slice(0, 6) : [],
    countries: Array.isArray(countries) ? countries.slice(0, 6) : [],
    languages: Array.isArray(languages) ? languages.slice(0, 6) : []
  };

  SEARCH_CACHE.set(key, { ts: Date.now(), data });
  return data;
}

async function stationByUuid(uuid) {
  const cached = STATION_CACHE.get('rb_st_' + uuid);
  if (cached) return cached;
  const rows = await rbGet('/json/stations/byuuid/' + encodeURIComponent(uuid), { hidebroken: true });
  const station = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (station) STATION_CACHE.set('rb_st_' + uuid, station);
  return station;
}

async function loadPlaylist(id) {
  if (PLAYLIST_CACHE.has(id)) return PLAYLIST_CACHE.get(id);
  let rows = [];
  let title = 'Radio Playlist';
  let description = 'Live stations';

  if (id.startsWith('rb_country_')) {
    const country = decodeURIComponent(id.replace('rb_country_', ''));
    rows = await rbGet('/json/stations/bycountryexact/' + encodeURIComponent(country), { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = country + ' Radio';
    description = 'Top live stations from ' + country;
  } else if (id.startsWith('rb_lang_')) {
    const language = decodeURIComponent(id.replace('rb_lang_', ''));
    rows = await rbGet('/json/stations/bylanguageexact/' + encodeURIComponent(language), { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = language + ' Radio';
    description = 'Top live stations in ' + language;
  } else if (id.startsWith('rb_tag_')) {
    const tag = decodeURIComponent(id.replace('rb_tag_', ''));
    rows = await rbGet('/json/stations/bytagexact/' + encodeURIComponent(tag), { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = tag + ' Radio';
    description = tag + ' radio stations';
  } else if (id === 'rb_trending') {
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'clicktrend', reverse: true, limit: 50 });
    title = 'Trending Radio';
    description = 'Stations trending right now';
  } else if (id === 'rb_topvoted') {
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'votes', reverse: true, limit: 50 });
    title = 'Top Voted Radio';
    description = 'Highest voted stations';
  } else if (id === 'rb_topclicks') {
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = 'Popular Radio';
    description = 'Most clicked live stations';
  }

  const stations = (Array.isArray(rows) ? rows : []).filter(s => safeUrl(s.url_resolved || s.url) && s.lastcheckok === 1).slice(0, 50);
  const playlist = {
    id,
    title,
    description,
    artworkURL: stations[0] ? stationArtwork(stations[0]) : null,
    creator: 'Radio Browser',
    tracks: stations.map(mapStationToTrack)
  };
  PLAYLIST_CACHE.set(id, playlist);
  return playlist;
}

function buildConfigPage(baseUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Radio Browser for Eclipse</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0b10;color:#e7ebf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}.logo-wrap{display:flex;align-items:center;gap:14px;margin-bottom:28px}.logo-text{font-size:26px;font-weight:800;color:#56a7ff;letter-spacing:-.02em}.logo-sub{font-size:13px;color:#55657e;margin-top:3px}.card{background:#121722;border:1px solid #1d2636;border-radius:18px;padding:36px;max-width:560px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:20px}h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}p.sub{font-size:14px;color:#91a0b9;margin-bottom:20px;line-height:1.6}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}.stat{background:#0d1119;border:1px solid #1a2130;border-radius:10px;padding:14px;text-align:center}.stat-n{font-size:22px;font-weight:800;color:#56a7ff}.stat-l{font-size:11px;color:#667791;margin-top:3px}.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#111a29;color:#56a7ff;border:1px solid #22324b}.pill.g{background:#111d15;color:#6ec77b;border-color:#26432c}.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6d7a91;margin-bottom:8px;margin-top:16px}input{width:100%;background:#0c1018;border:1px solid #1e2634;border-radius:10px;color:#e7ebf3;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}input:focus{border-color:#56a7ff}input::placeholder{color:#425066}.hint{font-size:12px;color:#73829b;margin-bottom:12px;line-height:1.7}.hint code{background:#111826;padding:1px 5px;border-radius:4px;color:#7db8ff}button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}.bo{background:#56a7ff;color:#07101e}.bo:hover{background:#7db8ff}.bo:disabled{background:#2a3547;color:#70809b;cursor:not-allowed}.bg{background:#15301b;color:#e7ebf3;border:1px solid #2c5a36}.bg:hover{background:#1a3d23}.bd{background:#171d28;color:#aab4c5;border:1px solid #283244;font-size:13px;padding:10px}.bd:hover{background:#1e2634;color:#fff}.box{display:none;background:#0c1018;border:1px solid #1e2634;border-radius:12px;padding:18px;margin-bottom:14px}.blbl{font-size:10px;color:#6b7993;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}.burl{font-size:12px;color:#7db8ff;word-break:break-all;font-family:"SF Mono",ui-monospace,monospace;margin-bottom:14px;line-height:1.5}hr{border:none;border-top:1px solid #1a2230;margin:24px 0}.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}.sn{background:#141b28;border:1px solid #263045;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#8ca0bf}.st{font-size:13px;color:#9aa8bf;line-height:1.6}.st b{color:#d7e1f1}.warn{background:#101726;border:1px solid #22324b;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#7fa9d9;line-height:1.7}.status{font-size:13px;color:#7a8aa5;margin:8px 0;min-height:18px}.status.ok{color:#6ec77b}.status.err{color:#d96b6b}.status.spin{color:#7db8ff}.preview{background:#0c1018;border:1px solid #1a2230;border-radius:10px;padding:12px;max-height:240px;overflow-y:auto;margin-bottom:12px;display:none}.tr{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #151c29;font-size:13px}.tr:last-child{border-bottom:none}.tn{color:#4d5d78;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}.tt{color:#e7ebf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#7e8ca3;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}footer{margin-top:32px;font-size:12px;color:#4e5c75;text-align:center;line-height:1.8}footer a{color:#4e5c75;text-decoration:none}</style></head><body><div class="logo-wrap"><svg width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#13233b"/><path d="M18 33c3-8 13-8 16 0" stroke="#56a7ff" stroke-width="3" stroke-linecap="round"/><path d="M14 27c5-13 19-13 24 0" stroke="#56a7ff" stroke-width="3" stroke-linecap="round" opacity=".7"/><circle cx="26" cy="36" r="2.5" fill="#56a7ff"/></svg><div><div class="logo-text">Radio Browser</div><div class="logo-sub">for Eclipse Music</div></div></div><div class="card"><div class="stat-grid"><div class="stat"><div class="stat-n">Live</div><div class="stat-l">Stations</div></div><div class="stat"><div class="stat-n">Global</div><div class="stat-l">Countries</div></div><div class="stat"><div class="stat-n">Free</div><div class="stat-l">No API Key</div></div></div><p class="sub">Search and stream live radio stations inside Eclipse using Radio Browser. Browse by station name, country, language, genre, or trending stations.</p><div class="pills"><span class="pill">Live radio</span><span class="pill">Countries</span><span class="pill">Languages</span><span class="pill">Genres</span><span class="pill g">No signup needed</span><span class="pill g">Direct streams</span></div><button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button><div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div><div class="status" id="genStatus"></div><hr><div class="lbl">Restore an existing URL</div><input type="text" id="existingUrl" placeholder="Paste your existing addon URL here"><button class="bg" id="refBtn" onclick="doRefresh()">Restore Existing URL</button><div class="box" id="refBox"><div class="blbl">Restored — still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div><hr><div class="steps"><div class="step"><div class="sn">1</div><div class="st">Click <b>Generate My Addon URL</b></div></div><div class="step"><div class="sn">2</div><div class="st">Copy your URL</div></div><div class="step"><div class="sn">3</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div><div class="step"><div class="sn">4</div><div class="st">Paste your URL and tap <b>Install</b></div></div></div><div class="warn">This addon uses public Radio Browser data and resolved stream URLs. Tokens survive server restarts when Redis is configured.</div></div><div class="card"><h2>Import Stations to Eclipse Library</h2><p class="sub">Downloads a CSV you can import via Library → Import CSV in Eclipse. You can import a country, language, tag, or search term.</p><div class="lbl">Your Addon URL</div><input type="text" id="impToken" placeholder="Paste your addon URL (auto-fills after generating)"><div class="lbl">Import type</div><input type="text" id="impType" placeholder="country, language, tag, trending, topvoted, topclicks, or search"><div class="lbl">Value</div><input type="text" id="impValue" placeholder="Example: United States, english, jazz, or smooth jazz"><div class="hint">Examples: <code>country + United States</code>, <code>language + english</code>, <code>tag + jazz</code>, <code>search + lofi</code>, or <code>trending</code> with the value left blank.</div><div class="status" id="impStatus"></div><div class="preview" id="impPreview"></div><button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button></div><footer>Eclipse Radio Addon v1.0.0 • Powered by <a href="https://www.radio-browser.info/" target="_blank" rel="noopener noreferrer">Radio Browser</a> • <a href="${baseUrl}/health" target="_blank" rel="noopener noreferrer">Health</a></footer><script>var _gu="",_ru="";function generate(){var btn=document.getElementById("genBtn"),st=document.getElementById("genStatus");btn.disabled=true;btn.textContent="Generating...";st.className="status spin";st.textContent="Creating your token…";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(r=>r.json()).then(d=>{if(d.error){st.className="status err";st.textContent=d.error;btn.disabled=false;btn.textContent="Generate My Addon URL";return;}_gu=d.manifestUrl;document.getElementById("genUrl").textContent=_gu;document.getElementById("genBox").style.display="block";document.getElementById("impToken").value=_gu;st.className="status ok";st.textContent="✓ Your addon URL is ready";btn.disabled=false;btn.textContent="Regenerate URL";}).catch(e=>{st.className="status err";st.textContent="Error: "+e.message;btn.disabled=false;btn.textContent="Generate My Addon URL";});}function copyUrl(){if(!_gu)return;navigator.clipboard.writeText(_gu).then(()=>{var b=document.getElementById("copyBtn");b.textContent="Copied!";setTimeout(()=>b.textContent="Copy URL",1500);});}function doRefresh(){var btn=document.getElementById("refBtn"),eu=document.getElementById("existingUrl").value.trim();if(!eu){alert("Paste your existing addon URL first.");return;}btn.disabled=true;btn.textContent="Checking…";fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})}).then(r=>r.json()).then(d=>{if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Restore Existing URL";return;}_ru=d.manifestUrl;document.getElementById("refUrl").textContent=_ru;document.getElementById("refBox").style.display="block";document.getElementById("impToken").value=_ru;btn.disabled=false;btn.textContent="Restore Again";}).catch(e=>{alert("Error: "+e.message);btn.disabled=false;btn.textContent="Restore Existing URL";});}function copyRef(){if(!_ru)return;navigator.clipboard.writeText(_ru).then(()=>{var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(()=>b.textContent="Copy URL",1500);});}function getTok(s){var m=s.match(/\/u\/([a-f0-9]{28})\//);return m?m[1]:null;}function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}function doImport(){var btn=document.getElementById("impBtn"),raw=document.getElementById("impToken").value.trim(),type=document.getElementById("impType").value.trim(),value=document.getElementById("impValue").value.trim(),st=document.getElementById("impStatus"),pv=document.getElementById("impPreview");if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}if(!type){st.className="status err";st.textContent="Enter an import type.";return;}var tok=getTok(raw);if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}btn.disabled=true;btn.textContent="Fetching…";st.className="status spin";st.textContent="Fetching stations…";pv.style.display="none";fetch("/u/"+tok+"/import?type="+encodeURIComponent(type)+"&value="+encodeURIComponent(value)).then(r=>{if(!r.ok)return r.json().then(e=>{throw new Error(e.error||"Server error "+r.status);});return r.json();}).then(data=>{var tracks=data.tracks||[];if(!tracks.length)throw new Error("No stations found.");var rows=tracks.slice(0,60).map((t,i)=>"<div class=\"tr\"><span class=\"tn\">"+(i+1)+"</span><div class=\"ti\"><div class=\"tt\">"+hesc(t.title)+"</div><div class=\"ta\">"+hesc(t.artist)+"</div></div></div>").join("");if(tracks.length>60)rows+="<div class=\"tr\" style=\"text-align:center;color:#555\">+"+(tracks.length-60)+" more stations</div>";pv.innerHTML=rows;pv.style.display="block";st.className="status ok";st.textContent="Found "+tracks.length+" stations in ""+data.title+""";var lines=["Title,Artist,Album,Duration"];tracks.forEach(t=>{function ce(s){s=String(s||"");if(s.includes(",")||s.includes("""))s='"'+s.replace(/"/g,'""')+'"';return s;}lines.push(ce(t.title)+","+ce(t.artist)+","+ce(data.title||"")+","+ce(""));});var blob=new Blob([lines.join("
")],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(data.title||"radio").replace(/[^a-zA-Z0-9 _-]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);btn.disabled=false;btn.textContent="Fetch & Download CSV";}).catch(e=>{st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV";});}</script></body></html>`;
}

app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  const token = generateToken();
  const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async function(req, res) {
  const raw = String((req.body && req.body.existingUrl) || '').trim();
  const m = raw.match(/\/u\/([a-f0-9]{28})\//);
  const token = m ? m[1] : (/^[a-f0-9]{28}$/.test(raw) ? raw : null);
  if (!token) return res.status(400).json({ error: 'Paste your full addon URL.' });
  const entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id: 'com.eclipse.radio.' + req.params.token.slice(0, 8),
    name: 'Radio Browser',
    version: '1.0.0',
    description: 'Search and stream live radio stations by name, country, language, and genre.',
    icon: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  const q = cleanText(req.query.q);
  if (!q) {
    return res.json({
      tracks: [],
      albums: [],
      artists: [],
      playlists: [
        { id: 'rb_trending', title: 'Trending Radio', creator: 'Radio Browser', artworkURL: null, trackCount: 50, description: 'Stations trending right now' },
        { id: 'rb_topclicks', title: 'Popular Radio', creator: 'Radio Browser', artworkURL: null, trackCount: 50, description: 'Most clicked live stations' },
        { id: 'rb_topvoted', title: 'Top Voted Radio', creator: 'Radio Browser', artworkURL: null, trackCount: 50, description: 'Highest voted stations' }
      ]
    });
  }

  try {
    const data = await searchStations(q);
    const tracks = data.stations.slice(0, 12).map(mapStationToTrack);
    const albums = data.stations.slice(0, 12).map(mapStationToAlbum);

    const artistMap = new Map();
    data.stations.forEach(s => {
      const country = cleanText(s.country || 'Unknown Country');
      const key = country.toLowerCase();
      if (!artistMap.has(key)) artistMap.set(key, { id: 'rb_artist_' + encodeURIComponent(country), name: country, artworkURL: stationArtwork(s), genres: [cleanText(s.language || ''), cleanText(s.tags || '')].filter(Boolean).slice(0, 2) });
    });

    const playlists = [
      ...data.countries.map(mapCountryToPlaylist),
      ...data.languages.map(mapLanguageToPlaylist),
      ...data.tags.map(mapTagToPlaylist)
    ].slice(0, 10);

    res.json({ tracks, albums, artists: Array.from(artistMap.values()).slice(0, 6), playlists });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'Search failed', tracks: [], albums: [], artists: [], playlists: [] });
  }
});

app.get('/u/:token/stream/:id', tokenMiddleware, async function(req, res) {
  const id = req.params.id;
  const cached = STATION_CACHE.get(id);
  if (cached) {
    const url = safeUrl(cached.url_resolved) || safeUrl(cached.url);
    if (url) {
      rbGet('/json/url/' + encodeURIComponent(cached.stationuuid)).catch(() => {});
      return res.json({ url, format: detectFormat(url, cached.hls) });
    }
  }

  const uuid = id.replace('rb_st_', '');
  const station = await stationByUuid(uuid);
  if (station) {
    const url = safeUrl(station.url_resolved) || safeUrl(station.url);
    if (url) {
      rbGet('/json/url/' + encodeURIComponent(station.stationuuid)).catch(() => {});
      return res.json({ url, format: detectFormat(url, station.hls) });
    }
  }
  return res.status(404).json({ error: 'Stream not found: ' + id });
});

app.get('/u/:token/album/:id', tokenMiddleware, async function(req, res) {
  const rawId = req.params.id;
  const uuid = rawId.replace('rb_st_', '');
  const station = await stationByUuid(uuid);
  if (!station) return res.status(404).json({ error: 'Station not found.' });
  const track = mapStationToTrack(station);
  res.json({
    id: rawId,
    title: cleanText(station.name) || 'Radio Station',
    artist: cleanText(station.country || station.language || 'Radio Browser'),
    artworkURL: stationArtwork(station),
    year: null,
    description: cleanText([station.tags, station.country, station.language, station.codec ? station.codec + (station.bitrate ? ' ' + station.bitrate + 'k' : '') : ''].filter(Boolean).join(' • ')),
    trackCount: 1,
    tracks: [track]
  });
});

app.get('/u/:token/artist/:id', tokenMiddleware, async function(req, res) {
  const rawId = req.params.id;
  const country = decodeURIComponent(rawId.replace('rb_artist_', ''));
  try {
    const rows = await rbGet('/json/stations/bycountryexact/' + encodeURIComponent(country), { hidebroken: true, order: 'clickcount', reverse: true, limit: 30 });
    const stations = (Array.isArray(rows) ? rows : []).filter(s => safeUrl(s.url_resolved || s.url) && s.lastcheckok === 1);
    res.json({
      id: rawId,
      name: country,
      artworkURL: stations[0] ? stationArtwork(stations[0]) : null,
      bio: 'Live radio stations from ' + country,
      genres: Array.from(new Set(stations.flatMap(s => cleanText(s.language).split(',').map(x => cleanText(x)).filter(Boolean)))).slice(0, 3),
      topTracks: stations.slice(0, 8).map(mapStationToTrack),
      albums: stations.slice(0, 12).map(mapStationToAlbum)
    });
  } catch (e) {
    console.error('[artist]', e.message);
    res.status(500).json({ error: 'Country fetch failed.' });
  }
});

app.get('/u/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  try {
    const data = await loadPlaylist(req.params.id);
    if (!data || !Array.isArray(data.tracks) || !data.tracks.length) return res.status(404).json({ error: 'Playlist not found.' });
    res.json(data);
  } catch (e) {
    console.error('[playlist]', e.message);
    res.status(500).json({ error: 'Playlist fetch failed.' });
  }
});

app.get('/u/:token/import', tokenMiddleware, async function(req, res) {
  const type = cleanText(req.query.type).toLowerCase();
  const value = cleanText(req.query.value);
  if (!type) return res.status(400).json({ error: 'Pass ?type=country|language|tag|trending|topvoted|topclicks|search and optional &value=' });

  let title = 'Radio Import';
  let rows = [];

  if (type === 'country') {
    title = value + ' Radio';
    rows = await rbGet('/json/stations/bycountryexact/' + encodeURIComponent(value), { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 });
  } else if (type === 'language') {
    title = value + ' Radio';
    rows = await rbGet('/json/stations/bylanguageexact/' + encodeURIComponent(value), { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 });
  } else if (type === 'tag') {
    title = value + ' Radio';
    rows = await rbGet('/json/stations/bytagexact/' + encodeURIComponent(value), { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 });
  } else if (type === 'trending') {
    title = 'Trending Radio';
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'clicktrend', reverse: true, limit: 100 });
  } else if (type === 'topvoted') {
    title = 'Top Voted Radio';
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'votes', reverse: true, limit: 100 });
  } else if (type === 'topclicks') {
    title = 'Popular Radio';
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 });
  } else if (type === 'search') {
    title = value || 'Search Radio';
    const data = await searchStations(value);
    rows = data.stations;
  } else {
    return res.status(400).json({ error: 'Unsupported import type.' });
  }

  const tracks = (Array.isArray(rows) ? rows : []).filter(s => safeUrl(s.url_resolved || s.url) && s.lastcheckok === 1).slice(0, 100).map(mapStationToTrack);
  res.json({ title, tracks });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '1.0.0', radioBrowserBase: RB_BASE, redisConnected: !!(redis && redis.status === 'ready'), activeTokens: TOKEN_CACHE.size, cachedStations: STATION_CACHE.size, cachedSearches: SEARCH_CACHE.size, cachedPlaylists: PLAYLIST_CACHE.size, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log('Eclipse Radio Addon v1.0.0 on port ' + PORT));
