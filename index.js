const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

/* ── Redis ─────────────────────────────────────────────────────── */
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error',   e  => console.error('[Redis]', e.message));
}
async function redisSave(token, entry) {
  if (!redis) return;
  try { await redis.set('rb:token:' + token, JSON.stringify({ createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount })); }
  catch (e) { console.error('[Redis] Save failed:', e.message); }
}
async function redisLoad(token) {
  if (!redis) return null;
  try { const d = await redis.get('rb:token:' + token); return d ? JSON.parse(d) : null; }
  catch (e) { return null; }
}

/* ── Token store ────────────────────────────────────────────────── */
const TOKEN_CACHE       = new Map();
const IP_CREATES        = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
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
  entry.rateWin.push(now); entry.lastUsed = now; entry.reqCount = (entry.reqCount || 0) + 1;
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

function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }
function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/* ── Radio Browser API ──────────────────────────────────────────── */
const RB_HOSTS = ['https://de1.api.radio-browser.info', 'https://fr1.api.radio-browser.info', 'https://nl1.api.radio-browser.info'];
const UA       = 'EclipseRadioAddon/1.0';
const SEARCH_CACHE = new Map();

async function rbGet(path, params, tryCount) {
  tryCount = tryCount || 0;
  const host = RB_HOSTS[tryCount % RB_HOSTS.length];
  try {
    const r = await axios.get(host + path, {
      params,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: 12000
    });
    return Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    if (tryCount < RB_HOSTS.length - 1) return rbGet(path, params, tryCount + 1);
    console.warn('[RB]', path, e.message);
    return [];
  }
}

function mapStation(st) {
  return {
    id:         'rb_' + st.stationuuid,
    title:      cleanText(st.name) || 'Unknown Station',
    artist:     cleanText(st.country) || cleanText(st.language) || 'Radio',
    album:      cleanText(st.tags ? st.tags.split(',')[0] : '') || 'Live Radio',
    duration:   null,
    artworkURL: (st.favicon && st.favicon.startsWith('http')) ? st.favicon : null,
    streamURL:  st.url_resolved || st.url || null,
    format:     (st.codec || 'mp3').toLowerCase(),
    bitrate:    st.bitrate || null
  };
}

/* ── Config page ────────────────────────────────────────────────── */
function buildConfigPage(baseUrl) {
  const jsLines = [
    'var _gu="",_ru="";',
    'function generate(){',
    '  var btn=document.getElementById("genBtn"),st=document.getElementById("genStatus");',
    '  btn.disabled=true;btn.textContent="Generating...";',
    '  st.className="status spin";st.textContent="Creating your token...";',
    '  fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json();}).then(function(d){',
    '    if(d.error){st.className="status err";st.textContent=d.error;btn.disabled=false;btn.textContent="Generate My Addon URL";return;}',
    '    _gu=d.manifestUrl;',
    '    document.getElementById("genUrl").textContent=_gu;',
    '    document.getElementById("genBox").style.display="block";',
    '    document.getElementById("impToken").value=_gu;',
    '    st.className="status ok";st.textContent="Your addon URL is ready";',
    '    btn.disabled=false;btn.textContent="Regenerate URL";',
    '  }).catch(function(e){',
    '    st.className="status err";st.textContent="Error: "+e.message;',
    '    btn.disabled=false;btn.textContent="Generate My Addon URL";',
    '  });',
    '}',
    'function copyUrl(){',
    '  if(!_gu)return;',
    '  navigator.clipboard.writeText(_gu).then(function(){',
    '    var b=document.getElementById("copyBtn");b.textContent="Copied!";',
    '    setTimeout(function(){b.textContent="Copy URL";},1500);',
    '  });',
    '}',
    'function doRefresh(){',
    '  var btn=document.getElementById("refBtn"),eu=document.getElementById("existingUrl").value.trim();',
    '  if(!eu){alert("Paste your existing addon URL first.");return;}',
    '  btn.disabled=true;btn.textContent="Checking...";',
    '  fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})}).then(function(r){return r.json();}).then(function(d){',
    '    if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Restore Existing URL";return;}',
    '    _ru=d.manifestUrl;',
    '    document.getElementById("refUrl").textContent=_ru;',
    '    document.getElementById("refBox").style.display="block";',
    '    document.getElementById("impToken").value=_ru;',
    '    btn.disabled=false;btn.textContent="Restore Again";',
    '  }).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Restore Existing URL";});',
    '}',
    'function copyRef(){',
    '  if(!_ru)return;',
    '  navigator.clipboard.writeText(_ru).then(function(){',
    '    var b=document.getElementById("copyRefBtn");b.textContent="Copied!";',
    '    setTimeout(function(){b.textContent="Copy URL";},1500);',
    '  });',
    '}',
    'function getTok(s){',
    '  var m=s.match(/\\/u\\/([a-f0-9]{28})\\//);',
    '  return m?m[1]:null;',
    '}',
    'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
    'function csvEsc(s){',
    '  s=String(s||"");',
    '  if(s.indexOf(",")!==-1||s.indexOf(\'"\')!==-1)s=\'"\'+s.split(\'"\').join(\'""\')+\'"\';',
    '  return s;',
    '}',
    'function doImport(){',
    '  var btn=document.getElementById("impBtn");',
    '  var raw=document.getElementById("impToken").value.trim();',
    '  var type=document.getElementById("impType").value.trim();',
    '  var val=document.getElementById("impValue").value.trim();',
    '  var st=document.getElementById("impStatus");',
    '  var pv=document.getElementById("impPreview");',
    '  if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}',
    '  if(!type){st.className="status err";st.textContent="Enter an import type.";return;}',
    '  var tok=getTok(raw);',
    '  if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}',
    '  btn.disabled=true;btn.textContent="Fetching...";',
    '  st.className="status spin";st.textContent="Fetching stations...";',
    '  pv.style.display="none";',
    '  fetch("/u/"+tok+"/import?type="+encodeURIComponent(type)+"&value="+encodeURIComponent(val))',
    '  .then(function(r){',
    '    if(!r.ok)return r.json().then(function(e){throw new Error(e.error||("Server error "+r.status));});',
    '    return r.json();',
    '  }).then(function(data){',
    '    var tracks=data.tracks||[];',
    '    if(!tracks.length)throw new Error("No stations found.");',
    '    var rows=tracks.slice(0,60).map(function(t,i){',
    '      return \'<div class="tr"><span class="tn">\'+String(i+1)+\'</span><div class="ti"><div class="tt">\'+hesc(t.title)+\'</div><div class="ta">\'+hesc(t.artist)+\'</div></div></div>\';',
    '    }).join("");',
    '    if(tracks.length>60)rows+=\'<div style="text-align:center;color:#555;padding:6px 0">+\'+String(tracks.length-60)+" more</div>";',
    '    pv.innerHTML=rows;pv.style.display="block";',
    '    st.className="status ok";st.textContent="Found "+String(tracks.length)+" stations in: "+String(data.title||"");',
    '    var lines=["Title,Artist,Album,Duration"];',
    '    tracks.forEach(function(t){lines.push(csvEsc(t.title)+","+csvEsc(t.artist)+","+csvEsc(data.title||"")+",");});',
    '    var blob=new Blob([lines.join("\\n")],{type:"text/csv"});',
    '    var a=document.createElement("a");',
    '    a.href=URL.createObjectURL(blob);',
    '    a.download=String(data.title||"radio").replace(/[^a-zA-Z0-9 _-]/g,"").trim()+".csv";',
    '    document.body.appendChild(a);a.click();document.body.removeChild(a);',
    '    btn.disabled=false;btn.textContent="Fetch & Download CSV";',
    '  }).catch(function(e){',
    '    st.className="status err";st.textContent=e.message;',
    '    btn.disabled=false;btn.textContent="Fetch & Download CSV";',
    '  });',
    '}'
  ];
  const js = jsLines.join('\n');

  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>Radio Browser for Eclipse</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0a0b10;color:#e7ebf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.logo-wrap{display:flex;align-items:center;gap:14px;margin-bottom:28px}.logo-text{font-size:26px;font-weight:800;color:#56a7ff;letter-spacing:-.02em}.logo-sub{font-size:13px;color:#55657e;margin-top:3px}';
  h += '.card{background:#121722;border:1px solid #1d2636;border-radius:18px;padding:36px;max-width:560px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:20px}';
  h += 'h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}p.sub{font-size:14px;color:#91a0b9;margin-bottom:20px;line-height:1.6}';
  h += '.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}.stat{background:#0d1119;border:1px solid #1a2130;border-radius:10px;padding:14px;text-align:center}.stat-n{font-size:22px;font-weight:800;color:#56a7ff}.stat-l{font-size:11px;color:#667791;margin-top:3px}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#111a29;color:#56a7ff;border:1px solid #22324b}.pill.g{background:#111d15;color:#6ec77b;border-color:#26432c}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6d7a91;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0c1018;border:1px solid #1e2634;border-radius:10px;color:#e7ebf3;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}input:focus{border-color:#56a7ff}input::placeholder{color:#425066}';
  h += '.hint{font-size:12px;color:#73829b;margin-bottom:12px;line-height:1.7}.hint code{background:#111826;padding:1px 5px;border-radius:4px;color:#7db8ff}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.bo{background:#56a7ff;color:#07101e}.bo:hover{background:#7db8ff}.bo:disabled{background:#2a3547;color:#70809b;cursor:not-allowed}';
  h += '.bg{background:#15301b;color:#e7ebf3;border:1px solid #2c5a36}.bg:hover{background:#1a3d23}.bg:disabled{background:#151e15;color:#445544;cursor:not-allowed}';
  h += '.bd{background:#171d28;color:#aab4c5;border:1px solid #283244;font-size:13px;padding:10px}.bd:hover{background:#1e2634;color:#fff}';
  h += '.box{display:none;background:#0c1018;border:1px solid #1e2634;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#6b7993;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#7db8ff;word-break:break-all;font-family:"SF Mono",ui-monospace,monospace;margin-bottom:14px;line-height:1.5}';
  h += 'hr{border:none;border-top:1px solid #1a2230;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#141b28;border:1px solid #263045;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#8ca0bf}';
  h += '.st{font-size:13px;color:#9aa8bf;line-height:1.6}.st b{color:#d7e1f1}';
  h += '.warn{background:#101726;border:1px solid #22324b;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#7fa9d9;line-height:1.7}';
  h += '.status{font-size:13px;color:#7a8aa5;margin:8px 0;min-height:18px}.status.ok{color:#6ec77b}.status.err{color:#d96b6b}.status.spin{color:#7db8ff}';
  h += '.preview{background:#0c1018;border:1px solid #1a2230;border-radius:10px;padding:12px;max-height:240px;overflow-y:auto;margin-bottom:12px;display:none}';
  h += '.tr{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #151c29;font-size:13px}.tr:last-child{border-bottom:none}';
  h += '.tn{color:#4d5d78;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}';
  h += '.tt{color:#e7ebf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#7e8ca3;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  h += 'footer{margin-top:32px;font-size:12px;color:#4e5c75;text-align:center;line-height:1.8}footer a{color:#4e5c75;text-decoration:none}</style></head><body>';
  h += '<div class="logo-wrap"><svg width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#13233b"/><path d="M18 33c3-8 13-8 16 0" stroke="#56a7ff" stroke-width="3" stroke-linecap="round"/><path d="M14 27c5-13 19-13 24 0" stroke="#56a7ff" stroke-width="3" stroke-linecap="round" opacity=".7"/><circle cx="26" cy="36" r="2.5" fill="#56a7ff"/></svg><div><div class="logo-text">Radio Browser</div><div class="logo-sub">for Eclipse Music</div></div></div>';
  h += '<div class="card"><div class="stat-grid"><div class="stat"><div class="stat-n">Live</div><div class="stat-l">Stations</div></div><div class="stat"><div class="stat-n">Global</div><div class="stat-l">Countries</div></div><div class="stat"><div class="stat-n">Free</div><div class="stat-l">No API Key</div></div></div>';
  h += '<p class="sub">Search and stream live radio stations inside Eclipse. Browse by station name, country, language, genre, or discover trending stations.</p>';
  h += '<div class="pills"><span class="pill">Live radio</span><span class="pill">Countries</span><span class="pill">Languages</span><span class="pill">Genres</span><span class="pill g">No signup needed</span><span class="pill g">Direct streams</span></div>';
  h += '<button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL &mdash; paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div>';
  h += '<div class="status" id="genStatus"></div><hr>';
  h += '<div class="lbl">Restore an existing URL</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
  h += '<button class="bg" id="refBtn" onclick="doRefresh()">Restore Existing URL</button>';
  h += '<div class="box" id="refBox"><div class="blbl">Restored &mdash; still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';
  h += '<hr><div class="steps"><div class="step"><div class="sn">1</div><div class="st">Click <b>Generate My Addon URL</b></div></div><div class="step"><div class="sn">2</div><div class="st">Copy your URL</div></div><div class="step"><div class="sn">3</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div><div class="step"><div class="sn">4</div><div class="st">Paste your URL and tap <b>Install</b></div></div></div>';
  h += '<div class="warn">Tokens survive server restarts when Redis is configured. Each user should generate their own URL for separate rate limits.</div></div>';
  h += '<div class="card"><h2>Import Stations to Eclipse Library</h2><p class="sub">Downloads a CSV you can import via Library &rarr; Import CSV in Eclipse.</p>';
  h += '<div class="lbl">Your Addon URL</div><input type="text" id="impToken" placeholder="Auto-fills after generating">';
  h += '<div class="lbl">Import type</div><input type="text" id="impType" placeholder="country, language, tag, trending, topvoted, topclicks, or search">';
  h += '<div class="lbl">Value</div><input type="text" id="impValue" placeholder="e.g. United States &nbsp; english &nbsp; jazz">';
  h += '<div class="hint">Examples: <code>country</code> + <code>United States</code> &bull; <code>tag</code> + <code>jazz</code> &bull; <code>search</code> + <code>lofi</code> &bull; <code>trending</code> (leave value blank)</div>';
  h += '<div class="status" id="impStatus"></div><div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button></div>';
  h += '<footer>Eclipse Radio Addon v1.0.2 &bull; Powered by <a href="https://www.radio-browser.info/" target="_blank" rel="noopener noreferrer">Radio Browser</a> &bull; <a href="' + baseUrl + '/health" target="_blank" rel="noopener noreferrer">Health</a></footer>';
  h += '<script>' + js + '<\/script></body></html>';
  return h;
}

/* ── Routes ─────────────────────────────────────────────────────── */
app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  const ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
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
  const raw   = String((req.body && req.body.existingUrl) || '').trim();
  const m     = raw.match(/\/u\/([a-f0-9]{28})\//);
  const token = m ? m[1] : (/^[a-f0-9]{28}$/.test(raw) ? raw : null);
  if (!token) return res.status(400).json({ error: 'Paste your full addon URL.' });
  const entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

/* ── Manifest ───────────────────────────────────────────────────── */
app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.radiobrowser.' + req.params.token.slice(0, 8),
    name:        'Radio Browser',
    version:     '1.0.2',
    description: 'Live radio stations from around the world. Search by name, country, language, or genre.',
    icon:        'https://www.radio-browser.info/static/icons/logo.svg',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

/* ── Search ─────────────────────────────────────────────────────── */
app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  const q = cleanText(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  const cacheKey = 'search:' + q.toLowerCase();
  if (SEARCH_CACHE.has(cacheKey)) return res.json(SEARCH_CACHE.get(cacheKey));

  try {
    const [nameResults, tagResults, countryResults] = await Promise.all([
      rbGet('/json/stations/search', { name: q, limit: 20, order: 'clickcount', reverse: true, hidebroken: true }),
      rbGet('/json/stations/search', { tagList: q, limit: 10, order: 'clickcount', reverse: true, hidebroken: true }),
      rbGet('/json/stations/search', { country: q, limit: 10, order: 'clickcount', reverse: true, hidebroken: true })
    ]);

    const seen = new Set();
    const allStations = [];
    for (const st of [...nameResults, ...tagResults, ...countryResults]) {
      if (!seen.has(st.stationuuid)) { seen.add(st.stationuuid); allStations.push(st); }
    }

    const tracks = allStations.slice(0, 15).map(mapStation);

    const countryMap = new Map();
    const tagMap     = new Map();
    const langMap    = new Map();
    allStations.forEach(st => {
      if (st.country && !countryMap.has(st.country)) {
        countryMap.set(st.country, { id: 'rb_country_' + encodeURIComponent(st.country), name: st.country, artworkURL: null, genres: [] });
      }
      if (st.language && !langMap.has(st.language)) {
        langMap.set(st.language, { id: 'rb_lang_' + encodeURIComponent(st.language), name: st.language + ' Radio', artworkURL: null, genres: [] });
      }
      if (st.tags) {
        st.tags.split(',').map(t => t.trim()).filter(Boolean).forEach(tag => {
          if (!tagMap.has(tag)) tagMap.set(tag, {
            id:          'rb_playlist_tag_' + encodeURIComponent(tag),
            title:       tag.charAt(0).toUpperCase() + tag.slice(1) + ' Radio',
            creator:     'Radio Browser',
            artworkURL:  allStations[0] ? (allStations[0].favicon || null) : null,
            trackCount:  null
          });
        });
      }
    });

    const artists   = [...countryMap.values(), ...langMap.values()].slice(0, 6);
    const playlists = [...tagMap.values()].slice(0, 6);
    const albums    = allStations.slice(0, 10).map(st => ({
      id:         'rb_album_' + st.stationuuid,
      title:      cleanText(st.name) || 'Unknown Station',
      artist:     cleanText(st.country) || 'Radio',
      artworkURL: (st.favicon && st.favicon.startsWith('http')) ? st.favicon : null,
      trackCount: 1,
      year:       null
    }));

    const result = { tracks, albums, artists, playlists };
    SEARCH_CACHE.set(cacheKey, result);
    setTimeout(() => SEARCH_CACHE.delete(cacheKey), 300000);
    res.json(result);
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'Search failed', tracks: [], albums: [], artists: [], playlists: [] });
  }
});

/* ── Stream ─────────────────────────────────────────────────────── */
app.get('/u/:token/stream/:id', tokenMiddleware, async function(req, res) {
  const rawId = req.params.id;
  const uuid  = rawId.replace('rb_', '');
  try {
    const stations = await rbGet('/json/stations/byuuid/' + uuid, {});
    if (stations.length && (stations[0].url_resolved || stations[0].url)) {
      const url = stations[0].url_resolved || stations[0].url;
      await rbGet('/json/url/' + uuid, {}).catch(() => {});
      return res.json({ url, format: (stations[0].codec || 'mp3').toLowerCase() });
    }
    return res.status(404).json({ error: 'Stream not found: ' + rawId });
  } catch (e) {
    return res.status(500).json({ error: 'Stream lookup failed' });
  }
});

/* ── Album (station detail) ─────────────────────────────────────── */
app.get('/u/:token/album/:id', tokenMiddleware, async function(req, res) {
  const rawId = req.params.id;
  const uuid  = rawId.replace('rb_album_', '').replace('rb_', '');
  try {
    const stations = await rbGet('/json/stations/byuuid/' + uuid, {});
    const st = stations[0];
    if (!st) return res.status(404).json({ error: 'Station not found.' });
    const track = mapStation(st);
    res.json({
      id:          rawId,
      title:       cleanText(st.name),
      artist:      cleanText(st.country) || 'Radio',
      artworkURL:  (st.favicon && st.favicon.startsWith('http')) ? st.favicon : null,
      year:        null,
      description: [st.country, st.language, st.codec ? (st.codec + (st.bitrate ? ' ' + st.bitrate + 'kbps' : '')) : null].filter(Boolean).join(' · '),
      trackCount:  1,
      tracks:      [track]
    });
  } catch (e) {
    res.status(500).json({ error: 'Station fetch failed.' });
  }
});

/* ── Artist (country / language) ────────────────────────────────── */
app.get('/u/:token/artist/:id', tokenMiddleware, async function(req, res) {
  const rawId = req.params.id;
  let stations = [], name = '';
  try {
    if (rawId.startsWith('rb_country_')) {
      const country = decodeURIComponent(rawId.replace('rb_country_', ''));
      name = country;
      stations = await rbGet('/json/stations/search', { country, limit: 30, order: 'clickcount', reverse: true, hidebroken: true });
    } else if (rawId.startsWith('rb_lang_')) {
      const lang = decodeURIComponent(rawId.replace('rb_lang_', ''));
      name = lang + ' Radio';
      stations = await rbGet('/json/stations/search', { language: lang, limit: 30, order: 'clickcount', reverse: true, hidebroken: true });
    } else {
      return res.status(404).json({ error: 'Unknown artist type.' });
    }

    const topTracks = stations.slice(0, 10).map(mapStation);
    const albums    = stations.slice(0, 20).map(st => ({
      id:         'rb_album_' + st.stationuuid,
      title:      cleanText(st.name),
      artist:     cleanText(st.country) || name,
      artworkURL: (st.favicon && st.favicon.startsWith('http')) ? st.favicon : null,
      trackCount: 1,
      year:       null
    }));

    const tagSet = new Set();
    stations.forEach(st => { if (st.tags) st.tags.split(',').map(t => t.trim()).filter(Boolean).forEach(t => tagSet.add(t)); });

    res.json({
      id:         rawId,
      name,
      artworkURL: stations.length && stations[0].favicon ? stations[0].favicon : null,
      bio:        'Radio stations from ' + name + '. ' + stations.length + ' stations found.',
      genres:     [...tagSet].slice(0, 4),
      topTracks,
      albums
    });
  } catch (e) {
    res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

/* ── Playlist (tag) ─────────────────────────────────────────────── */
app.get('/u/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  const rawId = req.params.id;
  let stations = [], title = 'Radio';
  try {
    if (rawId === 'rb_playlist_trending') {
      stations = await rbGet('/json/stations/search', { order: 'clicktrend', reverse: true, limit: 30, hidebroken: true });
      title = 'Trending Radio';
    } else if (rawId === 'rb_playlist_topvoted') {
      stations = await rbGet('/json/stations/search', { order: 'votes', reverse: true, limit: 30, hidebroken: true });
      title = 'Top Voted Radio';
    } else if (rawId === 'rb_playlist_topclicks') {
      stations = await rbGet('/json/stations/search', { order: 'clickcount', reverse: true, limit: 30, hidebroken: true });
      title = 'Most Listened Radio';
    } else if (rawId.startsWith('rb_playlist_tag_')) {
      const tag = decodeURIComponent(rawId.replace('rb_playlist_tag_', ''));
      title = tag.charAt(0).toUpperCase() + tag.slice(1) + ' Radio';
      stations = await rbGet('/json/stations/search', { tagList: tag, limit: 30, order: 'clickcount', reverse: true, hidebroken: true });
    } else {
      return res.status(404).json({ error: 'Unknown playlist type.' });
    }

    if (!stations.length) return res.status(404).json({ error: 'No stations found.' });
    const tracks = stations.map(mapStation);
    res.json({
      id:          rawId,
      title,
      description: title + ' - free live radio from Radio Browser',
      artworkURL:  stations[0].favicon || null,
      creator:     'Radio Browser',
      tracks
    });
  } catch (e) {
    res.status(500).json({ error: 'Playlist fetch failed.' });
  }
});

/* ── Catalog ────────────────────────────────────────────────────── */
app.get('/u/:token/catalog', tokenMiddleware, async function(req, res) {
  try {
    const [trending, topvoted, jazz, pop, classical] = await Promise.all([
      rbGet('/json/stations/search', { order: 'clicktrend', reverse: true, limit: 6, hidebroken: true }),
      rbGet('/json/stations/search', { order: 'votes', reverse: true, limit: 6, hidebroken: true }),
      rbGet('/json/stations/search', { tagList: 'jazz', limit: 6, order: 'clickcount', reverse: true, hidebroken: true }),
      rbGet('/json/stations/search', { tagList: 'pop', limit: 6, order: 'clickcount', reverse: true, hidebroken: true }),
      rbGet('/json/stations/search', { tagList: 'classical', limit: 6, order: 'clickcount', reverse: true, hidebroken: true })
    ]);

    const toPlaylist = (id, title, sts) => ({
      id, title, creator: 'Radio Browser', artworkURL: sts[0] ? (sts[0].favicon || null) : null,
      trackCount: sts.length, tracks: sts.map(mapStation)
    });

    res.json({
      playlists: [
        toPlaylist('rb_playlist_trending',  'Trending Now',    trending),
        toPlaylist('rb_playlist_topvoted',  'Top Voted',       topvoted),
        toPlaylist('rb_playlist_tag_jazz',  'Jazz Radio',      jazz),
        toPlaylist('rb_playlist_tag_pop',   'Pop Radio',       pop),
        toPlaylist('rb_playlist_tag_classical', 'Classical Radio', classical)
      ]
    });
  } catch (e) {
    res.status(500).json({ error: 'Catalog failed.' });
  }
});

/* ── Import ─────────────────────────────────────────────────────── */
app.get('/u/:token/import', tokenMiddleware, async function(req, res) {
  const type  = cleanText(req.query.type).toLowerCase();
  const value = cleanText(req.query.value);
  if (!type) return res.status(400).json({ error: 'Pass ?type= with country, language, tag, trending, topvoted, topclicks, or search.' });

  let stations = [], title = 'Radio';
  try {
    if      (type === 'trending')  { stations = await rbGet('/json/stations/search', { order: 'clicktrend', reverse: true, limit: 50, hidebroken: true }); title = 'Trending Radio'; }
    else if (type === 'topvoted')  { stations = await rbGet('/json/stations/search', { order: 'votes',      reverse: true, limit: 50, hidebroken: true }); title = 'Top Voted Radio'; }
    else if (type === 'topclicks') { stations = await rbGet('/json/stations/search', { order: 'clickcount', reverse: true, limit: 50, hidebroken: true }); title = 'Most Listened Radio'; }
    else if (type === 'country')   { if (!value) return res.status(400).json({ error: 'Provide a country name as value.' }); stations = await rbGet('/json/stations/search', { country: value, limit: 50, order: 'clickcount', reverse: true, hidebroken: true }); title = value + ' Radio'; }
    else if (type === 'language')  { if (!value) return res.status(400).json({ error: 'Provide a language as value.' });  stations = await rbGet('/json/stations/search', { language: value, limit: 50, order: 'clickcount', reverse: true, hidebroken: true }); title = value + ' Radio'; }
    else if (type === 'tag')       { if (!value) return res.status(400).json({ error: 'Provide a tag as value.' });       stations = await rbGet('/json/stations/search', { tagList: value, limit: 50, order: 'clickcount', reverse: true, hidebroken: true }); title = value + ' Radio'; }
    else if (type === 'search')    { if (!value) return res.status(400).json({ error: 'Provide a search term as value.' }); stations = await rbGet('/json/stations/search', { name: value, limit: 50, order: 'clickcount', reverse: true, hidebroken: true }); title = value + ' Stations'; }
    else return res.status(400).json({ error: 'Unknown type. Use: country, language, tag, trending, topvoted, topclicks, search.' });

    if (!stations.length) return res.status(404).json({ error: 'No stations found.' });
    res.json({ title, tracks: stations.map(mapStation) });
  } catch (e) {
    res.status(500).json({ error: 'Import failed.' });
  }
});

/* ── Health ─────────────────────────────────────────────────────── */
app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '1.0.2', redisConnected: !!(redis && redis.status === 'ready'), activeTokens: TOKEN_CACHE.size, searchCache: SEARCH_CACHE.size, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log('Eclipse Radio Addon v1.0.2 on port ' + PORT));
