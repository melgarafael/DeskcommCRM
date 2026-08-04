/**
 * Sobe um script `.ts` do repo num processo filho — é assim que todo spec E2E
 * roda o seu seed.
 *
 * POR QUE NÃO `execFileSync("npx", ["tsx", ...])`, que era o que estava nos
 * specs: no Windows o `npx` não é um executável, é o shim `npx.cmd`.
 * `execFileSync` sem shell não acha `"npx"` (ENOENT) e — desde a mitigação do
 * CVE-2024-27980 (Node >= 18.20 / 20.12 / 22.0) — recusa spawnar `"npx.cmd"`
 * direto (EINVAL). Os 20 call sites morriam no `beforeAll`, antes de o
 * navegador abrir: em Windows a suíte E2E inteira não subia, e o vermelho não
 * falava de produto nenhum.
 *
 * `shell: true` faria funcionar e é exatamente o que NÃO se deve fazer aqui:
 * reabre o buraco de injeção de comando que a mitigação fechou, num lugar que
 * interpola caminho de arquivo.
 *
 * `process.execPath` é o binário do Node que já está rodando: existe em
 * qualquer SO, não depende do PATH e não passa por shim nenhum. `--import tsx`
 * registra o loader de TypeScript no filho — mesmo efeito de `npx tsx`, sem o
 * `npx`.
 *
 * Existe UMA porta porque são ~20 chamadas idênticas: guarda espalhada é
 * guarda que volta a divergir. `tests/unit/seed-e2e-sem-npx.test.ts` reprova
 * quem contornar esta porta.
 */
import { execFileSync } from "node:child_process";

const argv = (script: string, args: string[]): string[] => ["--import", "tsx", script, ...args];

/** Roda o seed despejando a saída no terminal (o padrão dos specs). */
export function rodaSeed(script: string, ...args: string[]): void {
  execFileSync(process.execPath, argv(script, args), { stdio: "inherit" });
}

/** Igual, mas devolve o stdout — para os helpers que imprimem JSON na saída. */
export function rodaSeedCapturando(script: string, ...args: string[]): string {
  return execFileSync(process.execPath, argv(script, args), { encoding: "utf8" });
}
