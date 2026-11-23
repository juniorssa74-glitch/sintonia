// Prêmios e indicações de cada artista, a partir da Wikipédia em inglês
// ("List of awards and nominations received by <artista>"), com miniatura de cada prêmio.
// Conteúdo da Wikipédia: CC BY-SA 4.0 — o app mostra a fonte e o link da página.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'awards');
const OUT = path.join(ROOT, 'site', 'data', 'awards');
const UA = { 'User-Agent': 'SintoniaAwards/1.0 (personal music stats app; https://github.com)' };
const REFRESH = 3 * 864e5; // atualiza a cada 3 dias
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url){ const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }

const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;|&apos;/g, "'");
const text = h => decode(String(h || '').replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<br\s*\/?>/g, ' / ')
  .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/\s*\/\s*$/, '').trim();
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();

// tabela HTML -> grade de células, respeitando rowspan/colspan
function parseTable(html){
  const rows = [], carry = [];
  for (const chunk of html.split(/<tr[\s>]/).slice(1)) {
    const body = chunk.split('</tr>')[0], cells = [];
    const re = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/g; let m;
    while ((m = re.exec(body))) cells.push({ attrs: m[2], html: m[3], th: m[1] === 'th' });
    const out = []; let col = 0, ci = 0;
    for (let guard = 0; guard < 60; guard++) {
      if (carry[col] && carry[col].left > 0) { out[col] = carry[col].cell; carry[col].left--; col++; continue; }
      if (ci >= cells.length) { if (carry.slice(col).some(c => c && c.left > 0)) { col++; continue; } break; }
      const c = cells[ci++];
      const rs = +((c.attrs.match(/rowspan="?(\d+)/) || [])[1] || 1), cs = +((c.attrs.match(/colspan="?(\d+)/) || [])[1] || 1);
      for (let k = 0; k < cs; k++) { out[col] = c; carry[col] = rs > 1 ? { cell: c, left: rs - 1 } : null; col++; }
    }
    rows.push(out);
  }
  return rows;
}

const RESULT = r => /^won|winner|^win\b/i.test(r) ? 'won' : /nominat|shortlist|finalist|pending|longlist/i.test(r) ? 'nominated' : /honou?r|induct|received|awarded/i.test(r) ? 'won' : 'other';

function parsePage(html){
  const out = [], awardLinks = {};
  for (const t of html.split('<table').slice(1)) {
    if (!/class="[^"]*wikitable/.test(t.slice(0, 300))) continue;
    const grid = parseTable(t.split('</table>')[0]);
    const hi = grid.findIndex(r => r.length && r.every(c => c && c.th));
    if (hi < 0) continue;
    const H = grid[hi].map(c => text(c.html).toLowerCase());
    const col = re => H.findIndex(h => re.test(h));
    const cA = col(/^award|ceremony|organi[sz]ation|^prize/), cY = col(/^year/), cN = col(/recipient|nominee|nominated work|^work/), cC = col(/^category/), cR = col(/^result/);
    if (cY < 0 || cR < 0 || (cC < 0 && cN < 0)) continue;
    let section = '';
    // título da seção logo antes da tabela (listas antigas: uma tabela por prêmio)
    for (const row of grid.slice(hi + 1)) {
      if (!row.length) continue;
      const g = i => i >= 0 && row[i] ? row[i] : null;
      const awardCell = g(cA);
      const award = awardCell ? text(awardCell.html) : section;
      const link = awardCell && (awardCell.html.match(/<a href="\/wiki\/([^"#]+)"/) || [])[1];
      if (award && link && !awardLinks[award]) awardLinks[award] = decodeURIComponent(link);
      const year = parseInt(text(g(cY)?.html), 10) || null;
      const nominee = text(g(cN)?.html).replace(/["“”]/g, '').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim();
      const nomLink = g(cN) && (g(cN).html.match(/<a href="\/wiki\/([^"#]+)"/) || [])[1];
      const category = text(g(cC)?.html);
      const resRaw = text(g(cR)?.html);
      if (!award || !resRaw) continue;
      out.push({ award, year, nominee, nomLink: nomLink ? decodeURIComponent(nomLink) : null, italic: !!(g(cN) && /<i>/.test(g(cN).html)), quoted: /^["“]/.test(text(g(cN)?.html)), category, result: RESULT(resRaw), resultText: resRaw });
    }
  }
  return { rows: out, awardLinks };
}

// miniaturas (imagem principal da página de cada prêmio; só imagens livres)
async function thumbs(titles){
  const map = {};
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    try {
      const r = await getJSON('https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=160&pilicense=free&titles=' + encodeURIComponent(batch.join('|')));
      const back = {}; for (const x of [...(r.query.normalized || []), ...(r.query.redirects || [])]) back[x.to] = back[x.from] || x.from;
      for (const p of Object.values(r.query.pages || {})) {
        let t = p.title; while (back[t]) t = back[t];
        if (p.thumbnail) map[t] = p.thumbnail.source;
      }
    } catch (e) { console.log('miniaturas:', e.message); }
    await sleep(500);
  }
  // sem imagem livre na página: tenta o logotipo (P154) ou imagem (P18) do Wikidata, que ficam no Commons
  const missing = titles.filter(t => !map[t] && !map[t.replace(/_/g, ' ')]);
  for (let i = 0; i < missing.length; i += 40) {
    const batch = missing.slice(i, i + 40);
    try {
      const r = await getJSON('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|sitelinks&sitefilter=enwiki&sites=enwiki&titles=' + encodeURIComponent(batch.map(t => t.replace(/_/g, ' ')).join('|')));
      for (const e of Object.values(r.entities || {})) {
        const title = e.sitelinks?.enwiki?.title; if (!title) continue;
        const v = p => e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value;
        // logotipo; foto só se for do troféu/logo (evita foto aleatória de evento)
        const file = v('P154') || [v('P18')].find(f => f && /logo|troph|statuett|award|pr[eê]mio|gramophone|astronaut|moonman/i.test(f));
        if (!file) continue;
        const url = 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file.replace(/ /g, '_')) + '?width=160';
        for (const t of batch) if (t.replace(/_/g, ' ') === title) map[t] = url;
        map[title] = map[title] || url;
      }
    } catch (e) { console.log('logos:', e.message); }
    await sleep(500);
  }
  return map;
}

async function findPage(artistId){
  const q = `SELECT ?en WHERE { ?item wdt:P1902 "${artistId}". ?en schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> }`;
  const r = await getJSON('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q));
  const en = r.results.bindings[0]?.en?.value;
  if (!en) return null;
  const name = decodeURIComponent(en.split('/wiki/')[1]).replace(/_/g, ' ').replace(/\s*\([^)]*\)$/, '');
  for (const t of [`List of awards and nominations received by ${name}`]) {
    const p = await getJSON('https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&titles=' + encodeURIComponent(t));
    const pg = Object.values(p.query.pages)[0];
    if (!pg.missing) return { title: pg.title, article: decodeURIComponent(en.split('/wiki/')[1]) };
  }
  const s = await getJSON('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=' + encodeURIComponent(`intitle:"awards and nominations" "${name}"`));
  const hit = s.query.search.find(x => norm(x.title).includes(norm(name)));
  return { title: hit ? hit.title : null, article: decodeURIComponent(en.split('/wiki/')[1]) };
}

// classifica a obra indicada: artista, álbum, música ou outro (cruzando com o catálogo do kworb)
function classify(row, artistName, catalog){
  const n = norm(row.nominee);
  if (!n || /^(him|her|them|it)sel(f|ves)$/.test(n) || n === norm(artistName) || n.includes(norm(artistName)) && n.length < norm(artistName).length + 4) return 'artist';
  if (catalog.albums.has(n)) return 'album';
  if (catalog.songs.has(n)) return 'song';
  if (row.quoted) return 'song';
  if (row.italic) return /tour|show|live|ao vivo|film|series|documentary/i.test(row.nominee) ? 'other' : 'album';
  return 'other';
}

async function buildAwards(artistId, artistName, catalog, force){
  const rawFile = path.join(RAW, artistId + '.json');
  let raw = readJSON(rawFile, null);
  if (force || !raw || Date.now() - Date.parse(raw.fetchedAt) > REFRESH) {
    try {
      const pg = await findPage(artistId);
      if (pg?.title) {
        const r = await getJSON('https://en.wikipedia.org/w/api.php?action=parse&format=json&redirects=1&prop=text|revid&page=' + encodeURIComponent(pg.title));
        const { rows, awardLinks } = parsePage(r.parse.text['*']);
        const imgs = await thumbs([...new Set(Object.values(awardLinks))]);
        const awards = {};
        for (const [a, link] of Object.entries(awardLinks)) awards[a] = { page: link, img: imgs[link] || imgs[link.replace(/_/g, ' ')] || null };
        raw = { fetchedAt: new Date().toISOString(), source: { title: r.parse.title, revid: r.parse.revid, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(r.parse.title.replace(/ /g, '_')) }, awards, rows };
      } else raw = { fetchedAt: new Date().toISOString(), source: null, awards: {}, rows: [] };
      writeJSON(rawFile, raw);
    } catch (e) { console.log('prêmios de', artistName, ':', e.message); if (!raw) return null; }
  }
  const rows = raw.rows.map(r => ({ a: r.award, y: r.year, n: r.nominee, t: classify(r, artistName, catalog), c: r.category, r: r.result, rt: r.result === 'other' ? r.resultText : undefined }));
  const won = rows.filter(r => r.r === 'won').length;
  writeJSON(path.join(OUT, artistId + '.json'), { artistId, artistName, fetchedAt: raw.fetchedAt, source: raw.source, awards: raw.awards, total: rows.length, won, rows });
  return { total: rows.length, won };
}

module.exports = { buildAwards, _parse: parsePage };
