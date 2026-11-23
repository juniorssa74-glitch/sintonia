// Coleta + publicação dos dados do Sintonia.
// Uso: node scripts/collect.js
// Variáveis opcionais (GitHub Actions):
//   ISSUE_TITLE  — "Acompanhar <spotifyArtistId>: Nome" ou "Remover <spotifyArtistId>: Nome"
//   GITHUB_REPOSITORY — "dono/repo" (para o app montar links de issues)
const path = require('path');
const T = require('../lib/tracker');

(async () => {
  const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
  let tracked = T.listTracked();

  // 1) pedido vindo de issue (adicionar/remover artista)
  const m = (process.env.ISSUE_TITLE || '').match(/^(Acompanhar|Remover)\s+([A-Za-z0-9]{22})/i);
  if (m) {
    const [, action, id] = m;
    if (/^remover$/i.test(action)) { tracked = tracked.filter(a => a.id !== id); log('removido', id); }
    else if (!tracked.some(a => a.id === id)) { tracked.push({ id, addedAt: new Date().toISOString() }); log('adicionado', id); }
    T.saveTracked(tracked);
  }

  // 2) coleta diária no kworb
  let failed = 0;
  for (const a of tracked) {
    try { const r = await T.collect(a.id); a.name = r.name; a.lastDate = r.date; a.error = null; log(`${r.name}: ${r.date}${r.isNew ? ' (novo dia)' : ''}`); }
    catch (e) { a.error = e.message; failed++; log('erro', a.id, e.message); }
    await T.sleep(1500);
  }
  // artista recém-adicionado que não existe no kworb sai da lista
  tracked = tracked.filter(a => a.lastDate || !a.error);
  T.saveTracked(tracked);

  // 2b) chart Latin do iTunes por país (LivePopBars), no máximo 1x por hora
  try { await require('../lib/lpb').collectLatin(tracked, log); } catch (e) { log('LivePopBars falhou:', e.message); }

  // 3) arquivos publicados
  const summary = [];
  for (const a of tracked) { const s = await T.buildArtist(a.id); if (s) summary.push({ ...s, error: a.error || null }); }
  T.saveCovers();
  T.writeJSON(path.join(T.OUT, 'summary.json'), { generatedAt: new Date().toISOString(), repo: process.env.GITHUB_REPOSITORY || null, artists: summary });
  try { log('índice de artistas:', await T.buildArtistIndex()); } catch (e) { log('índice falhou:', e.message); }
  try { await T.buildCharts(); log('paradas atualizadas'); } catch (e) { log('paradas falharam:', e.message); }

  // 4) prêmios (Wikipédia), atualizados a cada 3 dias por artista
  const { buildAwards } = require('../lib/awards');
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();
  for (const a of summary) {
    try {
      const d = T.readJSON(path.join(T.OUT, 'artists', a.id + '.json'), { songs: [], albums: [] });
      const strip = s => norm(s.replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s+-\s+.*$/, ''));
      const catalog = { songs: new Set(d.songs.flatMap(s => [norm(s.name), strip(s.name)])), albums: new Set(d.albums.flatMap(s => [norm(s.name), strip(s.name)])) };
      const r = await buildAwards(a.id, a.name, catalog, m && m[2] === a.id);
      if (r) log(`prêmios de ${a.name}: ${r.won} vitórias em ${r.total} indicações`);
    } catch (e) { log('prêmios falharam:', a.name, e.message); }
  }

  if (m && /^acompanhar$/i.test(m[1]) && !tracked.some(a => a.id === m[2])) { console.error('Artista não encontrado no kworb'); process.exit(2); }
  if (failed && failed === tracked.length) process.exit(1);
})();
