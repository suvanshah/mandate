import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Mandate, InputError } from './engine.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
export function makeServer({ dataFile = null } = {}) {
  const engine = new Mandate(dataFile && existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) : null);
  const token = randomBytes(32).toString('hex');
  function persist() {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    writeFileSync(`${dataFile}.tmp`, JSON.stringify(engine.state), { mode: 0o600 });
    renameSync(`${dataFile}.tmp`, dataFile);
  }
  persist();
  const server = createServer(async (req, res) => {
    const reply = (status, body, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      if (!host || !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) throw new InputError('Only loopback hosts are supported.', 403);
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return reply(200, { ...engine.list(), csrfToken: token });
      const match = url.pathname.match(/^\/api\/requests\/([a-f0-9-]{36})(?:\/(attempt|remediate|approve|evidence))?$/);
      if (req.method === 'GET' && match?.[2] === 'evidence') return reply(200, engine.evidence(match[1]), { 'Content-Disposition': 'attachment; filename="mandate-evidence.json"' });
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        const file = files[url.pathname]; if (!file) return reply(404, { error: 'Not found.' });
        res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' }); return res.end(readFileSync(resolve(publicDir, file[0])));
      }
      if (!['POST', 'PUT'].includes(req.method)) return reply(405, { error: 'Method not allowed.' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new InputError('Cross-origin mutation rejected.', 403);
      const supplied = req.headers['x-mandate-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new InputError('Missing or invalid demo session token. Refresh the page.', 403);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Use application/json.', 415);
      let chunks = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new InputError('Request body too large.', 413); chunks += chunk; }
      let body; try { body = JSON.parse(chunks || '{}'); } catch { throw new InputError('Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected a JSON object.');
      let result;
      if (req.method === 'POST' && url.pathname === '/api/requests') { result = engine.createRequest(body.kind, body.parameters, body.action); engine.attempt(result.id); result = engine.view(result.id); }
      else if (match && req.method === 'PUT' && !match[2]) result = engine.update(match[1], body.parameters);
      else if (match && req.method === 'POST') {
        if (match[2] === 'attempt') result = engine.attempt(match[1]);
        else if (match[2] === 'remediate') result = engine.remediate(match[1]);
        else if (match[2] === 'approve') result = engine.approve(match[1], body.actor);
        else throw new InputError('Unknown operation.', 404);
      } else throw new InputError('Not found.', 404);
      persist(); reply(200, result);
    } catch (error) { reply(error instanceof InputError ? error.status : 500, { error: error instanceof InputError ? error.message : 'Internal error; check the server console.' }); if (!(error instanceof InputError)) console.error(error); }
  });
  server.requestTimeout = 10000;
  return { server, engine };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const dataFile = resolve(process.env.MANDATE_DATA_DIR || new URL('../data/', import.meta.url).pathname, 'state.json');
  const { server } = makeServer({ dataFile });
  server.listen(port, '127.0.0.1', () => console.log(`Mandate · http://127.0.0.1:${port} · simulation only`));
}
