import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_CONTACT_1,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * O CONTATO PESSOAL TIRA OS TRECHOS JÁ INGERIDOS DO RAG (#2394, migration 0564).
 *
 * A rota do marcar zerava `conversations.usable_for_rag` — o que só impede
 * ingestões FUTURAS — e os `ai_chunks` já gravados continuavam alcançáveis por
 * `retrieve_top_k_chunks`, que filtra só organização e versão. O agente podia
 * trazer como conhecimento um trecho da conversa que alguém tirou da operação.
 *
 * O que este arquivo prova, contra o Postgres do baseline:
 *  1. o trecho do contato marcado é ALCANÇÁVEL antes e SAI de alcance depois da
 *     remoção — o par que a issue pede;
 *  2. o recorte é do CONTATO: o trecho do contato vizinho, na mesma organização,
 *     fica; o de OUTRA organização também;
 *  3. a contagem real volta (`row_count`) e a segunda chamada devolve 0 —
 *     idempotente.
 *
 * ─── SABOTAGEM (prova no CI; linha para reverter: migration 0564) ────────────
 * - `delete` sem o join com `conversations`/`contact_id`: cai o caso 2 (leva os
 *   trechos dos vizinhos e de outra organização).
 * - `delete` sem `metadata->>'conversation_id'`: cai o caso 2 (leva a fonte
 *   inteira, com trechos de outros contatos).
 * - Devolver 0 fixo em vez de `row_count`: cai o caso 3 (a contagem real).
 *
 * GOV_CONV_UNASSIGNED é do GOV_CONTACT_1 e GOV_CONV_AGENT_B é do GOV_CONTACT_2
 * (seedGov) — o par alvo/vizinho que o recorte precisa distinguir.
 */

const VETOR = `(select array_fill(0.1::real, array[1536])::vector)`;

const AGENTE = "dddd3333-1111-4000-8000-000000000001";
const FONTE = "dddd3333-3333-4000-8000-000000000001";
const VERSAO = "dddd3333-2222-4000-8000-000000000001";

const OUTRA_ORG = "dddd3333-0000-4000-8000-000000000002";
const OUTRA_AGENTE = "dddd3333-1111-4000-8000-000000000002";
const OUTRA_FONTE = "dddd3333-3333-4000-8000-000000000002";
const OUTRA_VERSAO = "dddd3333-2222-4000-8000-000000000002";
/** Conversa que só existe no metadata do trecho da OUTRA organização. */
const OUTRA_CONV = "dddd3333-4444-4000-8000-000000000002";

function trechosDaOrg(): string[] {
  return sql(
    `select content from public.retrieve_top_k_chunks('${GOV_ORG}', '${VERSAO}', ${VETOR}, 10, -1) order by content;`,
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function trechosDaOutraOrg(): string[] {
  return sql(
    `select content from public.retrieve_top_k_chunks('${OUTRA_ORG}', '${OUTRA_VERSAO}', ${VETOR}, 10, -1) order by content;`,
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'gov-inv-2394', 'Gov Invariant 2394', 'Gov 2394')
      on conflict do nothing;
    insert into public.ai_agents (id, organization_id, name, system_prompt, kind, is_default)
      values ('${AGENTE}', '${GOV_ORG}', 'Agente do RAG', 'p', 'mcp_agent', false),
             ('${OUTRA_AGENTE}', '${OUTRA_ORG}', 'Agente vizinho', 'p', 'mcp_agent', false)
      on conflict do nothing;
    insert into public.ai_knowledge_sources
      (id, organization_id, agent_id, source_type, name, status, is_active)
      values ('${FONTE}', '${GOV_ORG}', null, 'documento', 'Conversas (prova)', 'ready', true),
             ('${OUTRA_FONTE}', '${OUTRA_ORG}', null, 'documento', 'Conversas vizinhas', 'ready', true)
      on conflict do nothing;
    insert into public.ai_knowledge_versions
      (id, organization_id, agent_id, knowledge_source_id, version_number, status, is_active)
      values ('${VERSAO}', '${GOV_ORG}', '${AGENTE}', null, 1, 'ready', true),
             ('${OUTRA_VERSAO}', '${OUTRA_ORG}', '${OUTRA_AGENTE}', null, 1, 'ready', true)
      on conflict do nothing;
    insert into public.ai_chunks
      (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding, metadata)
      values
        ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 0,
         'trecho A da conversa do contato 1', 'h-2394-a', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_UNASSIGNED}')),
        ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 1,
         'trecho B da conversa do contato 1', 'h-2394-b', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_UNASSIGNED}')),
        ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 2,
         'trecho da conversa do contato 2', 'h-2394-c', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_AGENT_B}')),
        ('${OUTRA_ORG}', '${OUTRA_FONTE}', '${OUTRA_VERSAO}', 0,
         'trecho da organização vizinha', 'h-2394-d', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${OUTRA_CONV}'));
  `);
});

describe("contato pessoal: trechos já ingeridos saem do RAG (#2394)", () => {
  it("o trecho do contato marcado é alcançável antes e sai de alcance depois; vizinho e outra organização ficam", () => {
    expect(trechosDaOrg()).toEqual([
      "trecho A da conversa do contato 1",
      "trecho B da conversa do contato 1",
      "trecho da conversa do contato 2",
    ]);
    expect(trechosDaOutraOrg()).toEqual(["trecho da organização vizinha"]);

    const removidos = sql(
      `select public.fn_contato_pessoal_remove_trechos_do_rag('${GOV_ORG}', '${GOV_CONTACT_1}');`,
    ).trim();
    expect(removidos).toBe("2");

    // O par que a issue pede: o que era alcançável saiu; o que é dos outros ficou.
    expect(trechosDaOrg()).toEqual(["trecho da conversa do contato 2"]);
    expect(trechosDaOutraOrg()).toEqual(["trecho da organização vizinha"]);
    expect(
      sql(`select count(*) from public.ai_chunks where organization_id = '${GOV_ORG}';`).trim(),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.ai_chunks where organization_id = '${OUTRA_ORG}';`).trim(),
    ).toBe("1");
  });

  it("idempotente: a segunda chamada devolve 0", () => {
    const removidos = sql(
      `select public.fn_contato_pessoal_remove_trechos_do_rag('${GOV_ORG}', '${GOV_CONTACT_1}');`,
    ).trim();
    expect(removidos).toBe("0");
    expect(trechosDaOrg()).toEqual(["trecho da conversa do contato 2"]);
  });
});
