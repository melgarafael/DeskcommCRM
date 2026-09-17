// Fixture revisada inteira em argv: sem bind mount, segredo ou código recebido da UI.
// A closure abaixo simula a semântica; não é barreira contra JavaScript hostil.
export const WORKLOAD_SOURCE = String.raw`
'use strict';
const { performance } = require('node:perf_hooks');
const authority = Object.freeze({ organization: 'synthetic-org-a', actor: 'synthetic-actor-a' });
const records = new Map([[1, {organization:'synthetic-org-a', value:41}], [2, {organization:'synthetic-org-b', value:99}]]);
function readRecord(id, granted = true) {
  const record = records.get(id);
  if (!granted || !record || record.organization !== authority.organization) throw new Error('capability_denied');
  return record.value;
}
if (process.argv[1] === 'runaway') {
  process.stdout.write('LOOP_ENTERED\n');
  while (true) {}
}
let denied = 0;
for (const [id, granted] of [[2, true], [1, false]]) {
  try { readRecord(id, granted); } catch (error) { if (error.message === 'capability_denied') denied++; else throw error; }
}
const samples = [];
for (let index = 0; index < 50; index++) {
  const start = performance.now();
  if (readRecord(1) !== 41) throw new Error('invalid_value');
  samples.push(performance.now() - start);
}
const usage = process.resourceUsage();
process.stdout.write(JSON.stringify({ protocol:1, value:readRecord(1), denied, node:process.version,
  platform:process.platform, arch:process.arch, uid:process.getuid(), warm_call_ms:samples,
  rss_peak_bytes:usage.maxRSS * 1024, cpu_us:usage.userCPUTime + usage.systemCPUTime }) + '\n');
`;

export function decodeWorkload(text) {
  const value = JSON.parse(text);
  if (value.protocol !== 1 || value.value !== 41 || value.denied !== 2 || value.uid !== 65534
    || value.node !== 'v22.22.3' || value.platform !== 'linux'
    || !['arm64', 'x64'].includes(value.arch)
    || !Array.isArray(value.warm_call_ms) || value.warm_call_ms.length !== 50
    || !value.warm_call_ms.every((sample) => Number.isFinite(sample) && sample >= 0)
    || !Number.isFinite(value.rss_peak_bytes) || value.rss_peak_bytes <= 0
    || !Number.isFinite(value.cpu_us) || value.cpu_us < 0) throw new Error('Protocolo/resultado do workload inválido.');
  return value;
}

/** Docker sem TTY prefixa cada frame por stream/reservado/tamanho (8 bytes). */
export function decodeLogs(buffer, limit = 64 * 1024) {
  let offset = 0;
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) throw new Error('Frame Docker truncado.');
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    if (![1, 2].includes(stream) || buffer.subarray(offset + 1, offset + 4).some((byte) => byte !== 0)
      || offset + 8 + length > buffer.length) throw new Error('Frame Docker inválido.');
    bytes += length;
    if (bytes > limit) throw new Error('Saída do contêiner excedeu o limite.');
    (stream === 1 ? stdout : stderr).push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}
