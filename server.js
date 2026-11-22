// Servidor local para testar o site: node server.js  →  http://localhost:5173
// Online, o site roda no GitHub Pages (estático). Aqui só servimos a pasta site/
// e fazemos proxy para a Apple e imagens (o navegador local às vezes bloqueia).
const http = require('http'), fs = require('fs'), path = require('path');
const port = process.env.PORT || 5173;
const SITE = path.join(__dirname, 'site');
const ALLOWED = new Set(['itunes.apple.com', 'rss.applemarketingtools.com']);
const IMG_HOSTS = /(\.mzstatic\.com|\.spotifycdn\.com|\.scdn\.co)$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/proxy' || u.pathname === '/img') {
      let target;
      try { target = new URL(u.searchParams.get('url')); } catch { res.writeHead(400); return res.end(); }
      const ok = target.protocol === 'https:' && (u.pathname === '/proxy' ? ALLOWED.has(target.hostname) : IMG_HOSTS.test(target.hostname));
      if (!ok) { res.writeHead(403); return res.end(); }
      const r = await fetch(target, { headers: { 'User-Agent': 'Sintonia/1.0' } });
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let file = path.normalize(path.join(SITE, decodeURIComponent(u.pathname)));
    if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('não encontrado'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end('erro: ' + e.message); } }
}).on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`Porta ${port} já em uso — use http://localhost:${port}`); process.exit(0); }
  throw e;
}).listen(port, () => console.log(`Sintonia (teste local) em http://localhost:${port}`));
