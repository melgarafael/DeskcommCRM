import { beforeAll, describe, expect, it } from "vitest";

import { redigirToolCalls } from "@/lib/lgpd/cascata";

import { sql } from "./gov-helpers";

/**
 * A CASCATA DO BANCO REDIGE AS QUATRO FONTES DA APP QUANDO is_anonymized VIRA TRUE (issue #1964).
 *
 * ─── O que este arquivo prova, e por que não é um censo ─────────────────────
 * O `lgpd-redact-unificado-alcanca-pelo-catalogo` prova, pelo CATÁLOGO de FKs e
 * pelo corpo instalado de `fn_redigir_conversas_ao_anonimizar`, que
 * `lead_notes`, `ai_agent_runs`, `lead_state` e `contacts.social_identity` têm
 * decisão `redigir` (gatilho da virada). Símbolo no corpo mostra INTENÇÃO; este
 * arquivo prova o EFEITO PELO COMPORTAMENTO, na transação da virada:
 *
 *   lead_notes.headline / body  → '(anonimizado)', embedding → null
 *   ai_agent_runs.tool_calls    → redigido preservando o nome da ferramenta
 *   lead_state.next_action      → null, qualification → '{}'
 *   contacts.social_identity    → null
 *
 * O gatilho (`trg_redigir_conversas_ao_anonimizar`, desenho da 0391) é a porta
 * que os DOIS caminhos de anonimização cruzam — o pedido formal e o botão da
 * ficha — e é o que alcança também um `update` DIRETO de is_anonymized no banco,
 * que é justamente o vazamento que a app não cobre.
 *
 * ─── Por que POR COMPORTAMENTO, não pelo símbolo ────────────────────────────
 * O modo de falha da LGPD é devolver SUCESSO com a linha legível. Um teste que
 * lê o corpo da função passa quando alguém acrescenta a linha e falha quando
 * ela sai — mas não prova que a redação e os guards funcionam (filtro org×contato,
 * idempotência, `[]` de nascença não tocado). Aqui a prova é feita no banco real.
 */

const ORG = "1964a000-0000-4000-8000-00000000000a";
/** Contato que vamos ANONIMIZAR pela virada direta (sem a app). */
const ALVO = "1964a000-1111-4000-8000-000000000001";
/** Vizinho na MESMA org que NÃO é anonimizado — prova de que o filtro é por contato. */
const VIZINHO = "1964a000-1111-4000-8000-000000000002";
/** Contato de OUTRA organização — prova de que o filtro é por org também. */
const OUTRA_ORG = "1964a000-2222-4000-8000-00000000000a";
const OUTRA_ORG_CONTATO = "1964a000-1111-4000-8000-000000000003";

const AGENTE = "1964a000-3333-4000-8000-000000000001";
const AGENTE_VERSAO = "1964a000-4444-4000-8000-000000000001";
const SESS = "1964a000-5555-4000-8000-000000000001";

/** SDK de acesso SQL no container de teste (mesma forma do 0391). */
beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'lgpd-cascata-banco-1964', 'LGPD Cascata Banco', 'LGPD Cascata Banco'),
           ('${OUTRA_ORG}', 'lgpd-cascata-banco-outra-1964', 'Outra Org', 'Outra Org')
    on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name, display_name, social_identity)
    values
      ('${ALVO}',   '${ORG}',        'Bruno Silva Alvo',  'Bruno Silva Alvo',  'wa:5511999990000'),
      ('${VIZINHO}', '${ORG}',        'Carlos Vizinho',    'Carlos Vizinho',    'wa:5511888880000'),
      ('${OUTRA_ORG_CONTATO}', '${OUTRA_ORG}', 'Diana Outra', 'Diana Outra', 'wa:557777000')
    on conflict (id) do nothing;

    -- Sessão de canal, agente e versão que as runs do experimento referenciam
    -- (FKs obrigatórias de ai_agent_runs / ai_agent_versions).
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
    values ('${SESS}', '${ORG}', 'lgpd-1964-sess', '\\x00'::bytea)
    on conflict (id) do nothing;

    insert into public.ai_agents (id, organization_id, name, model, system_prompt)
    values ('${AGENTE}', '${ORG}', 'Agente LGPD 1964', 'anthropic/claude-sonnet-4-6', 'agente de teste')
    on conflict (id) do nothing;

    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
    values ('${AGENTE_VERSAO}', '${ORG}', '${AGENTE}', 1, 'agente de teste', 'anthropic',
            'anthropic/claude-sonnet-4-6', '${SESS}', 'published')
    on conflict (id) do nothing;

    -- O vizinho do contato e o de outra org guardam o MESMO texto crú: só as
    -- linhas do ALVO podem sair redigidas.
    insert into public.lead_notes (organization_id, contact_id, headline, body)
    select c.organization_id, c.id, 'memória sobre Bruno', 'nome do contato: Bruno, fetch via crm_get_lead'
      from public.contacts c where c.id in ('${ALVO}', '${VIZINHO}', '${OUTRA_ORG_CONTATO}');

    insert into public.lead_state (organization_id, contact_id, stage, next_action, qualification)
    select c.organization_id, c.id, 'qualifying',
           'ligar para Bruno confirmar orçamento',
           '{"orçamento":"telhado","contato":"Bruno"}'::jsonb
      from public.contacts c where c.id in ('${ALVO}', '${VIZINHO}', '${OUTRA_ORG_CONTATO}')
    on conflict (organization_id, contact_id) do nothing;

    insert into public.ai_agent_runs
      (id, organization_id, agent_id, agent_version_id, contact_id, status, tool_calls)
    select gen_random_uuid(), c.organization_id, '${AGENTE}', '${AGENTE_VERSAO}', c.id, 'completed',
           jsonb_build_array(jsonb_build_object(
             'step', 1,
             'text', 'buscando lead de Bruno',
             'tool_calls', jsonb_build_array(
               jsonb_build_object('tool_name', 'crm_get_lead', 'args', jsonb_build_object('name', 'Bruno')),
               jsonb_build_object('tool_name', 'crm_create_activity', 'args', jsonb_build_object('note', 'cliente Bruno quer orçamento'))
             )
           ))
      from public.contacts c where c.id in ('${ALVO}', '${VIZINHO}', '${OUTRA_ORG_CONTATO}');
  `);
});

/** head, body, embedding do lead_notes do contato — um campo por linha. */
function notaDo(contato: string): string {
  return sql(`
    select coalesce(headline,'<null>') || '|'
        || coalesce(body,'<null>') || '|'
        || coalesce(embedding::text,'<null>')
      from public.lead_notes where contact_id = '${contato}';
  `);
}

/** next_action e stage do lead_state do contato. */
function estadoDo(contato: string): string {
  return sql(`
    select coalesce(next_action::text,'<null>') || '|' || qualification::text
      from public.lead_state where contact_id = '${contato}';
  `);
}

/** tool_calls do contato (todos os runs). */
function toolCallsDo(contato: string): string {
  return sql(`
    select coalesce(string_agg(tool_calls::text, ';' order by id), '<vazio>')
      from public.ai_agent_runs where contact_id = '${contato}';
  `);
}

function socialDo(contato: string): string {
  return sql(`select coalesce(social_identity::text,'<null>') from public.contacts where id = '${contato}';`);
}

/** Vira is_anonymized no banco, no caminho que a app NÃO cobre: update direto. */
function virarAnonymized(contato: string): void {
  sql(`update public.contacts set is_anonymized = true, anonymized_at = now()
        where id = '${contato}' and organization_id = '${ORG}';`);
}

describe("LGPD: a cascata do banco alcança as quatro fontes na virada de is_anonymized", () => {
  it("o gatilho da virada (0391) está instalado e ativo, e alcança as 4 tabelas", () => {
    expect(sql(`
      select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'contacts'
         and t.tgname = 'trg_redigir_conversas_ao_anonimizar'
         and not t.tgisinternal
         and t.tgenabled <> 'D';
    `)).toBe("1");
    expect(sql(`
      select count(*) from pg_proc p
       where p.proname = 'fn_redigir_conversas_ao_anonimizar'
         and p.pronamespace = 'public'::regnamespace;
    `)).toBe("1");
  });

  it("antes da virada os três contatos guardam o MESMO texto — o experimento tem massa", () => {
    expect(notaDo(ALVO)).toBe("memória sobre Bruno|nome do contato: Bruno, fetch via crm_get_lead|<null>");
    expect(notaDo(VIZINHO)).toBe(notaDo(ALVO));
    expect(notaDo(OUTRA_ORG_CONTATO)).toBe(notaDo(ALVO));
    expect(estadoDo(ALVO)).toContain("ligar para Bruno confirmar orçamento");
    expect(toolCallsDo(ALVO)).toContain("crm_get_lead");
    expect(socialDo(ALVO)).toBe("wa:5511999990000");
  });

  it("virar is_anonymized (update direto, sem a app) redige as quatro fontes do ALVO", () => {
    virarAnonymized(ALVO);

    expect(notaDo(ALVO)).toBe("(anonimizado)|(anonimizado)|<null>");
    // tool_calls: preserva o NOME das ferramentas, apaga args/results, redacted = true.
    const tc = toolCallsDo(ALVO);
    expect(tc).toContain('"tool_name": "crm_get_lead"');
    expect(tc).toContain('"redacted": true');
    expect(tc).not.toContain("Bruno");
    expect(tc).not.toContain("telhado");
    expect(tc).not.toContain('"args"');

    expect(estadoDo(ALVO)).toContain("<null>|{}");
    expect(socialDo(ALVO)).toBe("<null>");
  });

  it("o vizinho na MESMA org e o de OUTRA org ficam INTACTOS — filtro org×contato", () => {
    expect(notaDo(VIZINHO)).toBe("memória sobre Bruno|nome do contato: Bruno, fetch via crm_get_lead|<null>");
    expect(notaDo(OUTRA_ORG_CONTATO)).toBe("memória sobre Bruno|nome do contato: Bruno, fetch via crm_get_lead|<null>");
    expect(estadoDo(VIZINHO)).toContain("ligar para Bruno confirmar orçamento");
    expect(estadoDo(OUTRA_ORG_CONTATO)).toContain("ligar para Bruno confirmar orçamento");
    expect(toolCallsDo(VIZINHO)).toContain("crm_get_lead");
    expect(toolCallsDo(VIZINHO)).toContain("Bruno");
    expect(toolCallsDo(OUTRA_ORG_CONTATO)).toContain("crm_get_lead");
    expect(socialDo(VIZINHO)).toBe("wa:5511888880000");
    expect(socialDo(OUTRA_ORG_CONTATO)).toBe("wa:557777000");
  });

  it("idempotente: a segunda virada não toca nada (guard do WHERE não reescreve)", () => {
    // Alvo já redigido; atravessar de novo o gatilho (UPDATE em contacts) não muda nada.
    virarAnonymized(ALVO);
    expect(notaDo(ALVO)).toBe("(anonimizado)|(anonimizado)|<null>");
    expect(toolCallsDo(ALVO)).not.toContain("Bruno");
    expect(socialDo(ALVO)).toBe("<null>");
  });

  it("o espelho SQL de redigirToolCalls devolve o MESMO jsonb que a app", () => {
    // Se os dois divergirem, a varredura diária da app (toolCallsPendentes) e o
    // gatilho do banco discordam sobre o que é "já redigido" e reescrevem um ao
    // outro. Entradas bem formadas, na forma de lib/ai/runtime/serialize.ts.
    const entradas: unknown[] = [
      [],
      [{ step: 1, text: "buscando Bruno", tool_calls: [{ tool_name: "crm_get_lead", args: { name: "Bruno" } }] }],
      [
        { step: 2, tool_name: "responder", tool_calls: [] },
        { text: "sem step", tool_calls: [{ args: { x: 1 } }, { tool_name: "crm_create_activity" }] },
        { step: 3 },
      ],
    ];
    for (const entrada of entradas) {
      const literal = JSON.stringify(entrada).replace(/'/g, "''");
      const doBanco: unknown = JSON.parse(
        sql(`select public.fn_lgpd_redigir_tool_calls('${literal}'::jsonb)::text;`).trim(),
      );
      expect(doBanco).toEqual(redigirToolCalls(entrada));
    }
  });
});
