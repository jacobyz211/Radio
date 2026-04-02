// ============================================================
// index.js — Eclipse Radio Addon v1.0.3
// Sources: Radio Browser + SomaFM + TuneIn
//
// Stream ID prefixes:
//   rbst{uuid}    — Radio Browser  (streamURL in search result — RB URLs are stable)
//   soma_{id}     — SomaFM         (NO streamURL in search — Eclipse calls /stream to get format+URL)
//   tunein_{guid} — TuneIn         (NO streamURL in search — resolved fresh via Tune.ashx at play time)
// ============================================================

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// ── Redis ──────────────────────────────────────────────────
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

// ── In-memory stores ───────────────────────────────────────
const TOKEN_CACHE      = new Map();
const IP_CREATES       = new Map();
const STATION_CACHE    = new Map();
const SEARCH_CACHE     = new Map();
const PLAYLIST_CACHE   = new Map();
const TUNEIN_META      = new Map();
const SOMA_CACHE       = { channels: null, ts: 0 };

// ── Constants ─────────────────────────────────────────────
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 90;
const RATE_WINDOW_MS    = 60_000;
const SEARCH_TTL_MS     = 5 * 60 * 1000;
const SOMA_TTL_MS       = 10 * 60 * 1000;
const UA                = 'EclipseRadioAddon/1.0.3';
const RB_BASE           = process.env.RADIO_BROWSER_BASE || 'https://de1.api.radio-browser.info';
const TUNEIN_BASE       = 'https://opml.radiotime.com';
const FALLBACK_ART      = 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png';

// ── Utility ────────────────────────────────────────────────
function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function cleanText(s)    { return String(s || '').replace(/\s+/g, ' ').trim(); }
function safeUrl(u)      { return /^https?:\/\//i.test(String(u || '')) ? String(u) : null; }
function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }

function normaliseFormat(f) {
  // Eclipse only accepts: mp3, aac, m4a, flac, wav, ogg, hls
  const s = String(f || '').toLowerCase();
  if (s === 'mp3')                    return 'mp3';
  if (s === 'aac' || s === 'aacp' || s === 'mp3aacp' || s === 'aac+') return 'aac';
  if (s === 'm4a')                    return 'm4a';
  if (s === 'flac')                   return 'flac';
  if (s === 'ogg' || s === 'opus')    return 'ogg';
  if (s === 'hls' || s === 'm3u8')    return 'hls';
  return 'mp3'; // safe default
}

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86_400_000 }; IP_CREATES.set(ip, b); }
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
  entry.rateWin = entry.rateWin.filter(t => now - t < RATE_WINDOW_MS);
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

// ══════════════════════════════════════════════════════════
// RADIO BROWSER
// ══════════════════════════════════════════════════════════

async function rbGet(path, params) {
  try {
    const r = await axios.get(RB_BASE + path, { params, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 15000 });
    return r.data;
  } catch (e) { console.warn('[RB]', path, e.message); return null; }
}

function detectFormat(url, hls) {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (hls === 1 || u.endsWith('.m3u8'))             return 'hls';
  if (u.endsWith('.aac') || u.endsWith('.aacp'))    return 'aac';
  if (u.endsWith('.ogg') || u.endsWith('.opus'))    return 'ogg';
  if (u.endsWith('.flac'))                          return 'flac';
  return 'mp3';
}
function stationArtwork(station) {
  return safeUrl(station.favicon) || FALLBACK_ART;
}
function stationSubtitle(station) {
  const bits = [];
  if (station.country)  bits.push(cleanText(station.country));
  if (station.language) bits.push(cleanText(station.language));
  if (station.codec)    bits.push(cleanText(station.codec));
  if (station.bitrate)  bits.push(station.bitrate + 'k');
  return bits.join(' • ');
}
function mapStationToTrack(station) {
  const id     = 'rbst' + station.stationuuid;
  const stream = safeUrl(station.url_resolved || station.urlresolved || station.url);
  const obj    = {
    id, title: cleanText(station.name) || 'Radio Station',
    artist: stationSubtitle(station) || 'Radio Browser',
    album: cleanText(station.tags || station.country || 'Live Radio'),
    duration: null, artworkURL: stationArtwork(station),
    streamURL: stream, format: detectFormat(stream, station.hls)
  };
  STATION_CACHE.set(id, station);
  return obj;
}
function mapStationToAlbum(station) {
  const id = 'rbst' + station.stationuuid;
  STATION_CACHE.set(id, station);
  return { id, title: cleanText(station.name) || 'Radio Station', artist: cleanText(station.country || station.language || 'Radio Browser'), artworkURL: stationArtwork(station), trackCount: 1, year: null };
}
function mapCountryToPlaylist(c)  { return { id: 'rbcountry' + encodeURIComponent(c.name), title: cleanText(c.name) + ' Radio', creator: 'Radio Browser', artworkURL: null, trackCount: parseInt(c.stationcount || 0, 10) || null }; }
function mapLanguageToPlaylist(l) { return { id: 'rblang'   + encodeURIComponent(l.name), title: cleanText(l.name)    + ' Radio', creator: 'Radio Browser', artworkURL: null, trackCount: parseInt(l.stationcount || 0, 10) || null }; }
function mapTagToPlaylist(t)      { return { id: 'rbtag'    + encodeURIComponent(t.name), title: cleanText(t.name)    + ' Radio', creator: 'Radio Browser', artworkURL: null, trackCount: parseInt(t.stationcount || 0, 10) || null }; }

function scoreStation(station, q) {
  const needle = cleanText(q).toLowerCase();
  const hay    = [station.name, station.tags, station.country, station.language].map(x => cleanText(x).toLowerCase()).join(' ');
  let score = 0;
  if (cleanText(station.name).toLowerCase() === needle)          score += 200;
  if (cleanText(station.name).toLowerCase().startsWith(needle)) score += 90;
  if (hay.includes(needle))                                      score += 40;
  if (station.lastcheckok === 1)                                 score += 50;
  score += Math.min(parseInt(station.clickcount || 0, 10), 50);
  score += Math.min(parseInt(station.votes      || 0, 10), 50);
  if (parseInt(station.bitrate || 0, 10) >= 128)                score += 15;
  if (!safeUrl(station.url_resolved || station.urlresolved || station.url)) score -= 200;
  return score;
}

function isFrequency(q) { return /^\d{2,3}(\.\d{1,2})?$/.test(q.trim()); }

async function searchStations(q) {
  const key    = cleanText(q).toLowerCase();
  const cached = SEARCH_CACHE.get(key);
  if (cached && Date.now() - cached.ts < SEARCH_TTL_MS) return cached.data;

  const freq = isFrequency(q);

  const [stations, tags, countries, languages, usStations] = await Promise.all([
    rbGet('/json/stations/search', { name: q, limit: 40, hidebroken: true, order: 'clickcount', reverse: true }),
    rbGet('/json/tags/'      + encodeURIComponent(q.toLowerCase()), { order: 'stationcount', reverse: true, limit: 8, hidebroken: true }),
    rbGet('/json/countries/' + encodeURIComponent(q),               { order: 'stationcount', reverse: true, limit: 8, hidebroken: true }),
    rbGet('/json/languages/' + encodeURIComponent(q),               { order: 'stationcount', reverse: true, limit: 8, hidebroken: true }),
    rbGet('/json/stations/search', { name: q, countrycode: 'US', limit: 20, hidebroken: true, order: 'clickcount', reverse: true })
  ]);

  let allStations = Array.isArray(stations) ? [...stations] : [];
  if (Array.isArray(usStations)) {
    const seen = new Set(allStations.map(s => s.stationuuid));
    for (const s of usStations) { if (!seen.has(s.stationuuid)) { allStations.push(s); seen.add(s.stationuuid); } }
  }

  if (Array.isArray(tags) && tags.length && allStations.length < 15) {
    const tagRows = await rbGet('/json/stations/bytagexact/' + encodeURIComponent(q.toLowerCase()), { hidebroken: true, order: 'clickcount', reverse: true, limit: 25 });
    if (Array.isArray(tagRows)) {
      const seen = new Set(allStations.map(s => s.stationuuid));
      tagRows.forEach(s => { if (!seen.has(s.stationuuid)) allStations.push(s); });
    }
  }
  if (Array.isArray(languages) && languages.length && allStations.length < 15) {
    const langRows = await rbGet('/json/stations/bylanguageexact/' + encodeURIComponent(q.toLowerCase()), { hidebroken: true, order: 'clickcount', reverse: true, limit: 25 });
    if (Array.isArray(langRows)) {
      const seen = new Set(allStations.map(s => s.stationuuid));
      langRows.forEach(s => { if (!seen.has(s.stationuuid)) allStations.push(s); });
    }
  }

  const rankedStations = allStations
    .filter(s => safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1)
    .sort((a, b) => {
      let sa = scoreStation(a, q), sb = scoreStation(b, q);
      if (freq) { if (a.countrycode === 'US') sa += 60; if (b.countrycode === 'US') sb += 60; }
      return sb - sa;
    })
    .slice(0, 20);

  const data = { stations: rankedStations, tags: Array.isArray(tags) ? tags.slice(0, 6) : [], countries: Array.isArray(countries) ? countries.slice(0, 6) : [], languages: Array.isArray(languages) ? languages.slice(0, 6) : [] };
  SEARCH_CACHE.set(key, { ts: Date.now(), data });
  return data;
}

async function stationByUuid(uuid) {
  const cached = STATION_CACHE.get('rbst' + uuid);
  if (cached) return cached;
  const rows    = await rbGet('/json/stations/byuuid/' + encodeURIComponent(uuid), { hidebroken: true });
  const station = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (station) STATION_CACHE.set('rbst' + uuid, station);
  return station;
}

async function loadRbPlaylist(id) {
  if (PLAYLIST_CACHE.has(id)) return PLAYLIST_CACHE.get(id);
  let rows, title = 'Radio Playlist', description = 'Live stations';

  if (id.startsWith('rbcountry')) {
    const country = decodeURIComponent(id.replace('rbcountry', ''));
    rows = await rbGet('/json/stations/bycountrycodeexact/' + (country.toLowerCase().includes('united states') ? 'US' : encodeURIComponent(country)), { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    if (!Array.isArray(rows) || !rows.length) rows = await rbGet('/json/stations/bycountryexact/' + encodeURIComponent(country), { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = country + ' Radio'; description = 'Top live stations from ' + country;
  } else if (id.startsWith('rblang')) {
    const language = decodeURIComponent(id.replace('rblang', ''));
    rows = await rbGet('/json/stations/bylanguageexact/' + encodeURIComponent(language), { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = language + ' Radio'; description = 'Top live stations in ' + language;
  } else if (id.startsWith('rbtag')) {
    const tag = decodeURIComponent(id.replace('rbtag', ''));
    rows = await rbGet('/json/stations/bytagexact/' + encodeURIComponent(tag), { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = tag + ' Radio'; description = tag + ' radio stations';
  } else if (id === 'rbtrending') {
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'clicktrend', reverse: true, limit: 50 });
    title = 'Trending Radio'; description = 'Stations trending right now';
  } else if (id === 'rbtopvoted') {
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'votes', reverse: true, limit: 50 });
    title = 'Top Voted Radio'; description = 'Highest voted stations';
  } else if (id === 'rbtopclicks') {
    rows = await rbGet('/json/stations', { hidebroken: true, order: 'clickcount', reverse: true, limit: 50 });
    title = 'Popular Radio'; description = 'Most clicked live stations';
  } else if (id === 'rbus') {
    rows = await rbGet('/json/stations/bycountrycodeexact/US', { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 });
    title = '🇺🇸 United States Radio'; description = 'Top US live radio stations';
  } else { return null; }

  const stations = Array.isArray(rows) ? rows.filter(s => safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1).slice(0, 50) : [];
  const playlist = { id, title, description, artworkURL: stations[0] ? stationArtwork(stations[0]) : null, creator: 'Radio Browser', tracks: stations.map(mapStationToTrack) };
  PLAYLIST_CACHE.set(id, playlist);
  return playlist;
}

// ══════════════════════════════════════════════════════════
// SOMAFM
// ══════════════════════════════════════════════════════════

async function fetchSomaChannels() {
  if (SOMA_CACHE.channels && Date.now() - SOMA_CACHE.ts < SOMA_TTL_MS) return SOMA_CACHE.channels;
  try {
    const r = await axios.get('https://somafm.com/channels.json', { headers: { 'User-Agent': UA }, timeout: 10000 });
    SOMA_CACHE.channels = r.data.channels || [];
    SOMA_CACHE.ts = Date.now();
    console.log('[SomaFM] Loaded', SOMA_CACHE.channels.length, 'channels');
    return SOMA_CACHE.channels;
  } catch (e) { console.warn('[SomaFM] fetch error:', e.message); return SOMA_CACHE.channels || []; }
}

function bestSomaStream(streams) {
  if (!Array.isArray(streams) || !streams.length) return null;
  // Strongly prefer MP3 — it's the most universally supported format
  return streams.find(s => s.format === 'mp3' && s.quality === 'highest')
      || streams.find(s => s.format === 'mp3')
      || streams.find(s => String(s.format || '').toLowerCase().includes('mp3'))
      || streams.find(s => s.format === 'aac'  && s.quality === 'highest')
      || streams.find(s => s.format === 'aac')
      || streams[0] || null;
}

function mapSomaChannel(ch) {
  // NOTE: intentionally NO streamURL here.
  // Eclipse calls /stream/soma_{id} at play time, which returns the URL with
  // explicit format metadata. Embedding streamURL caused instant-skip because
  // Eclipse couldn't verify the ICY stream type without the /stream response.
  return {
    id:        'soma_' + ch.id,
    title:     cleanText(ch.title),
    artist:    'SomaFM • United States',
    album:     cleanText(ch.genre || ch.description || 'Internet Radio'),
    duration:  null,
    artworkURL: safeUrl(ch.xlimage || ch.image) || 'https://somafm.com/img3/logo-400.png',
    format:    'mp3'
  };
}

function searchSoma(q) {
  const channels = SOMA_CACHE.channels || [];
  if (!channels.length) return [];
  const needle = cleanText(q).toLowerCase();
  if (['somafm', 'soma fm', 'soma'].includes(needle)) return channels.map(mapSomaChannel);
  return channels.filter(ch => {
    const hay = [ch.title, ch.genre, ch.description, ch.dj].map(x => cleanText(x).toLowerCase()).join(' ');
    return hay.includes(needle);
  }).map(mapSomaChannel);
}

// ══════════════════════════════════════════════════════════
// TUNEIN
// Stream is resolved fresh at /stream time (Tune.ashx).
// Supports PLS and M3U playlist unwrapping so Eclipse always
// receives a direct stream URL, not a playlist file.
// ══════════════════════════════════════════════════════════

async function parsePls(url) {
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 6000, responseType: 'text' });
    const text = typeof r.data === 'string' ? r.data : String(r.data || '');
    // PLS: File1=http://...
    const m = text.match(/^File\d+=(.+)$/im);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

async function parseM3u(url) {
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 6000, responseType: 'text' });
    const text = typeof r.data === 'string' ? r.data : String(r.data || '');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return lines.find(l => /^https?:\/\//i.test(l)) || null;
  } catch (e) { return null; }
}

async function tuneInSearch(q) {
  try {
    const r = await axios.get(TUNEIN_BASE + '/Search.ashx', {
      params: { query: q, render: 'json', formats: 'mp3,aac' },
      headers: { 'User-Agent': UA }, timeout: 12000
    });
    const body = r.data && r.data.body;
    if (!Array.isArray(body)) return [];
    return body.filter(item => item.type === 'audio' && item.item === 'station' && item.guide_id);
  } catch (e) { console.warn('[TuneIn] search error:', e.message); return []; }
}

async function tuneInResolve(guideId) {
  try {
    const r = await axios.get(TUNEIN_BASE + '/Tune.ashx', {
      // Use formats=mp3 only — more reliable than mp3,aac for direct stream returns
      params: { id: guideId, render: 'json', formats: 'mp3' },
      headers: { 'User-Agent': UA }, timeout: 10000
    });
    const body = r.data && r.data.body;
    if (!Array.isArray(body) || !body.length) return null;

    for (const entry of body) {
      if (!safeUrl(entry.url)) continue;
      const url = entry.url;

      // Unwrap PLS playlist files → extract the real stream URL inside
      if (/\.pls(\?|$)/i.test(url)) {
        const real = await parsePls(url);
        if (real && safeUrl(real)) return { url: real, format: 'mp3', quality: entry.bitrate ? entry.bitrate + 'kbps' : undefined };
        continue;
      }
      // Unwrap M3U/M3U8 playlist files
      if (/\.m3u8?(\?|$)/i.test(url)) {
        if (url.endsWith('.m3u8')) return { url, format: 'hls', quality: undefined }; // HLS is fine directly
        const real = await parseM3u(url);
        if (real && safeUrl(real)) return { url: real, format: 'mp3', quality: undefined };
        continue;
      }
      // Direct stream URL
      return { url, format: normaliseFormat(entry.media_type || 'mp3'), quality: entry.bitrate ? entry.bitrate + 'kbps' : undefined };
    }
    return null;
  } catch (e) { console.warn('[TuneIn] resolve error:', e.message); return null; }
}

function mapTuneInStation(item) {
  TUNEIN_META.set('tunein_' + item.guide_id, item);
  return {
    id:         'tunein_' + item.guide_id,
    title:      cleanText(item.text) || 'Radio Station',
    artist:     cleanText(item.subtext || 'TuneIn Radio'),
    album:      cleanText(item.genre_id || item.subtext || 'Live Radio'),
    duration:   null,
    // Use station image or fall back to generic radio icon — avoids blank/grey squares
    artworkURL: safeUrl(item.image) || FALLBACK_ART,
    format:     normaliseFormat(item.formats ? item.formats.split(',')[0].trim() : 'mp3')
  };
}

// ══════════════════════════════════════════════════════════
// UNIFIED SCORING — sorts merged results across all sources
// ══════════════════════════════════════════════════════════

// Score a single track against the search query.
// Higher = better match. Factors:
//   1. How well the title matches the query (exact > starts with > first-word > anywhere)
//   2. English/US soft preference
//   3. Small boost for SomaFM (curated, always working)
// This replaces the old hard-order (SomaFM then TuneIn then RB).
// Example: searching "bbc" → "BBC World Service" (starts with) beats "24/7 BBC" (anywhere)
function scoreTrackForQuery(track, q) {
  const needle = q.toLowerCase().trim();
  const title  = (track.title || '').toLowerCase();
  const meta   = ((track.artist || '') + ' ' + (track.album || '')).toLowerCase();
  let score = 0;

  if (title === needle)                              score += 300; // exact
  else if (title.startsWith(needle + ' ') || title === needle) score += 0; // already hit above
  else if (title.startsWith(needle))                score += 160; // "BBC Radio 1" for "bbc"
  else if (title.split(/\s+/)[0] === needle)        score += 140; // first word exact
  else if (title.includes(' ' + needle + ' '))      score += 80;  // inner word match
  else if (title.includes(needle))                  score += 50;  // anywhere in title ("24/7 BBC")
  else if (meta.includes(needle))                   score += 20;  // in artist/genre only

  // Soft English/US preference
  if (/\benglish\b/.test(meta))                     score += 30;
  if (/united states|somafm|\busa\b|\bus\b/.test(meta)) score += 20;

  // SomaFM reliability boost (curated, always live)
  if (track.id.startsWith('soma_'))                 score += 15;

  return score;
}

// ══════════════════════════════════════════════════════════
// COMBINED SEARCH — merges all three sources
// ══════════════════════════════════════════════════════════

const US_QUERY_TERMS = new Set(['us', 'usa', 'united states', 'america', 'american', 'united states of america']);

async function combinedSearch(q) {
  const qLow = cleanText(q).toLowerCase();

  const [rbData, _warm, tuneInItems] = await Promise.all([
    searchStations(q),
    fetchSomaChannels(),
    tuneInSearch(q)
  ]);

  const somaTracks   = searchSoma(q);
  const rbTracks     = rbData.stations.map(mapStationToTrack);
  const tuneInTracks = tuneInItems.map(mapTuneInStation);

  // Merge all sources, deduplicate by normalised title
  const seen   = new Set();
  const merged = [];
  for (const track of [...somaTracks, ...tuneInTracks, ...rbTracks]) {
    if (!track.title || track.title === 'Radio Station') continue; // skip blank titles
    const key = track.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(key)) { seen.add(key); merged.push(track); }
  }

  // Sort by relevance score — best match first regardless of source
  merged.sort((a, b) => scoreTrackForQuery(b, q) - scoreTrackForQuery(a, q));

  // Playlists
  const rbPlaylists = [
    ...rbData.countries.map(mapCountryToPlaylist),
    ...rbData.languages.map(mapLanguageToPlaylist),
    ...rbData.tags.map(mapTagToPlaylist)
  ];
  if (US_QUERY_TERMS.has(qLow)) rbPlaylists.unshift({ id: 'rbus', title: '🇺🇸 United States Radio', creator: 'Radio Browser', artworkURL: null, trackCount: null });

  const somaPlaylist = { id: 'somaall', title: 'SomaFM — All Channels', creator: 'SomaFM', artworkURL: 'https://somafm.com/img3/logo-400.png', trackCount: (SOMA_CACHE.channels || []).length || 30 };

  return {
    tracks:    merged.slice(0, 30),
    playlists: [somaPlaylist, ...rbPlaylists].slice(0, 15)
  };
}

// ══════════════════════════════════════════════════════════
// PLAYLIST LOADER
// ══════════════════════════════════════════════════════════

async function loadPlaylist(id) {
  if (id === 'somaall') {
    if (PLAYLIST_CACHE.has('somaall')) return PLAYLIST_CACHE.get('somaall');
    const channels = await fetchSomaChannels();
    const playlist  = { id: 'somaall', title: 'SomaFM — All Channels', description: '30+ curated US internet radio channels', artworkURL: 'https://somafm.com/img3/logo-400.png', creator: 'SomaFM', tracks: channels.map(mapSomaChannel) };
    PLAYLIST_CACHE.set('somaall', playlist);
    return playlist;
  }
  return loadRbPlaylist(id);
}

// ══════════════════════════════════════════════════════════
// CONFIG PAGE
// ══════════════════════════════════════════════════════════

function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>Radio for Eclipse</title>';
  h += '<style>';
  h += '*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0a0b10;color:#e7ebf3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.logo-wrap{display:flex;align-items:center;gap:14px;margin-bottom:28px}.logo-text{font-size:26px;font-weight:800;color:#56a7ff;letter-spacing:-.02em}.logo-sub{font-size:13px;color:#55657e;margin-top:3px}';
  h += '.card{background:#121722;border:1px solid #1d2636;border-radius:18px;padding:36px;max-width:560px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:20px}';
  h += 'h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}p.sub{font-size:14px;color:#91a0b9;margin-bottom:20px;line-height:1.6}';
  h += '.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}.stat{background:#0d1119;border:1px solid #1a2130;border-radius:10px;padding:14px;text-align:center}.stat-n{font-size:22px;font-weight:800;color:#56a7ff}.stat-l{font-size:11px;color:#667791;margin-top:3px}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#111a29;color:#56a7ff;border:1px solid #22324b}.pill.g{background:#111d15;color:#6ec77b;border-color:#26432c}.pill.o{background:#1d1508;color:#f5a623;border-color:#3d2e0e}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6d7a91;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0c1018;border:1px solid #1e2634;border-radius:10px;color:#e7ebf3;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}input:focus{border-color:#56a7ff}input::placeholder{color:#425066}';
  h += '.hint{font-size:12px;color:#73829b;margin-bottom:12px;line-height:1.7}.hint code{background:#111826;padding:1px 5px;border-radius:4px;color:#7db8ff}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}.bo{background:#56a7ff;color:#07101e}.bo:hover{background:#7db8ff}.bo:disabled{background:#2a3547;color:#70809b;cursor:not-allowed}.bg{background:#15301b;color:#e7ebf3;border:1px solid #2c5a36}.bg:hover{background:#1a3d23}.bg:disabled{background:#1a1a14;color:#444;cursor:not-allowed}.bd{background:#171d28;color:#aab4c5;border:1px solid #283244;font-size:13px;padding:10px}.bd:hover{background:#1e2634;color:#fff}';
  h += '.box{display:none;background:#0c1018;border:1px solid #1e2634;border-radius:12px;padding:18px;margin-bottom:14px}.blbl{font-size:10px;color:#6b7993;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}.burl{font-size:12px;color:#7db8ff;word-break:break-all;font-family:SF Mono,ui-monospace,monospace;margin-bottom:14px;line-height:1.5}';
  h += 'hr{border:none;border-top:1px solid #1a2230;margin:24px 0}.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}.sn{background:#141b28;border:1px solid #263045;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#8ca0bf}.st{font-size:13px;color:#9aa8bf;line-height:1.6}.st b{color:#d7e1f1}';
  h += '.warn{background:#101726;border:1px solid #22324b;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#7fa9d9;line-height:1.7}';
  h += '.status{font-size:13px;color:#7a8aa5;margin:8px 0;min-height:18px}.status.ok{color:#6ec77b}.status.err{color:#d96b6b}.status.spin{color:#7db8ff}';
  h += '.preview{background:#0c1018;border:1px solid #1a2230;border-radius:10px;padding:12px;max-height:240px;overflow-y:auto;margin-bottom:12px;display:none}.tr{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #151c29;font-size:13px}.tr:last-child{border-bottom:none}.tn{color:#4d5d78;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}.tt{color:#e7ebf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#7e8ca3;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  h += 'footer{margin-top:32px;font-size:12px;color:#4e5c75;text-align:center;line-height:1.8}footer a{color:#4e5c75;text-decoration:none}';
  h += '</style></head><body>';

  h += '<div class="logo-wrap">';
  h += '<svg width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#13233b"></circle><path d="M18 33c3-8 13-8 16 0" stroke="#56a7ff" stroke-width="3" stroke-linecap="round"></path><path d="M14 27c5-13 19-13 24 0" stroke="#56a7ff" stroke-width="3" stroke-linecap="round" opacity=".7"></path><circle cx="26" cy="36" r="2.5" fill="#56a7ff"></circle></svg>';
  h += '<div><div class="logo-text">Radio</div><div class="logo-sub">for Eclipse Music · v1.0.3</div></div>';
  h += '</div>';

  h += '<div class="card">';
  h += '<div class="stat-grid">';
  h += '<div class="stat"><div class="stat-n">3</div><div class="stat-l">Sources</div></div>';
  h += '<div class="stat"><div class="stat-n">30k+</div><div class="stat-l">Stations</div></div>';
  h += '<div class="stat"><div class="stat-n">Free</div><div class="stat-l">No API Key</div></div>';
  h += '</div>';
  h += '<p class="sub">Live radio from Radio Browser, SomaFM, and TuneIn. Search by station name, frequency, genre, country, or language. Best matches always shown first.</p>';
  h += '<div class="pills"><span class="pill">Radio Browser</span><span class="pill o">SomaFM</span><span class="pill o">TuneIn</span><span class="pill">US Stations</span><span class="pill">Genres</span><span class="pill g">No signup</span><span class="pill g">Direct streams</span></div>';

  h += '<button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div>';
  h += '<div class="status" id="genStatus"></div>';
  h += '<hr>';

  h += '<div class="lbl">Restore an existing URL</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
  h += '<button class="bg" id="refBtn" onclick="doRefresh()">Restore Existing URL</button>';
  h += '<div class="box" id="refBox"><div class="blbl">Restored — still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';
  h += '<hr>';

  h += '<div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Click <b>Generate My Addon URL</b></div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Copy your URL</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Open <b>Eclipse</b> \u2192 Settings \u2192 Connections \u2192 Add Connection \u2192 Addon</div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Paste your URL and tap <b>Install</b></div></div>';
  h += '</div>';
  h += '<div class="warn">Your token is saved to Redis \u2014 it survives server restarts. Each person should generate their own URL.</div>';
  h += '</div>';

  h += '<div class="card">';
  h += '<h2>Import Stations to Eclipse Library</h2>';
  h += '<p class="sub">Downloads a CSV for Library \u2192 Import CSV in Eclipse.</p>';
  h += '<div class="lbl">Your Addon URL</div>';
  h += '<input type="text" id="impToken" placeholder="Paste your addon URL \u2014 auto-fills after generating">';
  h += '<div class="lbl">Import type</div>';
  h += '<input type="text" id="impType" placeholder="country, language, tag, trending, topvoted, topclicks, search, or somafm">';
  h += '<div class="lbl">Value</div>';
  h += '<input type="text" id="impValue" placeholder="Example: United States, english, jazz — leave blank for somafm or trending">';
  h += '<div class="hint">Examples: <code>country</code> + <code>United States</code>, <code>language</code> + <code>english</code>, <code>tag</code> + <code>jazz</code>, <code>search</code> + <code>lofi</code>, <code>somafm</code> with blank value.</div>';
  h += '<div class="status" id="impStatus"></div>';
  h += '<div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button>';
  h += '</div>';

  h += '<footer>Eclipse Radio Addon v1.0.3 &bull; <a href="https://www.radio-browser.info" target="_blank" rel="noopener noreferrer">Radio Browser</a> &bull; <a href="https://somafm.com" target="_blank" rel="noopener noreferrer">SomaFM</a> &bull; <a href="https://tunein.com" target="_blank" rel="noopener noreferrer">TuneIn</a> &bull; <a href="' + baseUrl + '/health" target="_blank" rel="noopener noreferrer">Health</a></footer>';

  h += '<script>';
  h += 'var gu="",ru="";';
  h += 'function getTok(s){var m=String(s||"").match(/\\/u\\/([a-f0-9]{28})\\//i);return m?m[1]:null;}';
  h += 'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}';

  h += 'function generate(){';
  h += 'var btn=document.getElementById("genBtn"),st=document.getElementById("genStatus");';
  h += 'btn.disabled=true;btn.textContent="Generating...";st.className="status spin";st.textContent="Creating your token\u2026";';
  h += 'fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})';
  h += '.then(function(r){return r.json();}).then(function(d){';
  h += 'if(d.error){st.className="status err";st.textContent=d.error;btn.disabled=false;btn.textContent="Generate My Addon URL";return;}';
  h += 'gu=d.manifestUrl;document.getElementById("genUrl").textContent=gu;document.getElementById("genBox").style.display="block";document.getElementById("impToken").value=gu;';
  h += 'st.className="status ok";st.textContent="\u2713 Your addon URL is ready";btn.disabled=false;btn.textContent="Generate My Addon URL";';
  h += '}).catch(function(e){st.className="status err";st.textContent="Network error";btn.disabled=false;btn.textContent="Generate My Addon URL";});';
  h += '}';
  h += 'function copyUrl(){navigator.clipboard.writeText(gu).then(function(){var b=document.getElementById("copyBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},2000);});}';
  h += 'function doRefresh(){';
  h += 'var raw=document.getElementById("existingUrl").value.trim(),btn=document.getElementById("refBtn"),st=document.getElementById("genStatus");';
  h += 'if(!raw)return;btn.disabled=true;btn.textContent="Restoring...";';
  h += 'fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:raw})})';
  h += '.then(function(r){return r.json();}).then(function(d){';
  h += 'if(d.error){st.className="status err";st.textContent=d.error;btn.disabled=false;btn.textContent="Restore Existing URL";return;}';
  h += 'ru=d.manifestUrl;document.getElementById("refUrl").textContent=ru;document.getElementById("refBox").style.display="block";document.getElementById("impToken").value=ru;';
  h += 'st.className="status ok";st.textContent="\u2713 URL restored";btn.disabled=false;btn.textContent="Restore Existing URL";';
  h += '}).catch(function(){btn.disabled=false;btn.textContent="Restore Existing URL";});';
  h += '}';
  h += 'function copyRef(){navigator.clipboard.writeText(ru).then(function(){var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},2000);});}';
  h += 'function doImport(){';
  h += 'var addonUrl=document.getElementById("impToken").value.trim();';
  h += 'var type=document.getElementById("impType").value.trim().toLowerCase();';
  h += 'var value=document.getElementById("impValue").value.trim();';
  h += 'var st=document.getElementById("impStatus"),prev=document.getElementById("impPreview"),btn=document.getElementById("impBtn");';
  h += 'if(!addonUrl||!type){st.className="status err";st.textContent="Fill in addon URL and type.";return;}';
  h += 'var tok=getTok(addonUrl);if(!tok){st.className="status err";st.textContent="Paste your full addon URL.";return;}';
  h += 'st.className="status spin";st.textContent="Fetching stations\u2026";btn.disabled=true;prev.style.display="none";prev.innerHTML="";';
  h += 'var url="/u/"+tok+"/import?type="+encodeURIComponent(type)+"&value="+encodeURIComponent(value);';
  h += 'fetch(url).then(function(r){return r.json();}).then(function(d){';
  h += 'if(d.error){st.className="status err";st.textContent=d.error;btn.disabled=false;return;}';
  h += 'var tracks=d.tracks||[];st.className="status ok";st.textContent="\u2713 "+tracks.length+" stations fetched";';
  h += 'if(tracks.length){prev.style.display="block";var inner="";tracks.slice(0,20).forEach(function(t,i){inner+="<div class=\\"tr\\"><div class=\\"tn\\">"+(i+1)+"</div><div class=\\"ti\\"><div class=\\"tt\\">"+hesc(t.title)+"</div><div class=\\"ta\\">"+hesc(t.artist)+"</div></div></div>";});prev.innerHTML=inner;}';
  h += 'var csv="title,artist,album,streamURL\\n"+tracks.map(function(t){return [t.title,t.artist,t.album||"",t.streamURL||""].map(function(v){return "\\""+String(v||"").replace(/"/g,"\\"\\"")+"\\""}).join(",");}).join("\\n");';
  h += 'var blob=new Blob([csv],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(d.title||type).replace(/[^a-z0-9]+/gi,"-")+".csv";a.click();btn.disabled=false;';
  h += '}).catch(function(e){st.className="status err";st.textContent="Fetch failed: "+e.message;btn.disabled=false;});';
  h += '}';
  h += '<\/script></body></html>';
  return h;
}

// ══════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════

app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  const ip     = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  const token  = generateToken();
  const entry  = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async function(req, res) {
  const raw   = String((req.body && req.body.existingUrl) || '').trim();
  const m     = raw.match(/\/u\/([a-f0-9]{28})\//i);
  const token = m ? m[1] : (/^[a-f0-9]{28}$/i.test(raw) ? raw : null);
  if (!token) return res.status(400).json({ error: 'Paste your full addon URL.' });
  const entry = await getTokenEntry(token);
  if (!entry)  return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

// ── Manifest ──────────────────────────────────────────────
app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id: 'com.eclipse.radio.' + req.params.token.slice(0, 8),
    name: 'Radio',
    version: '1.0.3',
    description: 'Live radio from Radio Browser, SomaFM & TuneIn. Search by name, frequency, genre, country, or language.',
    icon: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist']
  });
});

// ── Search ────────────────────────────────────────────────
app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  const q = cleanText(req.query.q);

  if (!q) {
    fetchSomaChannels().catch(() => {});
    return res.json({
      tracks: [], albums: [], artists: [],
      playlists: [
        { id: 'somaall',     title: 'SomaFM — All Channels',  creator: 'SomaFM',       artworkURL: 'https://somafm.com/img3/logo-400.png', trackCount: 30  },
        { id: 'rbus',        title: '🇺🇸 United States Radio', creator: 'Radio Browser', artworkURL: null, trackCount: 100 },
        { id: 'rbtrending',  title: 'Trending Radio',          creator: 'Radio Browser', artworkURL: null, trackCount: 50  },
        { id: 'rbtopclicks', title: 'Popular Radio',           creator: 'Radio Browser', artworkURL: null, trackCount: 50  },
        { id: 'rbtopvoted',  title: 'Top Voted Radio',         creator: 'Radio Browser', artworkURL: null, trackCount: 50  }
      ]
    });
  }

  try {
    const data   = await combinedSearch(q);
    const rbData = await searchStations(q);
    const albums = rbData.stations.slice(0, 12).map(mapStationToAlbum);
    const artistMap = new Map();
    rbData.stations.forEach(s => {
      const country = cleanText(s.country || 'Unknown Country');
      const key = country.toLowerCase();
      if (!artistMap.has(key)) artistMap.set(key, { id: 'rbartist' + encodeURIComponent(country), name: country, artworkURL: stationArtwork(s), genres: [cleanText(s.language), cleanText(s.tags)].filter(Boolean).slice(0, 2) });
    });
    res.json({ tracks: data.tracks, albums, artists: Array.from(artistMap.values()).slice(0, 6), playlists: data.playlists });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'Search failed.', tracks: [], albums: [], artists: [], playlists: [] });
  }
});

// ── Stream ────────────────────────────────────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async function(req, res) {
  const id = req.params.id;

  // ── Radio Browser ──────────────────────────────────────
  if (id.startsWith('rbst')) {
    const cached = STATION_CACHE.get(id);
    if (cached) {
      const url = safeUrl(cached.url_resolved || cached.urlresolved || cached.url);
      if (url) { rbGet('/json/url/' + encodeURIComponent(cached.stationuuid), {}).catch(() => {}); return res.json({ url, format: detectFormat(url, cached.hls) }); }
    }
    const station = await stationByUuid(id.replace(/^rbst/, ''));
    if (station) {
      const url = safeUrl(station.url_resolved || station.urlresolved || station.url);
      if (url) { rbGet('/json/url/' + encodeURIComponent(station.stationuuid), {}).catch(() => {}); return res.json({ url, format: detectFormat(url, station.hls) }); }
    }
    return res.status(404).json({ error: 'Stream not found', id });
  }

  // ── SomaFM ─────────────────────────────────────────────
  // Always resolve here — gives Eclipse explicit format info so it doesn't skip
  if (id.startsWith('soma_')) {
    const channelId = id.replace('soma_', '');
    const channels  = await fetchSomaChannels();
    const ch        = channels.find(c => c.id === channelId);
    if (!ch) return res.status(404).json({ error: 'SomaFM channel not found.' });
    const best = bestSomaStream(ch.streams);
    if (!best || !safeUrl(best.url)) return res.status(404).json({ error: 'No stream URL for this SomaFM channel.' });
    return res.json({ url: best.url, format: normaliseFormat(best.format), quality: 'highest' });
  }

  // ── TuneIn ─────────────────────────────────────────────
  // Resolve fresh at play time — Tune.ashx handles PLS/M3U unwrapping
  if (id.startsWith('tunein_')) {
    const guideId = id.replace('tunein_', '');
    const stream  = await tuneInResolve(guideId);
    if (!stream || !safeUrl(stream.url)) return res.status(404).json({ error: 'TuneIn stream could not be resolved. The station may be offline.' });
    return res.json(stream);
  }

  return res.status(404).json({ error: 'Unknown stream ID prefix.', id });
});

// ── Album ─────────────────────────────────────────────────
app.get('/u/:token/album/:id', tokenMiddleware, async function(req, res) {
  const id = req.params.id;
  if (id.startsWith('soma_')) {
    const channels = await fetchSomaChannels();
    const ch = channels.find(c => c.id === id.replace('soma_', ''));
    if (!ch) return res.status(404).json({ error: 'SomaFM channel not found.' });
    return res.json({ id, title: cleanText(ch.title), artist: 'SomaFM', artworkURL: safeUrl(ch.xlimage || ch.image) || 'https://somafm.com/img3/logo-400.png', year: null, description: cleanText(ch.description), trackCount: 1, tracks: [mapSomaChannel(ch)] });
  }
  const uuid    = id.replace(/^rbst/, '');
  const station = await stationByUuid(uuid);
  if (!station) return res.status(404).json({ error: 'Station not found.' });
  res.json({ id, title: cleanText(station.name || 'Radio Station'), artist: cleanText(station.country || station.language || 'Radio Browser'), artworkURL: stationArtwork(station), year: null, description: stationSubtitle(station), trackCount: 1, tracks: [mapStationToTrack(station)] });
});

// ── Artist ────────────────────────────────────────────────
app.get('/u/:token/artist/:id', tokenMiddleware, async function(req, res) {
  const country = decodeURIComponent(req.params.id.replace(/^rbartist/, ''));
  try {
    const rows     = await rbGet('/json/stations/bycountryexact/' + encodeURIComponent(country), { hidebroken: true, order: 'clickcount', reverse: true, limit: 30 });
    const stations = Array.isArray(rows) ? rows.filter(s => safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1) : [];
    res.json({ id: req.params.id, name: country, artworkURL: stations[0] ? stationArtwork(stations[0]) : null, bio: 'Live radio stations from ' + country, genres: Array.from(new Set(stations.flatMap(s => cleanText(s.language).split(',').map(x => cleanText(x))).filter(Boolean))).slice(0, 3), topTracks: stations.slice(0, 8).map(mapStationToTrack), albums: stations.slice(0, 12).map(mapStationToAlbum) });
  } catch (e) { res.status(500).json({ error: 'Country fetch failed.' }); }
});

// ── Playlist ──────────────────────────────────────────────
app.get('/u/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  try {
    const data = await loadPlaylist(req.params.id);
    if (!data || !Array.isArray(data.tracks) || !data.tracks.length) return res.status(404).json({ error: 'Playlist not found.' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'Playlist fetch failed.' }); }
});

// ── Import (CSV download) ─────────────────────────────────
app.get('/u/:token/import', tokenMiddleware, async function(req, res) {
  const type  = cleanText(req.query.type).toLowerCase();
  const value = cleanText(req.query.value);
  if (!type) return res.status(400).json({ error: 'Pass ?type=country|language|tag|trending|topvoted|topclicks|search|somafm' });

  if (type === 'somafm') {
    const channels = await fetchSomaChannels();
    return res.json({ title: 'SomaFM Radio', tracks: channels.map(mapSomaChannel) });
  }

  let title = 'Radio Import', rows = [];
  if      (type === 'country')   { title = value + ' Radio';    rows = await rbGet('/json/stations/bycountrycodeexact/' + (value.toLowerCase().includes('united states') ? 'US' : encodeURIComponent(value)), { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 }); if (!Array.isArray(rows) || !rows.length) rows = await rbGet('/json/stations/bycountryexact/' + encodeURIComponent(value), { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 }); }
  else if (type === 'language')  { title = value + ' Radio';    rows = await rbGet('/json/stations/bylanguageexact/' + encodeURIComponent(value), { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 }); }
  else if (type === 'tag')       { title = value + ' Radio';    rows = await rbGet('/json/stations/bytagexact/'     + encodeURIComponent(value), { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 }); }
  else if (type === 'trending')  { title = 'Trending Radio';    rows = await rbGet('/json/stations', { hidebroken: true, order: 'clicktrend', reverse: true, limit: 100 }); }
  else if (type === 'topvoted')  { title = 'Top Voted Radio';   rows = await rbGet('/json/stations', { hidebroken: true, order: 'votes',      reverse: true, limit: 100 }); }
  else if (type === 'topclicks') { title = 'Popular Radio';     rows = await rbGet('/json/stations', { hidebroken: true, order: 'clickcount', reverse: true, limit: 100 }); }
  else if (type === 'search')    { title = value + ' Search Radio'; const d = await searchStations(value); rows = d.stations; }
  else return res.status(400).json({ error: 'Unsupported import type.' });

  const tracks = Array.isArray(rows) ? rows.filter(s => safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1).slice(0, 100).map(mapStationToTrack) : [];
  res.json({ title, tracks });
});

// ── Health ────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status: 'ok', version: '1.0.3',
    sources: ['radio-browser', 'somafm', 'tunein'],
    radioBrowserBase: RB_BASE,
    redisConnected: !!(redis && redis.status === 'ready'),
    somaChannelsCached: !!(SOMA_CACHE.channels && SOMA_CACHE.channels.length),
    activeTokens:   TOKEN_CACHE.size,
    cachedStations: STATION_CACHE.size,
    cachedSearches: SEARCH_CACHE.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => { console.log('Eclipse Radio Addon v1.0.3 on port ' + PORT); });
