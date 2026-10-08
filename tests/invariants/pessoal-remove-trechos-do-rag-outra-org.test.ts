import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_CONV_UNASSIGNED, GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * O FILTRO DE ORGANIZAÇÃO DA REMOÇÃO DE TRECHOS DO RAG (#2394, migration 0564).
 *
 * Complementa `pessoal-remove-trechos-do-rag.test.ts`. Lá, o trecho da outra
 * organização aponta para uma conversa que não existe, e por isso nenhum
 * `delete` o alcança, nem com `c.organization_id=p_org` removido. Aqui, o
 * trecho da outra organização tem no metadata o id de uma conversa DESTA
 * organização (a do contato 1). Só o filtro de organização o protege.
 *
 * ─── SABOTAGEM (linha para reverter: migration 0564 / apêndice do baseline) ──
 * - `delete` sem `c.organization_id=p_org`: a função apaga o trecho da outra
 *   organização (devolve 2 em vez de 1) e o retriever dela fica vazio.
 */

const VETOR = `(select array_fill(0.1::real, array[1536])::vector)`;

const AGENTE = "dddd3333-1111-4000-8000-000000000003";
const FONTE = "dddd3333-3333-4000-8000-000000000003";
const VERSAO = "dddd3333-2222-4000-8000-000000000003";

const OUTRA_ORG = "dddd3333-0000-4000-8000-000000000004";
const OUTRA_AGENTE = "dddd3333-1111-4000-8000-000000000004";
const OUTRA_FONTE = "dddd3333-3333-4000-8000-000000000004";
const OUTRA_VERSAO = "dddd3333-2222-4000-8000-000000000004";
const TRECHO_VIZINHO = "trecho vizinho que aponta para a conversa do contato 1";

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
      values ('${OUTRA_ORG}', 'gov-inv-2394-org', 'Gov Invariant 2394 org', 'Gov 2394 org')
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
         'trecho da conversa do contato 1', 'h-2394-org-a', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_UNASSIGNED}')),
        ('${OUTRA_ORG}', '${OUTRA_FONTE}', '${OUTRA_VERSAO}', 0,
         '${TRECHO_VIZINHO}', 'h-2394-org-b', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_UNASSIGNED}'));
  `);
});

describe("contato pessoal: a remoção de trechos do RAG não atravessa organização (#2394)", () => {
  it("o trecho de outra organização que aponta para uma conversa daqui fica", () => {
    expect(trechosDaOutraOrg()).toEqual([TRECHO_VIZINHO]);

    const removidos = sql(
      `select public.fn_contato_pessoal_remove_trechos_do_rag('${GOV_ORG}', '${GOV_CONTACT_1}');`,
    ).trim();
    expect(removidos).toBe("1");

    expect(trechosDaOutraOrg()).toEqual([TRECHO_VIZINHO]);
    expect(
      sql(`select count(*) from public.ai_chunks where organization_id = '${OUTRA_ORG}';`).trim(),
    ).toBe("1");
  });
});
