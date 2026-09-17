import { fileURLToPath } from 'node:url';
import { readContext } from './common.mjs';
import { cancelProbe, prepareProbe, ProbeBusyError } from './probe-supervisor.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Informe uma prova: runtime, events ou state.');
  const context = await readContext(fileURLToPath(new URL('../../', import.meta.url)));
  const child = await prepareProbe(context, process.argv[2]);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.once('SIGTERM', () => cancelProbe(child));
  process.once('SIGINT', () => cancelProbe(child));
  child.stdin.end('run\n');
  process.exitCode = await child.closed;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof ProbeBusyError ? 73 : 1;
}
