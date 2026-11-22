// Núcleo do Sintonia: coleta no kworb.net, histórico e estatísticas por período.
// Usado pelo scripts/collect.js (GitHub Actions ou local).
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');            // dados brutos (histórico)
const HIST = path.join(DATA, 'history');
const OUT = path.join(ROOT, 'site', 'data');     // dados publicados para o app
const ARTISTS_FILE = path.join(DATA, 'artists.json');
const COVERS_FILE = path.join(DATA, 'covers.json');
fs.mkdirSync(HIST, { recursive: true });
fs.mkdirSync(path.join(OUT, 'artists'), { recursive: true });

const UA = { 'User-Agent': 'Mozilla/5.0 (Sintonia stream tracker; uso pessoal)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const num = s => { const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; };
const decode = s => s.replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const validId = id => /^[A-Za-z0-9]{22}$/.test(id);

async function fetchText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.text();
}

/* ---------------- artistas acompanhados ---------------- */
const listTracked = () => readJSON(ARTISTS_FILE, []);
const saveTracked = list => writeJSON(ARTISTS_FILE, list);

/* ---------------- parse do kworb ---------------- */
function parseRows(html, kind) {
  const re = new RegExp(`<tr><td class="text"><div>([*^] )?<a href="https://open\\.spotify\\.com/${kind}/([A-Za-z0-9]{22})"[^>]*>(.*?)</a></div></td><td>([^<]*)</td><td>([^<]*)</td></tr>`, 'g');
  const out = {}; let m;
  while ((m = re.exec(html))) {
    const [, flag, id, name, total, daily] = m;
    out[id] = { n: decode(name), t: num(total), d: num(daily), ...(flag ? { f: flag.trim() } : {}) };
  }
  return out;
}
function parseSummary(html) {
  const date = (html.match(/Last updated: (\d{4})\/(\d{2})\/(\d{2})/) || []).slice(1).join('-');
  const name = decode((html.match(/<title>(.*?) - Spotify Top/) || [])[1] || '');
  const row = label => { const m = html.match(new RegExp(`<td class="text">${label}</td><td>([^<]*)</td><td class="smaller">([^<]*)</td><td class="smaller">([^<]*)</td><td class="smaller">([^<]*)</td>`)); return m ? m.slice(1).map(num) : [0, 0, 0, 0]; };
  const [t, tLead, tSolo, tFeat] = row('Streams');
  const [d, dLead, dSolo, dFeat] = row('Daily');
  const [tracks] = row('Tracks');
  return { date, name, t, d, tracks, lead: { t: tLead, d: dLead }, solo: { t: tSolo, d: dSolo }, feat: { t: tFeat, d: dFeat } };
}

/* ---------------- coleta ---------------- */
async function collect(artistId) {
  const base = `https://kworb.net/spotify/artist/${artistId}`;
  const songsHtml = await fetchText(`${base}_songs.html`);
  await sleep(1000);
  const albumsHtml = await fetchText(`${base}_albums.html`);
  const sum = parseSummary(songsHtml);
  if (!sum.date) throw new Error('Página do kworb sem data — artista inexistente?');
  const snap = { ...sum, songs: parseRows(songsHtml, 'track'), albums: parseRows(albumsHtml, 'album'), fetchedAt: new Date().toISOString() };
  const file = path.join(HIST, artistId + '.json');
  const hist = readJSON(file, { id: artistId, name: sum.name, snapshots: {} });
  const isNew = !hist.snapshots[sum.date];
  hist.name = sum.name;
  hist.snapshots[sum.date] = snap;
  writeJSON(file, hist);
  return { date: sum.date, isNew, name: sum.name };
}

/* ---------------- estatísticas ---------------- */
const DAY = 864e5;
const toT = d => Date.parse(d + 'T00:00:00Z');
function periodStats(series, days) {
  if (!series.length) return { value: 0, covered: 0, days, complete: false };
  const last = series[series.length - 1];
  const start = toT(last.date) - days * DAY;
  const base = series.find(s => toT(s.date) === start);
  if (base) return { value: Math.max(0, last.t - base.t), covered: days, days, complete: true };
  const inWin = series.filter(s => toT(s.date) > start);
  return { value: inWin.reduce((a, s) => a + s.d, 0), covered: inWin.length, days, complete: inWin.length >= days };
}
function prevPeriodStats(series, days) {
  if (!series.length) return null;
  const lastT = toT(series[series.length - 1].date);
  const cut = series.filter(s => toT(s.date) <= lastT - days * DAY);
  if (!cut.length || toT(cut[cut.length - 1].date) !== lastT - days * DAY) return null;
  const p = periodStats(cut, days);
  return p.complete ? p.value : null;
}
function stats(series) {
  const out = {};
  for (const [k, n] of [['day', 1], ['week', 7], ['month', 30]]) {
    const cur = periodStats(series, n), prev = prevPeriodStats(series, n);
    out[k] = { ...cur, prev, change: prev ? (cur.value - prev) / prev : null };
  }
  out.total = (series[series.length - 1] || { t: 0 }).t;
  return out;
}
const seriesOf = (snaps, pick) => snaps.map(s => { const v = pick(s); return v ? { date: s.date, t: v.t, d: v.d } : null; }).filter(Boolean);

/* ---------------- capas (oEmbed do Spotify, com cache) ---------------- */
const covers = readJSON(COVERS_FILE, {});
async function cover(type, id) {
  const key = type + ':' + id;
  if (covers[key] !== undefined) return covers[key];
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/${type}/${id}`);
    covers[key] = r.ok ? ((await r.json()).thumbnail_url || null) : null;
  } catch { return null; }
  return covers[key];
}
function saveCovers() { writeJSON(COVERS_FILE, covers); }

/* ---------------- arquivos publicados para o app ---------------- */
async function buildArtist(id) {
  const h = readJSON(path.join(HIST, id + '.json'), null);
  if (!h) return null;
  const snaps = Object.values(h.snapshots).sort((a, b) => a.date.localeCompare(b.date));
  const last = snaps[snaps.length - 1];
  const series = seriesOf(snaps, s => s);
  const img = await cover('artist', id);
  const items = async (kind, type) => {
    const list = [];
    // busca capas que faltam em paralelo (6 por vez), salvando o cache a cada lote
    const missing = Object.keys(last[kind]).filter(i => covers[type + ':' + i] === undefined);
    for (let i = 0; i < missing.length; i += 6) {
      await Promise.all(missing.slice(i, i + 6).map(x => cover(type, x)));
      if (i % 60 === 0) saveCovers();
    }
    for (const [itemId, v] of Object.entries(last[kind])) {
      const s = seriesOf(snaps, sn => sn[kind][itemId]);
      const st = stats(s), cimg = await cover(type, itemId);
      list.push({ id: itemId, name: v.n, flag: v.f || null, img: cimg, stats: st, days: s.length });
      writeJSON(path.join(OUT, 'artists', id, `${kind}_${itemId}.json`),
        { id: itemId, kind, artistId: id, artistName: h.name, name: v.n, img: cimg, stats: st, days: s.length, series: s.map(x => [x.date, x.t, x.d]) });
    }
    return list;
  };
  const detail = {
    id, name: h.name, img, days: snaps.length, firstDate: snaps[0].date, lastDate: last.date, tracks: last.tracks,
    breakdown: { lead: last.lead, solo: last.solo, feat: last.feat },
    stats: stats(series), series: series.map(x => [x.date, x.t, x.d]),
    albums: await items('albums', 'album'), songs: await items('songs', 'track'),
  };
  writeJSON(path.join(OUT, 'artists', id + '.json'), detail);
  return { id, name: h.name, img, days: snaps.length, firstDate: detail.firstDate, lastDate: detail.lastDate,
           stats: detail.stats, spark: series.slice(-30).map(s => s.d) };
}

/* ---------------- índice de artistas (busca no app) ---------------- */
async function buildArtistIndex() {
  const html = await fetchText('https://kworb.net/spotify/artists.html');
  const re = /<a href="\/spotify\/artist\/([A-Za-z0-9]{22})_songs\.html">(.*?)<\/a><\/div><\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
  const list = []; let m;
  while ((m = re.exec(html))) list.push([m[1], decode(m[2]), Math.round(parseFloat(m[3].replace(/,/g, '')))]);
  if (list.length > 100) writeJSON(path.join(OUT, 'artist-index.json'), list);
  return list.length;
}

/* ---------------- paradas da Apple Music Brasil (aba Ouvir) ---------------- */
async function buildCharts() {
  const rss = async p => (await (await fetch(`https://rss.applemarketingtools.com/api/v2/br/${p}.json`)).json()).feed.results;
  const out = {};
  try {
    const ids = (await rss('music/most-played/30/songs')).map(r => r.id);
    const look = await (await fetch(`https://itunes.apple.com/lookup?country=BR&id=${ids.join(',')}`)).json();
    const by = Object.fromEntries(look.results.map(r => [String(r.trackId), r]));
    out.songs = ids.map(i => by[i]).filter(Boolean).map(r => ({ trackId: r.trackId, trackName: r.trackName, artistName: r.artistName, artworkUrl100: r.artworkUrl100, previewUrl: r.previewUrl, collectionId: r.collectionId }));
  } catch (e) { console.log('charts songs:', e.message); }
  const simple = r => ({ collectionId: r.id, collectionName: r.name, artistName: r.artistName, artworkUrl100: r.artworkUrl100 });
  try { out.albums = (await rss('music/most-played/20/albums')).map(simple); } catch (e) { console.log('charts albums:', e.message); }
  try { out.podcasts = (await rss('podcasts/top/20/podcasts')).map(simple); } catch (e) { console.log('charts podcasts:', e.message); }
  out.updatedAt = new Date().toISOString();
  writeJSON(path.join(OUT, 'charts.json'), out);
}

module.exports = { DATA, OUT, listTracked, saveTracked, collect, buildArtist, buildArtistIndex, buildCharts, saveCovers, writeJSON, readJSON, validId, sleep, _stats: stats };
