// Notificações: compara as posições de charts desta coleta com as anteriores e avisa
// quando uma música/álbum ENTRA num país novo ou SOBE para o top 10 / #1.
// Envio pelo Firebase Cloud Messaging (tópicos sintonia-pt e sintonia-es), com a capa.
// Sem o segredo FIREBASE_SERVICE_ACCOUNT, só registra as novidades (nada é enviado).
const path = require('path'), crypto = require('crypto');
const { DATA, OUT, readJSON, writeJSON } = require('./tracker');

const STATE = path.join(DATA, 'notify-state.json');
const H = 3600e3;
const FORGET = 7 * 24 * H;      // posição esquecida depois de 7 dias fora
const REENTRY = 48 * H;         // voltar a um país depois de 48h fora conta como entrada de novo
const MAX_PUSH = 8;             // no máximo 8 notificações por coleta (o resto vira um resumo)
const SVC = { spotify: 'Spotify', apple: 'Apple Music', itunes: 'iTunes', itunesLatin: 'iTunes Latin' };
const flag = cc => cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0))) : '🌐';

const T = {
  pt: { entered: n => n === 1 ? 'Entrou em 1 país novo' : `Entrou em ${n} países novos`, top10: 'Subiu para o top 10', one: 'Chegou ao #1', in: 'no', more: n => `e mais ${n}`,
        sumTitle: 'Sintonia · novidades nos charts', sum: n => `Mais ${n} novidades nos charts. Abra o app para ver.` , global: 'Global', loc: 'pt-BR' },
  es: { entered: n => n === 1 ? 'Entró en 1 país nuevo' : `Entró en ${n} países nuevos`, top10: 'Subió al top 10', one: 'Llegó al #1', in: 'en', more: n => `y ${n} más`,
        sumTitle: 'Sintonia · novedades en los charts', sum: n => `${n} novedades más en los charts. Abre la app para verlas.`, global: 'Global', loc: 'es' },
};
const place = (lang, e) => {
  if (e.cc === 'global' || e.cc === 'ww' || !e.cc) return T[lang].global;
  try { return new Intl.DisplayNames([T[lang].loc], { type: 'region' }).of(e.cc.toUpperCase()) || e.cname; } catch { return e.cname; }
};

// snap: [{a, an, ai, k, i, n, img, svc, cc, cname, pos}] → lista de notificações agrupadas
function detect(snap, now = Date.now()) {
  const st = readJSON(STATE, null);
  const first = !st;
  const seen = st?.seen || {};
  const groups = new Map();
  const known = new Set(Object.keys(seen).map(k => k.split('|')[0]));
  for (const e of snap) {
    const key = `${e.a}|${e.k}|${e.i}|${e.svc}|${e.cc}`;
    // chave pelo título também: a música lançada há pouco troca de id quando entra no kworb, sem avisar de novo
    const nkey = e.nk ? `${e.a}|${e.k}|t:${e.nk}|${e.svc}|${e.cc}` : null;
    const old = seen[key] || (nkey && seen[nkey]);
    if (nkey) seen[nkey] = { p: e.pos, t: now };
    let type = null;
    if (!old || now - old.t > REENTRY) { if (!first && known.has(e.a)) type = 'entered'; }
    else if (e.pos === 1 && old.p > 1) type = 'one';
    else if (e.pos <= 10 && old.p > 10) type = 'top10';
    seen[key] = { p: e.pos, t: now };
    if (!type) continue;
    const g = `${e.a}|${e.k}|${e.i}|${e.svc}`;
    if (!groups.has(g)) groups.set(g, { a: e.a, an: e.an, ai: e.ai, k: e.k, i: e.i, n: e.n, img: e.img, svc: e.svc, entered: [], top10: [], one: [] });
    groups.get(g)[type].push(e);
  }
  for (const [k, v] of Object.entries(seen)) if (now - v.t > FORGET) delete seen[k];
  writeJSON(STATE, { updatedAt: new Date(now).toISOString(), seen });
  // mais importante primeiro: #1, top 10, depois quem entrou em mais países / melhor posição
  const score = g => g.one.length * 1000 + g.top10.length * 100 + g.entered.length * 10 - Math.min(...[...g.one, ...g.top10, ...g.entered].map(e => e.pos)) / 100;
  return [...groups.values()].sort((x, y) => score(y) - score(x));
}

function text(lang, g) {
  const t = T[lang], list = es => es.sort((a, b) => a.pos - b.pos);
  const parts = [], fmt = es => { const s = list(es).slice(0, 4).map(e => `${flag(e.cc)} ${place(lang, e)} #${e.pos}`).join(', '); return es.length > 4 ? `${s} ${t.more(es.length - 4)}` : s; };
  if (g.one.length) parts.push(`${t.one} ${t.in} ${SVC[g.svc]}: ${fmt(g.one)}`);
  if (g.top10.length) parts.push(`${t.top10} ${t.in} ${SVC[g.svc]}: ${fmt(g.top10)}`);
  if (g.entered.length) parts.push(`${t.entered(g.entered.length)} ${t.in} ${SVC[g.svc]}: ${fmt(g.entered)}`);
  return { title: `${g.n} · ${g.an}`, body: parts.join('\n') };
}

/* ---------------- Firebase Cloud Messaging (HTTP v1) ---------------- */
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function fcmToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('Firebase: login falhou (' + (j.error_description || j.error || r.status) + ')');
  return j.access_token;
}
// to: nome do tópico ou condição FCM ("'a' in topics || 'b' in topics")
async function fcmSend(sa, token, to, { title, body, image, data }) {
  const message = { ...(to.includes(' in topics') ? { condition: to } : { topic: to }), notification: { title, body, ...(image ? { image } : {}) }, data: data || {},
    android: { priority: 'high', notification: { ...(image ? { image } : {}), tag: data?.tag, sound: 'default' } } };
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  if (!r.ok) throw new Error(`Firebase: envio falhou (HTTP ${r.status}) ${(await r.text()).slice(0, 200)}`);
}

async function run(snap, log = console.log) {
  const groups = detect(snap);
  // histórico das últimas novidades (o app pode mostrar)
  const feedFile = path.join(OUT, 'notifications.json');
  const feed = readJSON(feedFile, { items: [] });
  const at = new Date().toISOString();
  feed.items = [...groups.map(g => ({ at, ...text('pt', g), a: g.a, k: g.k, i: g.i, svc: g.svc, img: g.img || g.ai })), ...feed.items].slice(0, 80);
  // situação do envio fica pública (sem dados sensíveis), para conferir sem abrir os logs
  const status = st => { feed.status = { at, novidades: groups.length, ...st }; writeJSON(feedFile, feed); };
  let sa = null, saErr = null;
  try { sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null; } catch { saErr = 'FIREBASE_SERVICE_ACCOUNT não é um JSON válido'; }
  if (!sa) { status({ firebase: saErr || 'não configurado', enviadas: 0 }); log('notificações:', saErr || 'Firebase não configurado'); return 0; }
  let token;
  try { token = await fcmToken(sa); } catch (e) { status({ firebase: 'erro: ' + e.message, enviadas: 0 }); log(e.message); return 0; }
  if (!groups.length) { status({ firebase: 'ok', projeto: sa.project_id, enviadas: 0 }); log('notificações: nada novo'); return 0; }
  log(`notificações: ${groups.length} novidades`);
  let sent = 0, lastErr = null;
  // cada aparelho recebe só o artista favorito (tópico sintonia-<idioma>-<artista>); o tópico antigo
  // sintonia-<idioma> (apps que ainda não abriram depois da mudança) continua recebendo todos
  const byArtist = new Map();
  for (const g of groups) { if (!byArtist.has(g.a)) byArtist.set(g.a, []); byArtist.get(g.a).push(g); }
  for (const lang of ['pt', 'es']) for (const [a, gs] of byArtist) {
    const to = `'sintonia-${lang}-${a}' in topics || 'sintonia-${lang}' in topics`;
    for (const g of gs.slice(0, MAX_PUSH)) {
      const m = text(lang, g);
      try {
        await fcmSend(sa, token, to, { ...m, image: g.img || g.ai || undefined,
          data: { artistId: g.a, kind: g.k, id: g.i, tag: `${g.i}-${g.svc}` } });
        sent++;
      } catch (e) { lastErr = e.message; log(e.message); }
    }
    if (gs.length > MAX_PUSH) {
      try { await fcmSend(sa, token, to, { title: T[lang].sumTitle, body: T[lang].sum(gs.length - MAX_PUSH), data: { tag: 'resumo-' + a } }); sent++; } catch (e) { log(e.message); }
    }
  }
  status({ firebase: lastErr ? "erro: " + lastErr : "ok", projeto: sa.project_id, enviadas: sent });
  log(`notificações enviadas: ${sent}`);
  return sent;
}

module.exports = { run, detect, text };
