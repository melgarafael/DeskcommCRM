/**
 * Atualizar o CRM não pode desligar o lembrete que o operador ligou.
 *
 * O `update.sh` re-aplica o `baseline.sql` INTEIRO a cada atualização. Qualquer
 * `update` sem guarda que ele contenha roda de novo em toda instalação, em todo
 * update — e um que sobrescreve configuração apaga a escolha de quem opera.
 *
 * Este caso existe porque isso aconteceu de verdade: a 0194 desligava
 * `reminder_enabled` em toda re-aplicação, sem erro, sem log, com a tela
 * mostrando o controle desmarcado como se ninguém o tivesse marcado.
 *
 * ═══ ⚠️ POR QUE AS ASSERÇÕES RODAM SEM COMENTÁRIOS ═══
 *
 * O comentário que descreve uma guarda é, por construção, o texto mais parecido
 * com ela. Sem tirar os comentários, esta suíte passaria com a guarda removida —
 * casando com a prosa que a explica. Já custou caro neste repo.
 *
 * ═══ ⚠️ O QUE ESTE ARQUIVO NÃO PROVA ═══
 *
 * Ele lê TEXTO, e a ordem "lê o default → grava o default" só é conferida
 * dentro do bloco. Um `set default false` num bloco ANTERIOR do baseline deixa
 * os cinco casos verdes com a correção do histórico morta (medido: 5 passed).
 * A prova do comportamento — re-aplicar o baseline inteiro e ler o banco, nos
 * dois sentidos — é `tests/invariants/atualizar-nao-desliga-o-lembrete.test.ts`,
 * no `pnpm test:db`. Este arquivo fica como sinal rápido do `verify`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const baseline = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");

/** Só o SQL executável entra nas asserções. */
function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** O bloco do lembrete, do rótulo dele até o próximo rótulo de apêndice. */
const bloco = (() => {
  const i = baseline.indexOf("-- ---- lembrete nasce desligado");
  expect(i, "o bloco do lembrete sumiu do baseline").toBeGreaterThan(-1);
  const resto = baseline.slice(i + 10);
  const j = resto.indexOf("-- ---- ");
  return semComentarios(resto.slice(0, j === -1 ? undefined : j));
})();

describe("o lembrete sobrevive a um update.sh", () => {
  it("o desligamento em massa está sob guarda, e não solto", () => {
    // A guarda é o `column_default`: pelo VALOR da coluna é impossível separar
    // "ninguém escolheu" de "o operador ligou" — as duas são `true`.
    expect(bloco).toMatch(/column_default/);
    expect(bloco).toMatch(/is distinct from\s+'false'/);
  });

  it("o UPDATE está DENTRO do `if`, não ao lado dele", () => {
    // Uma guarda que existe mas não envolve o update é decoração. Aqui o que se
    // cobra é a ordem do texto executável: `if` ... `update` ... `end if`.
    expect(bloco).toMatch(
      /if v_default is distinct from 'false' then[\s\S]{0,400}update public\.calendar_event_types[\s\S]{0,200}end if;/,
    );
  });

  it("o default é lido ANTES de ser gravado", () => {
    // Invertido, a condição seria sempre falsa e um clone pré-0194 nunca
    // receberia a correção de histórico que a 0194 existe para fazer.
    const posLeitura = bloco.indexOf("select column_default");
    const posEscrita = bloco.indexOf("alter column reminder_enabled set default false");
    expect(posLeitura, "a leitura do default sumiu").toBeGreaterThan(-1);
    expect(posEscrita, "a gravação do default sumiu").toBeGreaterThan(-1);
    expect(posLeitura).toBeLessThan(posEscrita);
  });

  it("o default continua sendo false — nascer ligado inscreveria todo mundo", () => {
    expect(bloco).toMatch(/alter column reminder_enabled set default false/);
  });
});

describe("nenhum outro apêndice desliga configuração em massa sem guarda", () => {
  it("não há `set reminder_enabled = false` solto em lugar nenhum do baseline", () => {
    // Varre o arquivo TODO, não só o bloco: o defeito consertado aqui nasceu de
    // um update que estava no lugar certo e sem guarda, e um segundo igual em
    // outro apêndice teria o mesmo efeito.
    const inteiro = semComentarios(baseline);
    const ocorrencias = [...inteiro.matchAll(/set reminder_enabled = false/g)];
    expect(
      ocorrencias.length,
      "mais de um lugar desliga o lembrete — o segundo não passa pela guarda",
    ).toBe(1);
  });
});
