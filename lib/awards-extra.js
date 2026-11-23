// Fontes extras de prêmios por artista (indicadas pelo usuário).
// Hoje: sites WordPress com API pública (wp-json), ex.: Galería Sueños (acervo do J Balvin).
const SOURCES = {
  '1vyhD5VmyZ7KMfW5gqLgo5': [{ id: 'gs', name: 'Galería Sueños', site: 'https://galeriasuenos.com' }],
};
const UA = { 'User-Agent': 'SintoniaAwards/1.0 (personal music stats app)' };
const decode = s => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// títulos em CAIXA ALTA viram 'Título Normal'
const tc = s => !(s.length > 4 && s === s.toUpperCase()) ? s : s.toLowerCase()
  .replace(/(^|[\s(“"'¡¿-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/(?<=\s)(De|Del|La|Las|Los|El|Y|En|A|Por|Of|The|And|For)(?=\s)/g, w => w.toLowerCase())
  .replace(/\b(Mtv|Ema|Bmi|Riaa|Sayco|Sesac|Miaw|Ii|Iii)\b/g, w => w.toUpperCase());
const clean = s => decode(s).replace(/[￼�]/g, '').replace(/\s+/g, ' ').trim();

const CERT = /disco de|platin|\boro\b|\bgold\b|certifica|riaa/i;
const AWARD = /premio|premios|award|grammy|academia|billboard|mtv|\bbmi\b|sesac|sayco|lo nuestro|juventud|soberano|shock|luna|nuestra tierra|miaw|\bema\b|los ?40|iheart|deezer|spotify|guinness|monitor latino|claro|tv fama|teletón|telet[oó]n/i;
const HONOR = /reconoc|homenaje|nota de estilo|grado oro|[íi]cono|concejo|ej[ée]rcito/i;
const SKIP = /air jordan|jordan x|tenis|chaqueta|balaclava|muñeca|escultura|monopoly|álbum de fotos|tarjeta profesional|metaverso|higo|homenaje de amor|sold out|reliability|hello world|prueba|^galer[íi]a sue[ñn]os$|papa francisco|^estatuilla|álvaro osorio|expresiones de gratitud|art studio|revista billboard|9 reconocimientos/i;

function classify(title){
  if (SKIP.test(title)) return null;
  if (/grado oro|concejo|ej[ée]rcito/i.test(title)) return 'honor';
  if (CERT.test(title) && !/premio|award/i.test(title)) return 'cert';
  if (AWARD.test(title)) return 'award';
  if (HONOR.test(title)) return 'honor';
  return null;
}

async function wpPosts(site){
  const all = [];
  for (let page = 1; page < 20; page++) {
    const r = await fetch(`${site}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,date,link,title,content`, { headers: UA });
    if (!r.ok) break;
    const list = await r.json();
    all.push(...list);
    if (list.length < 100) break;
    await new Promise(res => setTimeout(res, 800));
  }
  return all;
}

async function extraAwards(artistId){
  const out = [];
  for (const src of SOURCES[artistId] || []) {
    try {
      const posts = await wpPosts(src.site);
      const items = [];
      for (const p of posts) {
        const raw = clean(p.title.rendered);
        const num = +((raw.match(/^(\d+)\.\s*/) || [])[1] || 0);
        const title = raw.replace(/^\d+\.\s*/, '').replace(/[.\s]+$/, '');
        const kind = classify(title);
        if (!kind) continue;
        const text = clean(p.content.rendered.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')).slice(0, 400);
        const year = +((title.match(/\b(19[89]\d|20[0-3]\d)\b/) || text.match(/\b(19[89]\d|20[0-3]\d)\b/) || [])[1] || 0) || null;
        const parts = title.split(/\s[–—-]\s|:\s/);
        let award = parts[0], category = parts.slice(1).join(' – ');
        award = award.replace(/\b(19[89]\d|20[0-3]\d)\b/g, '').replace(/\s{2,}/g, ' ').replace(/[\s,–-]+$/, '').trim() || title;
        const img = (p.content.rendered.match(/<img[^>]+src="(https:\/\/[^"]+\/wp-content\/uploads\/[^"]+)"/) || [])[1];
        const thumb = img ? img.replace(/-\d+x\d+(\.\w+)$/, '-150x150$1') : null;
        items.push({ n: num || null, a: tc(award), c: tc(category), y: year, k: kind, img: thumb, link: p.link });
      }
      items.sort((a, b) => (b.y || 0) - (a.y || 0) || (b.n || 0) - (a.n || 0));
      out.push({ id: src.id, name: src.name, url: src.site, fetchedAt: new Date().toISOString(), items });
    } catch (e) { console.log('fonte extra', src.name, ':', e.message); }
  }
  return out;
}

module.exports = { extraAwards, SOURCES };
