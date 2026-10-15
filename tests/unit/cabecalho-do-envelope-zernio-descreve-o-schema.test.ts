import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * O item 4 do #290: a regra escrita no cabeçalho de `lib/channels/zernio/envelope.ts`
 * não era a regra que o schema aplica.
 *
 * O cabeçalho afirmava que só ganha tipo o campo que o código consome sem guarda.
 * O schema, porém, tipa também os campos que os leitores normalizam com
 * `str()`/`obj()` (`./webhook.ts`, `./avisos.ts`) — porque o tipo errado ali vira
 * silêncio (ver o topo do arquivo). A regra foi reescrita para descrever o que o
 * schema FAZ, e deixa sem tipo só o que o leitor aceita em qualquer forma.
 *
 * Este teste existe para a regra declarada e o schema executado não voltarem a
 * divergir em silêncio: ele confere, no CÓDIGO, quais campos o schema deixa sem
 * tipo e exige que o cabeçalho os declare na LINHA MARCADA. Ele não fixa QUAIS
 * campos são: quem deixar outro campo sem tipo, obedecendo à regra, só precisa
 * declará-lo na linha.
 *
 * O COMPORTAMENTO de `attachments` (qualquer forma passa, a mensagem não cai) é
 * medido em `tests/unit/contrato-do-webhook-zernio.test.ts`, no caso
 * "`attachments` torto NÃO derruba a mensagem".
 */

const FONTE = readFileSync("lib/channels/zernio/envelope.ts", "utf8");

/** Campos que o schema deixa `z.unknown()` — os que o leitor aceita em qualquer forma. */
function camposSemTipo(): string[] {
  const nomes: string[] = [];
  for (const linha of FONTE.split("\n")) {
    const m = /^\s*([A-Za-z_]\w*):\s*z\.unknown\(\)/.exec(linha);
    if (m) nomes.push(m[1]!);
  }
  return nomes.sort();
}

/**
 * Os campos que o CABEÇALHO declara sem tipo — lidos da linha marcada, para a
 * declaração ser máquina-conferível em vez de prosa solta.
 */
function declaradosSemTipo(): string[] | null {
  const m = /Sem tipo \(o leitor aceita qualquer forma\):\s*([^\n]*)/.exec(FONTE);
  if (!m) return null;
  return [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!).sort();
}

describe("a regra do cabeçalho descreve o schema do envelope zernio (item 4 do #290)", () => {
  it("o cabeçalho DECLARA, na linha marcada, o mesmo conjunto que o schema deixa sem tipo", () => {
    // Antes do conserto o cabeçalho não tinha linha assim nenhuma: ele afirmava
    // uma regra que o schema não seguia. `null` aqui é o defeito, não borda.
    expect(declaradosSemTipo()).toEqual(camposSemTipo());
  });

  it("o cabeçalho não repete a regra antiga", () => {
    // A frase antiga reservava o tipo ao campo consumido "sem guarda própria" —
    // cópia do modelo dos outros canais, e não o que este schema faz: ele tipa
    // também os campos que `str()`/`obj()` normalizam. É o que o item 4 mandou decidir.
    expect(FONTE).not.toContain("sem guarda própria");
  });
});
