import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O BANCO ACEITA O AVISO DE MODELO DO CANAL DIRETO (#3635, migration 9327).
 *
 * `agent_inbox_items.kind` tem vocabulário FECHADO por CHECK, e `add constraint`
 * não soma valor: ele SUBSTITUI a constraint inteira. Quem reconstrói a lista
 * sem o valor novo o apaga em silêncio — sem erro de SQL, sem conflito de git —
 * e o aviso passa a ser recusado pelo banco num caminho que engole a falha de
 * propósito (o webhook não pode devolver 5xx, senão a Meta re-entrega o mesmo
 * evento para sempre). Resultado: ninguém vê nem o aviso nem o erro.
 *
 * Por isso os três casos: o valor novo é ACEITO, um inventado é RECUSADO (a
 * cerca continua cerca) e a lista não ENCOLHE. O par com o TypeScript é vigiado
 * por `vocabulario-banco-x-typescript.test.ts`; aqui a régua é o banco sozinho.
 */

const KIND = "channel_template_review_direct";

/** Os valores que o CHECK aceita hoje, lidos do catálogo do Postgres. */
function valoresDoCheck(): string[] {
  const bruto = sql(
    `select pg_get_constraintdef(k.oid)
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
      where k.contype = 'c'
        and c.relname = 'agent_inbox_items'
        and k.conname = 'agent_inbox_items_kind_check'`,
  );
  return [...bruto.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe("o aviso de status do modelo cabe no vocabulário do banco", () => {
  it("o CHECK existe e não veio vazio (controle de vivacidade)", () => {
    // Sem isto, um nome de constraint errado devolveria lista vazia e os casos
    // abaixo passariam sobre nada.
    expect(valoresDoCheck().length).toBeGreaterThan(20);
  });

  it(`aceita '${KIND}'`, () => {
    expect(valoresDoCheck()).toContain(KIND);
  });

  it("recusa um kind inventado — a cerca continua fechada", () => {
    expect(valoresDoCheck()).not.toContain("kind_que_nao_existe");
  });

  it("a lista não encolheu: os valores que já existiam continuam lá", () => {
    // A guarda contra o apagamento silencioso: esta lista só pode CRESCER.
    const antigos = [
      "assinatura_desconectada",
      "aviso_de_caso_nao_entregue",
      "canal_mudo_sem_numero",
      "canal_pausado",
      "channel_number_alert",
      "channel_template_review",
      "cliente_sem_resposta_na_queda",
      "cobranca",
      "email_de_login_trocado",
      "other",
      "recuperacao_da_queda",
      "task_due",
      "task_overdue",
    ];
    const agora = valoresDoCheck();
    expect(antigos.filter((v) => !agora.includes(v))).toEqual([]);
  });
});
