/**
 * O laço rápido do `event_log` carrega três módulos por `await import`, e o que
 * decide se ele vive é a resolução deles **sob `tsx`** — não sob o vitest.
 *
 * ⚠️ POR QUE ESTE ARQUIVO ABRE UM PROCESSO FILHO
 *
 * O vitest resolve `node_modules` pelo Vite, que honra a condição `import` do
 * `exports`. O worker de produção roda sob `tsx`, que **não** honra. Foi
 * exatamente essa diferença que deixou `@react-pdf/hyphenate@0.1.0` quebrar o
 * laço em produção por 10 dias e três releases, com
 * `tests/unit/event-log-drain-loop.test.ts` **6/6 verde o tempo todo**.
 *
 * Então este teste não pode importar os módulos: ele precisa PEDIR ao `tsx` que
 * os importe, e olhar o exit code. E prende o CAMINHO (`register-handlers`, que
 * é quem de fato falhava), não o pacote — o teste do autor prendia
 * `require("@react-pdf/renderer")`, e o defeito era no subpath `./en-us`.
 *
 * Trabalho original de @ragaspaleilao no PR #643.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TSX = "node_modules/tsx/dist/cli.mjs";

/** Os três que `carregarDeps()` importa, na ordem em que ela os pede. */
const MODULOS = [
  "@/lib/event-log/drain-loop",
  "@/lib/agent-engine/edge/crm/drain",
  "@/lib/event-log/register-handlers",
] as const;

/**
 * O gerador de PDF saiu do caminho do laço (virou `await import` dentro da
 * função, em `workers/lgpd-export-worker.ts`), e por isso os três acima
 * resolveriam mesmo SEM o patch em `patches/@react-pdf__hyphenate.patch`.
 *
 * Mas o patch continua sendo o que faz a exportação de LGPD funcionar de
 * verdade: sem ele, `renderLgpdPdf` falha na HORA DA CHAMADA, com o titular
 * esperando o arquivo. Este módulo está aqui para que tirar o patch fique
 * vermelho em algum lugar — e no lugar certo, separado do laço.
 */
const MODULO_TARDIO = "@/lib/lgpd/pdf-renderer";

function importaSobTsx(modulo: string): { ok: boolean; saida: string } {
  const script = `import(${JSON.stringify(modulo)}).then(()=>process.exit(0)).catch(e=>{console.error(String(e&&e.message||e));process.exit(1)})`;
  try {
    execFileSync("node", [TSX, "--eval", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { ok: true, saida: "" };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return { ok: false, saida: String(err.stderr ?? err.stdout ?? e) };
  }
}

describe("o laço rápido do event_log carrega as dependências sob tsx", () => {
  it("CONTROLE: o tsx está no disco — sem isto, os casos abaixo passariam por não medir nada", () => {
    expect(existsSync(TSX)).toBe(true);
  });

  for (const modulo of MODULOS) {
    it(`${modulo} resolve sob tsx`, () => {
      const r = importaSobTsx(modulo);
      expect(r.ok, `não resolveu sob tsx:\n${r.saida}`).toBe(true);
    });
  }

  it(`${MODULO_TARDIO} resolve sob tsx (o import tardio do worker de LGPD)`, () => {
    const r = importaSobTsx(MODULO_TARDIO);
    expect(r.ok, `não resolveu sob tsx:\n${r.saida}`).toBe(true);
  });
});
