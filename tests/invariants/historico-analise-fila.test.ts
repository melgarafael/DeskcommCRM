import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A análise do histórico importado (PR #4152, de @bestbill) com as três travas
 * da decisão 315 (alternativa A), medidas no Postgres do baseline:
 *
 *   1. a CONTAGEM e a estimativa existem antes da análise (`fn_previa_historico_analise`);
 *   2. o TETO por rodada vale no banco (`p_limite`), e o resto fica para a próxima;
 *   3. quem RECUSOU IA não entra, e quem tem estado MAIS NOVO que o histórico não
 *      é sobrescrito (`fn_historico_analise_motivo_para_pular`, a régua única).
 *
 * Organizações próprias, com ids aleatórios: o fixture `gov` é compartilhado
 * com outros arquivos que mexem nas marcas do contato, e esta suíte precisa
 * delas sob controle.
 */

const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
const SESSAO = randomUUID();
const SESSAO_OUTRA = randomUUID();
const IMPORTACAO = randomUUID();
const IMPORTACAO_OUTRA = randomUUID();

// Três contatos liberados, do mais antigo ao mais recente.
const C1 = randomUUID();
const C2 = randomUUID();
const C3 = randomUUID();
// Os que recusaram IA, um por sinal.
const RECUSAS = {
  ai_opt_out: randomUUID(),
  bloqueado: randomUUID(),
  pessoal: randomUUID(),
  consentimento_ia_recusado: randomUUID(),
  perfilamento_recusado: randomUUID(),
};
// Os que já têm estado mais novo que o histórico importado.
const NOVO_LEAD_STATE = randomUUID();
const NOVO_CHECKPOINT = randomUUID();
const C_OUTRA = randomUUID();

const TEXTO = "x".repeat(400);

interface Contato {
  id: string;
  colunas: string;
  valores: string;
  diasAtras: number;
}

const contatos: Contato[] = [
  { id: C1, colunas: "", valores: "", diasAtras: 3 },
  { id: C2, colunas: "", valores: "", diasAtras: 2 },
  { id: C3, colunas: "", valores: "", diasAtras: 1 },
  { id: RECUSAS.ai_opt_out, colunas: ", ai_opt_out", valores: ", true", diasAtras: 1 },
  { id: RECUSAS.bloqueado, colunas: ", is_blocked", valores: ", true", diasAtras: 1 },
  { id: RECUSAS.pessoal, colunas: ", is_personal", valores: ", true", diasAtras: 1 },
  {
    id: RECUSAS.consentimento_ia_recusado,
    colunas: ", consent",
    valores: `, '{"automated_service":{"declined_at":"2026-01-01T00:00:00Z","source":"formulario"}}'::jsonb`,
    diasAtras: 1,
  },
  {
    id: RECUSAS.perfilamento_recusado,
    colunas: ", consent",
    valores: `, '{"profiling":{"granted":false}}'::jsonb`,
    diasAtras: 1,
  },
  { id: NOVO_LEAD_STATE, colunas: "", valores: "", diasAtras: 5 },
  { id: NOVO_CHECKPOINT, colunas: "", valores: "", diasAtras: 5 },
];

function semear(org: string, sessao: string, importacao: string, lista: Contato[]): string {
  return lista
    .map((c) => {
      const conversa = randomUUID();
      const mensagem = randomUUID();
      return `
        insert into public.contacts (id, organization_id, display_name${c.colunas})
          values ('${c.id}', '${org}', 'Histórico ${c.id.slice(0, 8)}'${c.valores});
        insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
          values ('${conversa}', '${org}', '${c.id}', '${sessao}', 'open');
        insert into public.messages
          (id, organization_id, conversation_id, channel_session_id, contact_id, external_id,
           type, direction, status, sent_via, body, sent_at, metadata)
        values
          ('${mensagem}', '${org}', '${conversa}', '${sessao}', '${c.id}', 'hist-${mensagem}',
           'text', 'inbound', 'received', 'external_device', '${TEXTO}',
           now() - interval '${c.diasAtras} days',
           jsonb_build_object('historico_importado', 'true', 'importacao_id', '${importacao}'));`;
    })
    .join("\n");
}

const previa = (org: string, importacao: string, limite: number) =>
  JSON.parse(sql(`select public.fn_previa_historico_analise('${org}', '${importacao}', ${limite});`)) as Record<
    string,
    number | null
  >;
const enfileirar = (org: string, importacao: string, limite: number) =>
  sql(`select public.fn_enqueue_historico_analise('${org}', '${importacao}', ${limite});`);
const contatosNaFila = (org: string) =>
  sql(`select coalesce(string_agg(contact_id::text, ',' order by contact_id), '')
         from public.job_queue
        where organization_id = '${org}' and kind = 'history_analysis';`)
    .split(",")
    .filter(Boolean);

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'hist-${ORG.slice(0, 8)}', 'Histórico Invariante', 'Histórico'),
           ('${OUTRA_ORG}', 'hist-${OUTRA_ORG.slice(0, 8)}', 'Histórico Outra', 'Histórico Outra');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
    values ('${SESSAO}', '${ORG}', 'hist-${SESSAO.slice(0, 8)}', '\\x00'::bytea),
           ('${SESSAO_OUTRA}', '${OUTRA_ORG}', 'hist-${SESSAO_OUTRA.slice(0, 8)}', '\\x00'::bytea);
    insert into public.importacoes_de_historico (id, organization_id, channel_session_id, status, dias, origem)
    values ('${IMPORTACAO}', '${ORG}', '${SESSAO}', 'concluida', 30, 'manual'),
           ('${IMPORTACAO_OUTRA}', '${OUTRA_ORG}', '${SESSAO_OUTRA}', 'concluida', 30, 'manual');
    ${semear(ORG, SESSAO, IMPORTACAO, contatos)}
    ${semear(OUTRA_ORG, SESSAO_OUTRA, IMPORTACAO_OUTRA, [{ id: C_OUTRA, colunas: "", valores: "", diasAtras: 1 }])}
    -- Estado gravado DEPOIS da última mensagem importada: o agente ao vivo já
    -- qualificou este contato, ou já fechou um checkpoint dele.
    insert into public.lead_state (organization_id, contact_id, stage, qualification, updated_at)
    values ('${ORG}', '${NOVO_LEAD_STATE}', 'qualifying', '{"need":"mais novo"}'::jsonb, now());
    insert into public.lead_checkpoints (organization_id, contact_id, rolling_summary)
    values ('${ORG}', '${NOVO_CHECKPOINT}', 'resumo mais novo');
  `);
});

describe("trava 3: a régua única de quem a análise não lê", () => {
  it("quem recusou IA, por qualquer um dos sinais, é 'recusou_ia'", () => {
    for (const [sinal, id] of Object.entries(RECUSAS)) {
      expect(
        sql(`select public.fn_historico_analise_motivo_para_pular('${ORG}', '${id}', '${IMPORTACAO}');`),
        sinal,
      ).toBe("recusou_ia");
    }
  });

  it("lead_state ou checkpoint mais novo que o histórico é 'estado_mais_novo'", () => {
    for (const id of [NOVO_LEAD_STATE, NOVO_CHECKPOINT]) {
      expect(sql(`select public.fn_historico_analise_motivo_para_pular('${ORG}', '${id}', '${IMPORTACAO}');`)).toBe(
        "estado_mais_novo",
      );
    }
  });

  it("contato liberado não tem motivo (controle positivo)", () => {
    expect(
      sql(`select coalesce(public.fn_historico_analise_motivo_para_pular('${ORG}', '${C1}', '${IMPORTACAO}'), 'liberado');`),
    ).toBe("liberado");
  });
});

describe("trava 1: a contagem e a estimativa vêm antes de qualquer análise", () => {
  it("a prévia conta a rodada, o que sobra e os pulados, sem enfileirar nada", () => {
    expect(previa(ORG, IMPORTACAO, 2)).toMatchObject({
      nesta_rodada: 2,
      restantes: 1,
      pulados_recusa: 5,
      pulados_mais_novos: 2,
      em_andamento: 0,
      teto_da_rodada: 2,
      estimativa_cents: null,
      teto_mensal_cents: null,
    });
    expect(contatosNaFila(ORG)).toEqual([]);
  });

  it("com gasto de IA registrado, a estimativa usa o custo por token e o teto de saída", () => {
    // 10 centavos por 1000 tokens = 0,01 por token. Rodada de 2: 800 caracteres
    // (200 tokens) + 2 × 4000 = 8200 tokens → 82 centavos.
    sql(`insert into public.llm_calls (organization_id, purpose, provider, model, input_tokens, output_tokens, cost_cents)
         values ('${ORG}', 'checkpoint', 'anthropic', 'modelo-de-teste', 800, 200, 10);`);
    const p = previa(ORG, IMPORTACAO, 2);
    expect(Number(p.estimativa_cents)).toBe(82);
    expect(Number(p.gasto_do_mes_cents)).toBe(10);
  });
});

describe("trava 2: o teto por rodada vale no banco", () => {
  it("enfileira só o limite, a conversa mais recente primeiro, e nunca quem foi pulado", () => {
    expect(enfileirar(ORG, IMPORTACAO, 2)).toBe("2");
    expect(contatosNaFila(ORG)).toEqual([C2, C3].sort());
  });

  it("o resto fica para a próxima rodada, e a rodada em andamento aparece na prévia", () => {
    expect(previa(ORG, IMPORTACAO, 2)).toMatchObject({ nesta_rodada: 1, restantes: 0, em_andamento: 2 });
    expect(enfileirar(ORG, IMPORTACAO, 2)).toBe("1");
    expect(contatosNaFila(ORG)).toEqual([C1, C2, C3].sort());
    expect(enfileirar(ORG, IMPORTACAO, 2)).toBe("0");
  });

  it("limite zero não enfileira nada", () => {
    expect(enfileirar(ORG, IMPORTACAO, 0)).toBe("0");
  });

  it("falha terminal volta a pending dentro do teto, sem duplicar a linha", () => {
    sql(`update public.job_queue set status = 'dead', attempts = 3, last_error = 'sem PII'
          where organization_id = '${ORG}' and kind = 'history_analysis' and contact_id in ('${C1}', '${C3}');`);
    expect(enfileirar(ORG, IMPORTACAO, 1)).toBe("1");
    expect(
      sql(`select status || '|' || attempts from public.job_queue
            where organization_id = '${ORG}' and kind = 'history_analysis' and contact_id = '${C3}';`),
    ).toBe("pending|0");
    expect(
      sql(`select status from public.job_queue
            where organization_id = '${ORG}' and kind = 'history_analysis' and contact_id = '${C1}';`),
    ).toBe("dead");
    expect(contatosNaFila(ORG)).toHaveLength(3);
  });
});

describe("resumo e gasto real", () => {
  it("conta por estado e soma o gasto dos jobs desta importação, sem texto", () => {
    sql(`insert into public.llm_calls (organization_id, contact_id, job_id, purpose, provider, model, input_tokens, output_tokens, cost_cents)
         select organization_id, contact_id, id, 'checkpoint', 'anthropic', 'modelo-de-teste', 100, 100, 5
           from public.job_queue
          where organization_id = '${ORG}' and kind = 'history_analysis' and contact_id = '${C2}';`);
    const resumo = JSON.parse(sql(`select public.fn_resumo_historico_analise('${ORG}', '${IMPORTACAO}');`));
    expect(resumo).toMatchObject({ total: 3, pending: 2, dead: 1 });
    expect(Number(resumo.gasto_cents)).toBe(5);
    expect(Object.keys(resumo).sort()).toEqual(["dead", "done", "failed", "gasto_cents", "pending", "running", "total"]);
  });
});

describe("isolamento entre organizações", () => {
  it("a importação de uma organização não é vista nem enfileirada pela outra", () => {
    expect(previa(OUTRA_ORG, IMPORTACAO, 50)).toMatchObject({ nesta_rodada: 0, restantes: 0, pulados_recusa: 0 });
    expect(enfileirar(OUTRA_ORG, IMPORTACAO, 50)).toBe("0");
    expect(JSON.parse(sql(`select public.fn_resumo_historico_analise('${OUTRA_ORG}', '${IMPORTACAO}');`))).toMatchObject({
      total: 0,
      gasto_cents: 0,
    });
    expect(sql(`select public.fn_historico_analise_motivo_para_pular('${OUTRA_ORG}', '${C1}', '${IMPORTACAO}');`)).toBe(
      "sem_contato",
    );
    expect(contatosNaFila(OUTRA_ORG)).toEqual([]);
  });

  it("enfileirar a outra organização não toca na primeira", () => {
    expect(enfileirar(OUTRA_ORG, IMPORTACAO_OUTRA, 50)).toBe("1");
    expect(contatosNaFila(OUTRA_ORG)).toEqual([C_OUTRA]);
    expect(contatosNaFila(ORG)).toHaveLength(3);
  });
});

describe("contrato da fila e privilégios", () => {
  it("o kind exige contato", () => {
    expect(() =>
      sql(`insert into public.job_queue (organization_id, kind, payload) values ('${ORG}', 'history_analysis', '{}');`),
    ).toThrow(/job_queue_turn_needs_contact/);
  });

  it("nenhuma das funções é RPC alcançável pela sessão; o service_role as executa", () => {
    for (const assinatura of [
      "public.fn_historico_analise_motivo_para_pular(uuid,uuid,uuid)",
      "public.fn_historico_analise_candidatos(uuid,uuid)",
      "public.fn_previa_historico_analise(uuid,uuid,integer)",
      "public.fn_enqueue_historico_analise(uuid,uuid,integer)",
      "public.fn_resumo_historico_analise(uuid,uuid)",
    ]) {
      expect(
        sql(`select has_function_privilege('anon', '${assinatura}', 'execute'),
                    has_function_privilege('authenticated', '${assinatura}', 'execute'),
                    has_function_privilege('service_role', '${assinatura}', 'execute');`),
        assinatura,
      ).toBe("f|f|t");
    }
  });
});
