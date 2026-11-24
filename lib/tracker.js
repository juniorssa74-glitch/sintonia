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
  await liveCharts(artistId, songsHtml);
  try { await collectListeners(artistId); } catch (e) { console.log('ouvintes falharam:', e.message); }
  const snap = { ...sum, songs: parseRows(songsHtml, 'track'), albums: parseRows(albumsHtml, 'album'), fetchedAt: new Date().toISOString() };
  const file = path.join(HIST, artistId + '.json');
  const hist = readJSON(file, { id: artistId, name: sum.name, snapshots: {} });
  const isNew = !hist.snapshots[sum.date];
  hist.name = sum.name;
  hist.snapshots[sum.date] = snap;
  writeJSON(file, hist);
  return { date: sum.date, isNew, name: sum.name };
}

/* ---------------- ouvintes mensais ---------------- */
// kworb.net/spotify/listeners.html: top 2.500 com valor, variação diária, posição e pico.
// Fora do top, lê o número da página do artista no Spotify. Histórico em data/listeners/<id>.json.
const LISTENERS = path.join(DATA, 'listeners');
let listenersTop = null;
async function topListeners() {
  if (listenersTop) return listenersTop;
  listenersTop = {};
  try {
    const html = await fetchText('https://kworb.net/spotify/listeners.html');
    const re = /<tr><td>(\d+)<\/td><td class="text"><div><a href="artist\/([A-Za-z0-9]{22})_songs\.html">[^<]*<\/a><\/div><\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>(\d+)<\/td><td class="smaller">([^<]*)<\/td><\/tr>/g;
    let m;
    while ((m = re.exec(html))) listenersTop[m[2]] = { l: num(m[3]), d: parseInt(m[4].replace(/[^\d-]/g, ''), 10) || 0, rank: +m[1], peakRank: +m[5], peak: num(m[6]) };
  } catch (e) { console.log('ouvintes: kworb falhou,', e.message); }
  return listenersTop;
}
async function spotifyListeners(id) {
  try {
    const html = await fetchText(`https://open.spotify.com/artist/${id}`);
    const exact = html.match(/([\d,.]+) monthly listeners/g)?.map(s => s.replace(/ monthly listeners/, '')).find(s => /^\d{1,3}([,.]\d{3})+$|^\d{1,3}$/.test(s));
    if (exact) return num(exact);
    const m = html.match(/([\d.]+)([KMB]) monthly listeners/);
    return m ? Math.round(parseFloat(m[1]) * { K: 1e3, M: 1e6, B: 1e9 }[m[2]]) : null;
  } catch { return null; }
}
async function collectListeners(id) {
  const top = await topListeners();
  let v = top[id] ? { ...top[id], src: 'kworb' } : null;
  if (!v) { const l = await spotifyListeners(id); if (l) v = { l, src: 'spotify' }; }
  if (!v) return null;
  const f = path.join(LISTENERS, id + '.json'), h = readJSON(f, {});
  h[new Date().toISOString().slice(0, 10)] = v;
  writeJSON(f, h);
  return v;
}
function listenersOf(id) {
  const h = readJSON(path.join(LISTENERS, id + '.json'), null);
  if (!h) return null;
  const days = Object.keys(h).sort(), date = days[days.length - 1], cur = h[date];
  const prev = days.length > 1 ? h[days[days.length - 2]] : null;
  const peakSeen = Math.max(...days.map(k => h[k].l));
  return { value: cur.l, date, src: cur.src,
    change: cur.src === 'kworb' ? cur.d : prev ? cur.l - prev.l : null,
    rank: cur.rank || null, peak: Math.max(cur.peak || 0, peakSeen), peakRank: cur.peakRank || null,
    series: days.slice(-90).map(k => [k, h[k].l]) };
}

/* ---------------- charts atuais (Spotify, Apple Music, iTunes) ---------------- */
// Página de artista do kworb (/itunes/artist/<slug>.html), atualizada de hora em hora:
// para cada música/álbum, a posição atual em cada país e a variação em 24h.
const LIVE = path.join(DATA, 'live');
const SVC = { spo: 'spotify', app: 'apple', itu: 'itunes' };
function parseLive(html){
  const section = id => { const a = html.indexOf(`<div id='${id}'`); if (a < 0) return ''; const b = html.indexOf("<div id='", a + 10); return html.slice(a, b < 0 ? undefined : b); };
  const parse = sec => {
    const out = {};
    for (const cell of sec.split('<td valign=top width="200"><div class="wrap"><b>').slice(1)) {
      const title = decode(cell.slice(0, cell.indexOf('</b>'))).replace(/^Album:\s*/i, '').trim();
      const ch = {}; let m;
      const re = /<div class="[^"]*\b(spo|app|itu)"><a href="([^"]+)">#(\d+) ([^<]+)<\/a>(?: <span class="change24">\(([^)]*)\)<\/span>)?<\/div>/g;
      while ((m = re.exec(cell))) {
        const [, svc, href, pos, country, change] = m;
        const cc = (href.match(/\/([a-z]{2}|global|ww)(?:_daily)?\.html$/) || href.match(/album-([a-z]{2}|global)-/) || [])[1] || '';
        (ch[SVC[svc]] ||= []).push([cc, decode(country), +pos, change || null]);
      }
      if (Object.keys(ch).length && !out[title]) out[title] = ch;
    }
    return out;
  };
  return { updated: (html.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (EST|EDT)/) || []).slice(1).join(' '), songs: parse(section('songs')), albums: parse(section('albums')) };
}
// data real de cada chart: Spotify (dia do chart diário) e Apple Music / iTunes (hora da última atualização)
let chartDates = null;
async function getChartDates(){
  if (chartDates) return chartDates;
  const d = {};
  try { const m = (await fetchText('https://kworb.net/spotify/country/global_daily.html')).match(/Spotify Daily Chart - Global - (\d{4})\/(\d{2})\/(\d{2})/); if (m) d.spotify = `${m[1]}-${m[2]}-${m[3]}`; } catch {}
  for (const [k, u] of [['apple', 'charts/apple_s/br.html'], ['itunes', 'charts/itunes/br.html']]) {
    try { const r = await fetch('https://kworb.net/' + u, { method: 'HEAD', headers: UA }); const lm = r.headers.get('last-modified'); if (lm) d[k] = new Date(lm).toISOString(); } catch {}
  }
  return chartDates = d;
}
async function liveCharts(artistId, songsHtml){
  const slug = (songsHtml.match(/href="\/itunes\/artist\/([^"]+)\.html"/) || [])[1];
  if (!slug) return;
  try {
    await sleep(1000);
    const live = parseLive(await fetchText(`https://kworb.net/itunes/artist/${slug}.html`));
    writeJSON(path.join(LIVE, artistId + '.json'), { slug, fetchedAt: new Date().toISOString(), dates: await getChartDates(), ...live });
  } catch (e) { console.log('charts de', artistId, ':', e.message); }
}
// junta as posições pelo nome (exato; senão pelo título-base, se só uma música tiver esse nome)
function liveKey(pool, name, all){
  const n = norm(name);
  let key = Object.keys(pool).find(k => norm(k) === n);
  if (!key) {
    const b = baseTitle(name);
    if (all.filter(x => baseTitle(x) === b).length === 1) key = Object.keys(pool).find(k => baseTitle(k) === b);
  }
  return key;
}
function liveFor(live, kind, name, all){
  if (!live) return null;
  const pool = live[kind] || {}, key = liveKey(pool, name, all);
  const list = {};
  if (key) for (const [svc, rows] of Object.entries(pool[key])) list[svc] = rows.slice().sort((a, b) => a[2] - b[2]);
  return { updated: live.updated, fetchedAt: live.fetchedAt, dates: live.dates || null, list };
}

// streams do dia por país (chart diário do Spotify no kworb): { date, cc: { trackId: streams } }
// Baixa só os países em que alguma música acompanhada está no chart; 1x por dia de chart.
const CSTREAMS = path.join(DATA, 'spotify-country.json');
let cStreams = null;
async function countryStreams() {
  const cache = readJSON(CSTREAMS, { date: null, by: {} });
  const date = (await getChartDates()).spotify;
  if (!date) return cStreams = cache;
  if (cache.date !== date) { cache.date = date; cache.by = {}; }
  const want = new Set();
  for (const f of fs.existsSync(LIVE) ? fs.readdirSync(LIVE) : []) {
    const l = readJSON(path.join(LIVE, f), {});
    for (const v of Object.values(l.songs || {})) for (const r of v.spotify || []) want.add(r[0]);
  }
  let n = 0;
  for (const cc of want) {
    if (cache.by[cc] || !/^([a-z]{2}|global)$/.test(cc)) continue;
    try {
      const html = await fetchText(`https://kworb.net/spotify/country/${cc}_daily.html`);
      // por posição: [id, título, streams] (a versão da música no chart pode ter outro ID)
      const m = {}, re = /<tr><td class="np">(\d+)<\/td>[\s\S]*?<a href="\.\.\/track\/([A-Za-z0-9]{22})\.html">([^<]*)<\/a>[\s\S]*?<\/tr>/g; let x;
      while ((x = re.exec(html))) { const tds = x[0].split('</div></td>')[1]?.match(/<td[^>]*>([\d,]+)<\/td>/g) || []; if (tds[2]) m[x[1]] = [x[2], decode(x[3]), num(tds[2])]; }
      cache.by[cc] = m; n++;
      await sleep(700);
    } catch (e) { console.log('streams por país', cc, e.message); }
  }
  if (n) { writeJSON(CSTREAMS, cache); console.log(`streams por país: ${n} países (${date})`); }
  return cStreams = cache;
}

// todas as posições atuais (de todos os artistas) desta coleta, para as notificações
const chartSnap = [];
// chart Latin do iTunes (LivePopBars): junta pelo título exato; senão pelo título-base, se for único
function lpbKeys(pool, name, all){
  const n = norm(name), b = baseTitle(name);
  let keys = Object.keys(pool).filter(k => norm(k) === n);
  if (!keys.length && all.filter(x => baseTitle(x) === b).length === 1) keys = Object.keys(pool).filter(k => baseTitle(k) === b);
  return keys;
}
function lpbFor(pool, name, all){
  if (!pool) return [];
  const keys = lpbKeys(pool, name, all);
  const best = new Map();
  for (const k of keys) for (const r of pool[k]) { const o = best.get(r[0]); if (!o || r[2] < o[2]) best.set(r[0], r); }
  return [...best.values()].sort((a, b) => a[2] - b[2]);
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
// capa via oEmbed. Falha temporária (limite do Spotify) não fica gravada; "sem capa" é tentado de novo após 3 dias.
covers._miss ??= {};
let coverBlocked = false;
async function cover(type, id) {
  const key = type + ':' + id;
  if (covers[key]) return covers[key];
  const miss = covers._miss[key];
  if (covers[key] === null && miss && Date.now() - miss < 3 * DAY) return null;
  if (coverBlocked) return covers[key] ?? null;
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/${type}/${id}`);
    if (r.status === 429 || r.status >= 500) { coverBlocked = true; console.log('capas: limite do Spotify, continua na próxima coleta'); return covers[key] ?? null; }
    const url = r.ok ? ((await r.json()).thumbnail_url || null) : null;
    covers[key] = url;
    if (url) delete covers._miss[key]; else covers._miss[key] = Date.now();
  } catch { return covers[key] ?? null; }
  return covers[key];
}
function saveCovers() { writeJSON(COVERS_FILE, covers); }

/* ---------------- faixas dos álbuns (API pública da Apple, com cache) ---------------- */
const ALBUMMAP_FILE = path.join(DATA, 'album-tracks.json');
const albumMap = readJSON(ALBUMMAP_FILE, {});
function saveAlbumMap() { writeJSON(ALBUMMAP_FILE, albumMap); }
// normaliza títulos: sem acento, sem "(feat. ...)", só letras e números
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\s*[\(\[](feat|ft|with|part|participacao)\b[^\)\]]*[\)\]]/g, '')
  .replace(/\s+-\s+(feat|ft)\b.*$/, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const baseTitle = s => norm(String(s).replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s+-\s+.*$/, ''));

function matchSong(title, songs) {
  const n = norm(title);
  const exact = songs.find(s => norm(s.name) === n);
  if (exact) return exact;
  const b = baseTitle(title), cands = songs.filter(s => baseTitle(s.name) === b);
  if (cands.length) return cands.length === 1 ? cands[0] : null; // só aceita se não houver ambiguidade
  // nome de um contido no outro, em palavras inteiras (ex.: Apple "Nanã" × kworb "É de Nanã"),
  // com no máximo 3 palavras a mais e um único candidato
  const words = s => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  const bw = words(b);
  if (b.length < 4 || !bw.length) return null;
  const inside = (small, big) => big.length > small.length && big.length - small.length <= 3 &&
    big.some((_, i) => small.every((w, j) => big[i + j] === w));
  const loose = songs.filter(s => inside(bw, words(baseTitle(s.name))));
  return loose.length === 1 ? loose[0] : null;
}

async function itunes(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.ok) return (await r.json()).results || [];
    if (r.status === 403 || r.status === 429) { await sleep(20000); continue; } // limite da Apple: espera
    throw new Error('iTunes ' + r.status);
  }
  throw new Error('iTunes: limite de requisições');
}

// data de lançamento (Apple) para o 'Day N' das imagens; busca uma vez para álbuns já em cache
async function albumRelease(albumId) {
  const c = albumMap[albumId];
  if (!c?.appleId) return null;
  if (c.release !== undefined && c.release !== null) return c.release;
  if (c.releaseChecked && Date.now() - Date.parse(c.releaseChecked) < 7 * DAY) return null;
  try { await sleep(1500); const r = (await itunes(`https://itunes.apple.com/lookup?id=${c.appleId}&country=BR`))[0]; c.release = r?.releaseDate || null; }
  catch { c.release = null; }
  c.releaseChecked = new Date().toISOString();
  return c.release;
}
async function albumTracklist(artistName, albumName, albumId) {
  const c = albumMap[albumId];
  const RETRY = 7 * DAY; // álbum não encontrado: tenta de novo depois de 7 dias
  if (c && (c.tracks || Date.now() - Date.parse(c.checkedAt) < RETRY)) return c.tracks;
  let tracks = null, appleId = null;
  try {
    const an = norm(albumName), ab = baseTitle(albumName), deluxe = /deluxe/i.test(albumName);
    const same = r => norm(r.collectionName) === an || norm(r.collectionName.replace(/ - (EP|Single)$/, '')) === an;
    const close = r => baseTitle(r.collectionName.replace(/ - (EP|Single)$/, '')) === ab && /deluxe/i.test(r.collectionName) === deluxe;
    const getTracks = async id => { await sleep(3000); return (await itunes(`https://itunes.apple.com/lookup?id=${id}&entity=song&country=BR`)).filter(r => r.wrapperType === 'track'); };

    // 1) discografia do próprio artista na Apple
    const disc = await discography(artistName);
    let pick = disc.find(same) || disc.find(close), songs = null;
    if (pick) songs = await getTracks(pick.collectionId);
    // 2) álbum de outro artista (participação): busca pelo nome e confirma que o artista aparece nas faixas
    if (!songs) {
      await sleep(3000);
      const q = new URLSearchParams({ term: albumName, entity: 'album', attribute: 'albumTerm', country: 'BR', limit: '25' });
      const cands = (await itunes('https://itunes.apple.com/search?' + q)).filter(r => same(r) || close(r)).slice(0, 3);
      for (const cnd of cands) {
        const s = await getTracks(cnd.collectionId);
        if (s.some(t => norm(t.artistName).includes(norm(artistName)) || norm(t.trackName).includes(norm(artistName)))) { pick = cnd; songs = s; break; }
      }
    }
    if (songs?.length) {
      appleId = pick.collectionId;
      tracks = songs.sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))
        .map(r => ({ n: r.trackName, no: r.trackNumber, disc: r.discNumber }));
    }
    albumMap[albumId] = { checkedAt: new Date().toISOString(), appleId, tracks, release: pick?.releaseDate || null };
  } catch (e) { console.log('faixas de', albumName, ':', e.message); return c?.tracks || null; }
  return tracks;
}

const discCache = {};
async function discography(artistName) {
  if (discCache[artistName]) return discCache[artistName];
  const key = '_artist:' + norm(artistName);
  let id = albumMap[key]?.appleArtistId;
  if (!id) {
    await sleep(3000);
    const q = new URLSearchParams({ term: artistName, entity: 'musicArtist', country: 'BR', limit: '10' });
    const a = (await itunes('https://itunes.apple.com/search?' + q)).find(r => norm(r.artistName) === norm(artistName));
    id = a?.artistId || null;
    albumMap[key] = { appleArtistId: id, checkedAt: new Date().toISOString() };
  }
  if (!id) return (discCache[artistName] = []);
  await sleep(3000);
  const list = (await itunes(`https://itunes.apple.com/lookup?id=${id}&entity=album&limit=200&country=BR`)).filter(r => r.wrapperType === 'collection');
  return (discCache[artistName] = list);
}

/* ---------------- arquivos publicados para o app ---------------- */
// Músicas que já estão nos charts (Apple Music, iTunes, Spotify, iTunes Latin) mas ainda não na lista de
// streams do kworb — em geral lançamentos dos últimos dias. Entram com capa (Apple) e charts, sem streams;
// quando o kworb incluir a música, ela passa a casar com o item normal e esta entrada some sozinha.
async function freshSongs(id, artistName, artistImg, last, live, lpb){
  const allNames = Object.values(last.songs).map(x => x.n), allBase = new Set(allNames.map(baseTitle));
  const lpool = lpb?.byArtist?.[id] || {};
  const usedLive = new Set(allNames.map(n => live && liveKey(live.songs || {}, n, allNames)).filter(Boolean));
  const usedLpb = new Set(allNames.flatMap(n => lpbKeys(lpool, n, allNames)));
  const fresh = new Map();
  const slot = t => { const b = baseTitle(t); if (!b || allBase.has(b)) return null; if (!fresh.has(b)) fresh.set(b, { name: t, list: {} }); return fresh.get(b); };
  for (const [t, ch] of Object.entries(live?.songs || {})) {
    if (usedLive.has(t)) continue;
    const f = slot(t); if (!f) continue;
    for (const [svc, rows] of Object.entries(ch)) f.list[svc] = (f.list[svc] || []).concat(rows);
  }
  for (const [t, rows] of Object.entries(lpool)) {
    if (usedLpb.has(t)) continue;
    const f = slot(t); if (!f) continue;
    f.list.itunesLatin = (f.list.itunesLatin || []).concat(rows);
  }
  const out = [];
  for (const [b, f] of fresh) {
    for (const [svc, rows] of Object.entries(f.list)) {
      const best = new Map(); for (const r of rows) { const o = best.get(r[0]); if (!o || r[2] < o[2]) best.set(r[0], r); }
      f.list[svc] = [...best.values()].sort((x, y) => x[2] - y[2]);
    }
    if (f.list.spotify && cStreams?.by) f.list.spotify = f.list.spotify.map(r => {
      const same = Object.values(cStreams.by[r[0]] || {}).filter(x => baseTitle(x[1]) === b);
      return same.length === 1 ? [r[0], r[1], r[2], r[3], same[0][2]] : r;
    });
    // capa e data de lançamento pela busca da Apple (em cache; tenta de novo depois de 1 dia se não achar)
    const ck = `fresh:${id}:${b}`; let info = covers[ck];
    if (!info || (!info.img && Date.now() - info.at > DAY)) {
      info = { img: null, release: null, at: Date.now() };
      try {
        await sleep(1500);
        const q = new URLSearchParams({ term: `${artistName} ${f.name}`, entity: 'song', country: 'BR', limit: '15' });
        const r = (await itunes('https://itunes.apple.com/search?' + q))
          .filter(x => baseTitle(x.trackName) === b && norm(x.artistName).includes(norm(artistName)))
          .sort((x, y) => (y.releaseDate || '').localeCompare(x.releaseDate || ''))[0];
        let hit = r;
        // a busca da Apple demora dias para indexar lançamentos; o álbum do link da LivePopBars já resolve
        const aid = Object.entries(lpb?.apple?.[id] || {}).find(([t]) => baseTitle(t) === b)?.[1];
        if (!hit && aid) {
          await sleep(1500);
          const tr = await itunes(`https://itunes.apple.com/lookup?id=${aid}&entity=song&country=BR`);
          hit = tr.find(x => x.wrapperType === 'track' && baseTitle(x.trackName) === b) || tr.find(x => x.wrapperType === 'collection');
        }
        if (hit) info = { img: (hit.artworkUrl100 || '').replace(/\/\d+x\d+bb\./, '/600x600bb.') || null, release: hit.releaseDate || null, at: Date.now() };
      } catch {}
      covers[ck] = info;
    }
    const itemId = 'new-' + b.replace(/ /g, '-').slice(0, 60);
    const charts = { updated: live?.updated || null, fetchedAt: live?.fetchedAt || lpb?.fetchedAt, dates: { ...(live?.dates || {}), ...(f.list.itunesLatin ? { itunesLatin: lpb.fetchedAt } : {}) }, list: f.list };
    for (const [svc, rows] of Object.entries(f.list))
      for (const [cc, cname, pos] of rows) chartSnap.push({ a: id, an: artistName, ai: artistImg, k: 'songs', i: itemId, n: f.name, nk: b, img: info.img, svc, cc, cname, pos });
    const st = stats([]), nCh = Object.values(f.list).reduce((a, r) => a + r.length, 0);
    out.push({ id: itemId, name: f.name, flag: null, img: info.img, stats: st, days: 0, fresh: true, release: info.release, ch: nCh });
    writeJSON(path.join(OUT, 'artists', id, `songs_${itemId}.json`),
      { id: itemId, kind: 'songs', artistId: id, artistName, name: f.name, img: info.img, stats: st, days: 0, lastDate: last.date,
        series: [], charts, fresh: true, release: info.release });
  }
  saveCovers();
  return out.sort((x, y) => y.ch - x.ch);
}

async function buildArtist(id) {
  const h = readJSON(path.join(HIST, id + '.json'), null);
  if (!h) return null;
  const snaps = Object.values(h.snapshots).sort((a, b) => a.date.localeCompare(b.date));
  const last = snaps[snaps.length - 1];
  const series = seriesOf(snaps, s => s);
  const img = await cover('artist', id);
  const live = readJSON(path.join(LIVE, id + '.json'), null);
  const lpb = readJSON(path.join(DATA, 'lpb.json'), null);
  const songSp = new Map(); // charts do Spotify de cada música, para as faixas dos álbuns
  const items = async (kind, type, extra = () => ({})) => {
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
      let charts = liveFor(live, kind, v.n, Object.values(last[kind]).map(x => x.n));
      if (kind === 'songs' && charts?.list?.spotify && cStreams?.by)
        charts.list.spotify = charts.list.spotify.map(r => {
          const rows = Object.values(cStreams.by[r[0]] || {});
          let e = rows.find(x => x[0] === itemId);
          if (!e) { const same = rows.filter(x => baseTitle(x[1]) === baseTitle(v.n)); if (same.length === 1) e = same[0]; }
          return e ? [r[0], r[1], r[2], r[3], e[2]] : r;
        });
      if (kind === 'songs') {
        const lr = lpbFor(lpb?.byArtist?.[id], v.n, Object.values(last.songs).map(x => x.n));
        if (lr.length) {
          charts ||= { updated: null, fetchedAt: lpb.fetchedAt, dates: {}, list: {} };
          charts.list.itunesLatin = lr;
          charts.dates = { ...(charts.dates || {}), itunesLatin: lpb.fetchedAt };
        }
      }
      if (charts) for (const [svc, rows] of Object.entries(charts.list))
        for (const [cc, cname, pos] of rows) chartSnap.push({ a: id, an: h.name, ai: img, k: kind, i: itemId, n: v.n, nk: kind === 'songs' ? baseTitle(v.n) : null, img: cimg, svc, cc, cname, pos });
      if (kind === 'songs' && charts?.list?.spotify?.length) songSp.set(itemId, charts.list.spotify);
      const nCh = charts ? Object.values(charts.list).reduce((a, r) => a + r.length, 0) : 0;
      const ex = await extra(itemId, v);
      list.push({ id: itemId, name: v.n, flag: v.f || null, img: cimg, stats: ex.stats || st, days: s.length, ...(nCh ? { ch: nCh } : {}) });
      writeJSON(path.join(OUT, 'artists', id, `${kind}_${itemId}.json`),
        { id: itemId, kind, artistId: id, artistName: h.name, name: v.n, img: cimg, stats: st, days: s.length, lastDate: last.date,
          series: s.map(x => [x.date, x.t, x.d]), charts, ...ex });
    }
    return list;
  };
  const songs = await items('songs', 'track');
  songs.unshift(...await freshSongs(id, h.name, img, last, live, lpb));
  // faixas de cada álbum: lista da Apple, cruzada pelo nome com as músicas do kworb
  const albums = await items('albums', 'album', async (albumId, v) => {
    const full = await albumTracklist(h.name, v.n, albumId);
    if (!full) return { tracks: null };
    const release = await albumRelease(albumId);
    // álbum que traz junto um álbum anterior do artista (ex.: EQUILIBRIVM II com as 15 do EQUILIBRIVM):
    // mostra só as faixas próprias. Edições deluxe/expandidas continuam completas.
    let tl = full; const includes = [];
    if (!/deluxe|expanded|expandid|edition|edición|edição|version|versão|versión|b.?sides?|lado b/i.test(v.n)) {
      const rel = albumMap[albumId]?.release;
      for (const [oid, ov] of Object.entries(last.albums)) {
        const o = albumMap[oid];
        if (oid === albumId || !o?.tracks || o.tracks.length < 5 || o.tracks.length >= tl.length) continue;
        if (!rel || !o.release || o.release >= rel) continue; // só álbuns lançados antes
        const names = new Set(o.tracks.map(t => norm(t.n)));
        if (tl.filter(t => names.has(norm(t.n))).length >= o.tracks.length * 0.8) { tl = tl.filter(t => !names.has(norm(t.n))); includes.push(ov.n); }
      }
    }
    const tracks = tl.map(t => {
      const m = matchSong(t.n, songs);
      return m ? { no: t.no, disc: t.disc, id: m.id, name: m.name, img: m.img, stats: m.fresh ? null : m.stats, ...(songSp.get(m.id) ? { sp: songSp.get(m.id) } : {}) }
               : { no: t.no, disc: t.disc, id: null, name: t.n, stats: null };
    });
    if (!includes.length) return { release, tracks };
    // números do álbum = soma só das faixas próprias (o kworb soma as do álbum incluído também)
    const ids = [...new Set(tracks.filter(t => t.id).map(t => t.id))];
    const s2 = seriesOf(snaps, sn => { let t = 0, d = 0, any = false; for (const i of ids) { const x = sn.songs[i]; if (x) { t += x.t; d += x.d; any = true; } } return any ? { t, d } : null; });
    return { release, includes, tracks, stats: stats(s2), series: s2.map(x => [x.date, x.t, x.d]) };
  });
  saveAlbumMap();
  const listeners = listenersOf(id);
  const detail = {
    id, name: h.name, img, days: snaps.length, firstDate: snaps[0].date, lastDate: last.date, tracks: last.tracks, listeners,
    breakdown: { lead: last.lead, solo: last.solo, feat: last.feat },
    stats: stats(series), series: series.map(x => [x.date, x.t, x.d]),
    albums, songs,
  };
  writeJSON(path.join(OUT, 'artists', id + '.json'), detail);
  return { id, name: h.name, img, days: snaps.length, firstDate: detail.firstDate, lastDate: detail.lastDate,
           stats: detail.stats, spark: series.slice(-30).map(s => s.d),
           listeners: listeners && { value: listeners.value, change: listeners.change, rank: listeners.rank } };
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

module.exports = { DATA, OUT, listTracked, saveTracked, collect, buildArtist, buildArtistIndex, buildCharts, saveCovers, writeJSON, readJSON, validId, sleep, _stats: stats, _match: matchSong, _live: parseLive, chartSnap, countryStreams, collectListeners, listenersOf, _spl: spotifyListeners };
