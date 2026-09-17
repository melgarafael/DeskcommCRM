import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { IMAGE } from './profile.mjs';

// Consulta anônima de metadados upstream; não acessa Docker local nem baixa camadas.
const authentication = await fetch('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull', {
  signal: AbortSignal.timeout(10_000),
});
if (!authentication.ok) throw new Error(`Autenticação anônima do Registry: HTTP ${authentication.status}`);
const { token } = await authentication.json();
const response = await fetch(`https://registry-1.docker.io/v2/library/node/manifests/${IMAGE.index}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Manifesto oficial: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, IMAGE.index);
assert.equal(response.headers.get('docker-content-digest'), IMAGE.index);
const index = JSON.parse(bytes.toString('utf8'));
for (const arch of ['amd64', 'arm64']) {
  assert.equal(index.manifests.find((manifest) => manifest.platform.os === 'linux'
    && manifest.platform.architecture === arch)?.digest, IMAGE[arch]);
}
process.stdout.write(`${JSON.stringify({ status: 'verified', upstream: 'docker.io/library/node', ...IMAGE,
  downloaded_layers: 0, local_docker_used: false }, null, 2)}\n`);
