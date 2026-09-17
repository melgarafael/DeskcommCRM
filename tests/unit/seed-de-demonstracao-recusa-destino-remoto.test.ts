/**
 * O SEED DE AUTOMAÇÕES DE DEMONSTRAÇÃO RECUSA DESTINO REMOTO SEM PEDIDO EXPLÍCITO.
 *
 * `scripts/seed-automacoes-e-followups.ts` cria regras de automação e follow-up
 * ATIVOS — que agem sozinhos quando o motor roda. A primeira versão gravava onde
 * o `.env.local` apontasse, sem nem anunciar o destino, e terminava com "✅". Num
 * checkout de trabalho o `.env.local` aponta para PRODUÇÃO
 * (`scripts/lib/env-de-teste.ts`).
 *
 * A sonda roda o SCRIPT DE VERDADE num processo filho, com ambiente limpo e
 * diretório temporário (sem `.env.local` e sem `.e2e-creds.json`), e mede três
 * saídas. Nenhuma alcança a rede: a recusa vem antes de qualquer cliente, e o
 * que passa pela porta morre no `.e2e-creds.json` ausente, que é a primeira
 * coisa do `main()`. É essa segunda saída que prova que a porta ABRE — sem ela,
 * um script que recusasse tudo deixaria o primeiro caso verde.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
/** O CLI do tsx como arquivo, pelo `process.execPath` — ver `import-puro-sem-env.test.ts`. */
const TSX_CLI = join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");
const SEED = join(RAIZ, "scripts", "seed-automacoes-e-followups.ts");
const VAZIO = mkdtempSync(join(tmpdir(), "seed-demonstracao-"));

afterAll(() => rmSync(VAZIO, { recursive: true, force: true }));

function rodaSeed(url: string, args: string[] = []): { status: number | null; saida: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, SEED, ...args], {
    cwd: VAZIO,
    // `NODE_ENV` só porque o tipo `ProcessEnv` do Next o exige; o seed não o lê.
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NEXT_PUBLIC_SUPABASE_URL: url,
      SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste-que-nunca-sai-daqui",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, saida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Cada caso abre um processo filho (segundos, mais em máquina carregada).
describe("seed de automações de demonstração: destino", { timeout: 150_000 }, () => {
  it("destino remoto sem --permitir-remoto: recusa com exit 2, antes de ler as credenciais do e2e", () => {
    const r = rodaSeed("https://projeto-remoto.supabase.co");
    expect(r.saida, "o destino tem de ser anunciado").toContain("REMOTO");
    expect(r.saida).toContain("--permitir-remoto");
    expect(r.saida, "passou da porta e foi ler o .e2e-creds.json").not.toContain(".e2e-creds.json");
    expect(r.status, r.saida).toBe(2);
  });

  it("destino local: passa pela porta (e para no .e2e-creds.json ausente)", () => {
    const r = rodaSeed("http://127.0.0.1:54321");
    expect(r.saida).toContain("escrevendo em LOCAL");
    expect(r.saida).toContain(".e2e-creds.json");
    expect(r.status, r.saida).toBe(1);
  });

  it("destino remoto COM --permitir-remoto: passa pela porta", () => {
    const r = rodaSeed("https://projeto-remoto.supabase.co", ["--permitir-remoto"]);
    expect(r.saida).toContain(".e2e-creds.json");
    expect(r.status, r.saida).toBe(1);
  });
});
