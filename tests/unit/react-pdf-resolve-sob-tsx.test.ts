import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `@react-pdf/hyphenate@0.1.0` é ESM puro (`"type":"module"`) e seu `exports`
 * map só definia a condição `import`. Este repo não declara `"type":"module"`
 * no `package.json` (CommonJS por padrão), e o worker roda via `tsx`
 * (`Dockerfile.worker`), que resolve `node_modules` com `require()` nativo do
 * Node — a mesma resolução que `register-handlers.ts` atravessa pra montar o
 * admin client do drain loop (`lib/event-log/drain-loop.ts`). Sem a condição
 * `require`, QUALQUER import estático de `@react-pdf/renderer` (usado pelo
 * PDF de exportação LGPD, `lib/lgpd/pdf-renderer.tsx`) derrubava
 * `carregarDeps()` com `ERR_PACKAGE_PATH_NOT_EXPORTED` — e como
 * `register-handlers.ts` registra os 12 handlers num só import chain, UM
 * pacote quebrado tirava o laço rápido de TODOS, não só do LGPD (medido em
 * VPS, 2026-09-08: warn "event-log drain OFF" a cada boot do worker,
 * handlers caindo pro cron de 1×/min).
 *
 * O conserto é `patches/@react-pdf__hyphenate.patch`
 * (`pnpm.patchedDependencies` no `package.json`), que acrescenta a condição
 * `require` ao `exports` do hyphenate — Node 22.12+/24 já sabe carregar ESM
 * via `require()` quando o mapa permite (o pacote não usa top-level await).
 * Confirmado nos dois sentidos: sem o patch este teste falha com o erro
 * acima; com ele, passa.
 *
 * Mesma técnica de `import-puro-sem-env.test.ts` (processo FILHO com `tsx`
 * de verdade), mas com uma virada que É o ponto do teste: `import()` DINÂMICO
 * não serve aqui — ele entrega pro loader ESM nativo do Node, que sempre
 * honra a condição `import` do exports map (nunca quebrou, patch ou não). O
 * `tsx` intercepta `require()` GLOBALMENTE (o hook em `register-*.cjs`),
 * inclusive dentro do código-fonte ESM de dependências que ELE PRÓPRIO já
 * carregou — é assim que a resolução profunda de `@react-pdf/textkit`
 * atravessa o hook do `tsx` e bate no exports map do hyphenate. Confirmado
 * manualmente: `import()` no `--eval` passa sempre (falso-negativo); só
 * `require()` reproduz o defeito e prova o patch.
 */

const RAIZ = join(__dirname, "..", "..");
const TSX_CLI = join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");

function requireNoTsx(modulo: string): { ok: boolean; erro: string } {
  const script = `try{require(${JSON.stringify(modulo)});console.log("OK")}catch(e){console.log("ERRO:"+String(e&&e.message).split("\\n")[0])}`;
  try {
    const saida = execFileSync(process.execPath, [TSX_CLI, "--eval", script], {
      cwd: RAIZ,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: saida.includes("OK"), erro: saida.trim() };
  } catch (e) {
    const bruto =
      typeof e === "object" && e !== null && "stdout" in e
        ? String((e as { stdout?: unknown }).stdout ?? "")
        : "";
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, erro: `${bruto} ${msg}`.trim().slice(0, 400) };
  }
}

describe("@react-pdf/renderer resolve sob tsx (CommonJS)", () => {
  it("importa sem ERR_PACKAGE_PATH_NOT_EXPORTED", { timeout: 60_000 }, () => {
    const r = requireNoTsx("@react-pdf/renderer");
    expect(
      r.ok,
      `@react-pdf/renderer não importou sob tsx — provável regressão do patch ` +
        `de @react-pdf/hyphenate (a condição "require" do exports map em ` +
        `patches/@react-pdf__hyphenate.patch). Isto derruba carregarDeps() do ` +
        `drain loop do worker E a exportação de dados LGPD. Saída: ${r.erro}`,
    ).toBe(true);
  });
});
