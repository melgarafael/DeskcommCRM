import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoDentro, readContext, readJsonPlain, writeJsonAtomic } from './common.mjs';

import { cancelProbe, prepareProbe, probeReservation, ProbeBusyError } from './probe-supervisor.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const context = await readContext(repoRoot);
const workspaceId = createHash('sha256').update(context.repoRoot).digest('hex');
const resultsDir = path.join(context.evidenceDir, 'console-results');
async function ensureResultsDirectory() {
  const owned = await readContext(repoRoot);
  if (owned.evidenceDir !== context.evidenceDir) throw new Error('Área de resultados diferente da bancada.');
  await mkdir(resultsDir, { recursive: true, mode: 0o700 });
  const info = await lstat(resultsDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Diretório de resultados simbólico recusado.');
}
await ensureResultsDirectory();
const ids = ['runtime', 'events', 'state'];
const jobs = new Map();
let active = null;
let origin;
let closing = false;

for (const id of ids) {
  try {
    const saved = await readJsonPlain(caminhoDentro(resultsDir, `${id}.json`));
    if (saved.status === 'running') {
      saved.status = 'interrupted';
      saved.message = 'O console foi interrompido. O resultado não foi confirmado; uma reserva ativa impede nova execução até o encerramento do trabalho.';
    }
    jobs.set(id, saved);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function validRequestId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function save(id, state) {
  await ensureResultsDirectory();
  await writeJsonAtomic(caminhoDentro(resultsDir, `${id}.json`), state);
  jobs.set(id, state);
}

async function begin(id, requestId) {
  const state = { id, request_id: requestId, run_id: randomUUID(), status: 'running', started_at: new Date().toISOString() };
  // A memória serializa os requests locais; o supervisor guarda a vida real do trabalho.
  active = { id, child: null };
  let child;
  try {
    child = await prepareProbe(context, id);
    active.child = child;
    if (closing) throw new Error('Console em encerramento.');
    await save(id, state);
    await writeJsonAtomic(caminhoDentro(resultsDir, `request-${requestId}.json`), state);
  } catch (error) {
    if (child) { child.stdin.end(); await child.closed; }
    active = null;
    throw error;
  }
  let stdout = '';
  let stderr = '';
  let failure;
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
      failure = 'A prova produziu um relatório maior que o limite da bancada.';
      cancelProbe(child);
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 16000); });
  child.on('error', () => { failure = 'Não foi possível iniciar o processo da prova.'; });
  child.once('close', async code => {
    let finished;
    try {
      if (failure || code !== 0) throw new Error(failure ?? 'A prova falhou. Consulte o diagnóstico local.');
      const report = JSON.parse(stdout);
      if (report.id !== id || !['passed', 'failed', 'blocked'].includes(report.status)) {
        throw new Error('Relatório da prova inválido.');
      }
      finished = { ...state, status: report.status, finished_at: new Date().toISOString(), report };
    } catch (error) {
      finished = { ...state, status: 'failed', finished_at: new Date().toISOString(), message: error.message };
    }
    try {
      await ensureResultsDirectory();
      await writeJsonAtomic(caminhoDentro(resultsDir, `${state.run_id}.json`), { ...finished, diagnostic: stderr });
      await save(id, finished);
      await writeJsonAtomic(caminhoDentro(resultsDir, `request-${requestId}.json`), finished);
    } catch {
      jobs.set(id, { ...state, status: 'failed', message: 'Não foi possível salvar a evidência. Verifique o espaço local.' });
    } finally { active = null; }
  });
  child.stdin.end('run\n');
  return state;
}

const server = http.createServer(async (req, res) => {
  try {
    const expectedHost = new URL(origin).host;
    if (req.headers.host !== expectedHost) return reply(res, 403, { error: 'Endereço da bancada não autorizado.' });
    if (req.method === 'GET' && req.url === '/') {
      const nonce = randomBytes(18).toString('base64');
      const html = (await readFile(new URL('./console.html', import.meta.url), 'utf8')).replaceAll('__NONCE__', nonce);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'`,
      });
      return res.end(html);
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      return reply(res, 200, { active: active?.id ?? await probeReservation(context), jobs: Object.fromEntries(jobs), scope: 'architecture_experiments', workspace_id: workspaceId });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/request/')) {
      const requestId = req.url.slice('/api/request/'.length);
      if (!validRequestId(requestId)) return reply(res, 400, { error: 'Identificador de solicitação inválido.' });
      try { return reply(res, 200, await readJsonPlain(caminhoDentro(resultsDir, `request-${requestId}.json`))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return reply(res, 200, { status: 'unconfirmed' }); }
    }
    if (req.method === 'POST' && req.url.startsWith('/api/run/')) {
      if (req.headers.origin !== origin) return reply(res, 403, { error: 'Origem não autorizada.' });
      const id = req.url.slice('/api/run/'.length);
      if (!ids.includes(id)) return reply(res, 404, { error: 'Experimento desconhecido.' });
      if (Number(req.headers['content-length'] ?? 0) > 32 || req.headers['transfer-encoding']) {
        req.resume();
        return reply(res, 413, { error: 'A bancada não recebe código, SQL ou configuração por esta porta.' });
      }
      req.resume();
      const requestId = req.headers['x-request-id'];
      if (!validRequestId(requestId)) return reply(res, 400, { error: 'Identificador de solicitação inválido.' });
      try {
        const previous = await readJsonPlain(caminhoDentro(resultsDir, `request-${requestId}.json`));
        if (previous.id !== id) return reply(res, 409, { error: 'Solicitação já usada em outra prova.' });
        return reply(res, 200, previous);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (closing || active) return reply(res, 409, { error: 'Aguarde a prova em andamento para manter as medições separadas.' });
      const state = await begin(id, requestId);
      return reply(res, 202, state);
    }
    return reply(res, 404, { error: 'Página não encontrada.' });
  } catch (error) {
    if (error instanceof ProbeBusyError) return reply(res, 409, { error: error.message });
    return reply(res, 500, { error: 'Não foi possível concluir a operação da bancada.' }); }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
// A porta fixa evita dois servidores; a reserva do supervisor também protege CLI e retomadas.
// EADDRINUSE recusa o segundo processo; nunca encerra quem já está usando a porta.
if (process.argv.length > 2) throw new Error('O console usa a porta local 38761 e não recebe argumentos.');
const port = 38761;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;
process.stdout.write(`Bancada de extensões: ${origin}\n`);
async function shutdown() {
  closing = true;
  if (active?.child) cancelProbe(active.child);
  server.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
