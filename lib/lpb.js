// Chart de gênero Latin do iTunes por país, via LivePopBars (livepopbars2.com).
// O kworb já traz o chart geral do iTunes; aqui entram as posições no chart Latin,
// que é onde artistas latinos aparecem em muito mais países.
// Uma passada por hora (~120 países, uma página por vez, com pausa). Resultado em data/lpb.json.
const path = require('path');
const { DATA, readJSON, writeJSON, sleep } = require('./tracker');

const BASE = 'http://www.livepopbars2.com/index.php';
const CHART_LATIN = 12;
const FILE = path.join(DATA, 'lpb.json');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
};
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const decode = s => s.replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function page(region, chart) {
  const r = await fetch(`${BASE}?Region=${region}&Chart=${chart}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
function regions(html) {
  const sel = (html.match(/<select name="Region">([\s\S]*?)<\/select>/) || [])[1] || '';
  const out = new Map(); let m;
  const re = /<option value="(\d+)">([^<]+)/g;
  while ((m = re.exec(sel))) if (!/select/i.test(m[2])) out.set(m[1], decode(m[2]).trim());
  return [...out].map(([id, name]) => ({ id, name }));
}
// linhas: posição, artista, título e código do país (cc= no link da Apple)
function rows(html) {
  const out = [];
  for (const tr of html.split(/<tr>\s*<td style="vertical-align: middle; text-align:center">/).slice(1)) {
    const pos = parseInt(tr, 10);
    const cells = [...tr.matchAll(/<td style="vertical-align: middle;">([^<]*)/g)].map(m => decode(m[1]).trim());
    const cc = (tr.match(/[?&](?:amp;)?cc=([a-z]{2})/) || [])[1];
    if (pos && cells.length >= 2) out.push({ pos, artist: cells[0], title: cells[1], cc });
  }
  return out;
}

// artists: [{id, name}] — devolve { fetchedAt, byArtist: { id: { título: [[cc, país, pos, variação]] } } }
async function collectLatin(artists, log = console.log) {
  const prev = readJSON(FILE, { runs: [] });
  if (prev.fetchedAt && Date.now() - Date.parse(prev.fetchedAt) < 50 * 60e3) return prev;
  const names = artists.filter(a => a.name).map(a => ({ id: a.id, n: norm(a.name) }));
  if (!names.length) return prev;
  let list;
  try { const first = await page('143441', CHART_LATIN); list = regions(first); }
  catch (e) { log('LivePopBars indisponível:', e.message); return prev; }

  const byArtist = {}, now = {}; let ok = 0, fails = 0;
  for (const rg of list) {
    let html;
    try { html = await page(rg.id, CHART_LATIN); ok++; fails = 0; }
    catch (e) { if (++fails >= 4) { log('LivePopBars: muitas falhas seguidas, parando'); break; } continue; }
    for (const r of rows(html)) {
      const who = norm(r.artist);
      for (const a of names) {
        if (!new RegExp(`(^|[\\s,&(])${a.n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,&)])`).test(who)) continue;
        const cc = r.cc || '';
        (byArtist[a.id] ||= {})[r.title] ||= [];
        byArtist[a.id][r.title].push([cc, rg.name, r.pos, null]);
        now[`${a.id}|${cc}|${norm(r.title)}`] = r.pos;
      }
    }
    await sleep(600);
  }
  if (!ok) return prev;

  // variação em ~24h: compara com a passada mais próxima de 24h atrás (entre 20h e 30h)
  const t = Date.now();
  const old = (prev.runs || []).filter(x => t - x.ts > 20 * 3600e3 && t - x.ts < 30 * 3600e3).sort((a, b) => Math.abs(t - a.ts - 864e5) - Math.abs(t - b.ts - 864e5))[0];
  if (old) for (const [id, songs] of Object.entries(byArtist)) for (const [title, list] of Object.entries(songs)) for (const row of list) {
    const p = old.pos[`${id}|${row[0]}|${norm(title)}`];
    row[3] = p == null ? 'NE' : p === row[2] ? '=' : p > row[2] ? '+' + (p - row[2]) : '-' + (row[2] - p);
  }
  const runs = [...(prev.runs || []), { ts: t, pos: now }].filter(x => t - x.ts < 32 * 3600e3);
  const out = { fetchedAt: new Date(t).toISOString(), regions: ok, byArtist, runs };
  writeJSON(FILE, out);
  log(`LivePopBars: chart Latin de ${ok} países`);
  return out;
}

module.exports = { collectLatin, _rows: rows, _regions: regions };
