import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

/**
 * Eixo 4 / G5-02 — worker de roteamento via event_log (AT-03, spec 13 §5).
 *
 * Camada TRANSACIONAL (o que toca trigger/fn/tx): prova no Postgres descartável
 * que (a) a ENTRADA na fila emite conversation.routing_requested, (b) o trigger
 * NÃO emite quando a conversa nasce com dono / fechada-bot, (c) o assign via
 * fn_conversation_assign(reason='routing') é atômico + idempotente (replay não
 * duplica), e (d) ANTI-ECO: o UPDATE de atribuição do worker NÃO re-emite o
 * evento (senão loop infinito). A lógica de decisão (modo/rodízio/backoff) é
 * testada por unit puro em lib/routing/decide.test.ts.
 *
 * Namespace 4040/3040 (não colide com o cccc-4444/3333 do gov-helpers nem com
 * os demais arquivos de invariante paralelos).
 */

// Conversas novas SEM dono numa fila aberta ⇒ o trigger deve emitir.
const CONV_NEW = "cccccccc-4040-4000-8000-000000000001";
// Conversa criada JÁ com dono ⇒ não entra na fila ⇒ não emite.
const CONV_ASSIGNED = "cccccccc-4040-4000-8000-000000000002";
// Conversa nova sob a IA (ai_handling) ⇒ não entra na fila humana ⇒ não emite.
const CONV_AI = "cccccccc-4040-4000-8000-000000000003";
// Conversa usada no fluxo assign + replay (idempotência + anti-eco).
const CONV_IDEM = "cccccccc-4040-4000-8000-000000000004";

const CONTACT = (n: number) => `cccccccc-3040-4000-8000-00000000000${n}`;

function routingEventCount(conversationId: string): number {
  return Number(
    sql(
      `select count(*) from public.event_log
        where event_type = 'conversation.routing_requested'
          and (payload->>'conversation_id') = '${conversationId}';`,
    ),
  );
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTACT(1)}', '${GOV_ORG}', 'Routing Contact 1'),
      ('${CONTACT(2)}', '${GOV_ORG}', 'Routing Contact 2'),
      ('${CONTACT(3)}', '${GOV_ORG}', 'Routing Contact 3'),
      ('${CONTACT(4)}', '${GOV_ORG}', 'Routing Contact 4')
      on conflict do nothing;

    -- Nova, sem dono, fila aberta ⇒ trigger emite.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_NEW}', '${GOV_ORG}', '${CONTACT(1)}', '${GOV_SESSION}', 'open')
      on conflict do nothing;

    -- Criada JÁ com dono ⇒ WHEN do trigger falso ⇒ não emite.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assignee_kind, assigned_at)
      values ('${CONV_ASSIGNED}', '${GOV_ORG}', '${CONTACT(2)}', '${GOV_SESSION}', 'claimed', '${GOV_AGENT_B}', 'user', now())
      on conflict do nothing;

    -- Nova sob a IA (ai_handling) ⇒ não é fila humana ⇒ não emite.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_AI}', '${GOV_ORG}', '${CONTACT(3)}', '${GOV_SESSION}', 'ai_handling')
      on conflict do nothing;

    -- Conversa do fluxo idempotência/anti-eco: nasce na fila (emite 1x).
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_IDEM}', '${GOV_ORG}', '${CONTACT(4)}', '${GOV_SESSION}', 'open')
      on conflict do nothing;

    -- Assign do worker: 2x o MESMO evento (replay). expected=null + enforce ⇒ só
    -- atribui enquanto sem dono; a 2ª chamada (já com dono) retorna 0 rows.
    select 1 from public.fn_conversation_assign('${GOV_ORG}', '${CONV_IDEM}', '${GOV_AGENT_A}', 'routing', null, true);
    select 1 from public.fn_conversation_assign('${GOV_ORG}', '${CONV_IDEM}', '${GOV_AGENT_A}', 'routing', null, true);
  `);
});

describe("G5-02 — emissão (trigger AFTER INSERT, sem HTTP)", () => {
  it("nova conversa sem dono na fila aberta ⇒ emite conversation.routing_requested (1)", () => {
    expect(routingEventCount(CONV_NEW)).toBe(1);
  });

  it("payload carrega conversation_id + organization_id (fonte confiável p/ o worker)", () => {
    const out = sql(
      `select count(*) from public.event_log
        where event_type = 'conversation.routing_requested'
          and (payload->>'conversation_id') = '${CONV_NEW}'
          and (payload->>'organization_id') = '${GOV_ORG}';`,
    );
    expect(Number(out)).toBe(1);
  });

  it("conversa criada JÁ com dono ⇒ NÃO emite (0) — não entra na fila", () => {
    expect(routingEventCount(CONV_ASSIGNED)).toBe(0);
  });

  it("conversa nova sob a IA (ai_handling) ⇒ NÃO emite (0) — não é fila humana", () => {
    expect(routingEventCount(CONV_AI)).toBe(0);
  });
});

describe("G5-02 — assign do worker (fn_conversation_assign reason='routing')", () => {
  it("atribui a conversa ao agente (assigned_to_user_id = agente elegível)", () => {
    const out = sql(
      `select (assigned_to_user_id = '${GOV_AGENT_A}')::int
         from public.conversations where id = '${CONV_IDEM}';`,
    );
    expect(out).toBe("1");
  });

  it("grava conversation_assignment_events reason=routing na MESMA transação — exatamente 1 (idempotência: replay não duplica)", () => {
    const out = sql(
      `select count(*) from public.conversation_assignment_events
        where conversation_id = '${CONV_IDEM}' and reason = 'routing' and to_user_id = '${GOV_AGENT_A}';`,
    );
    expect(Number(out)).toBe(1);
  });

  it("ANTI-ECO: o UPDATE de atribuição NÃO re-emitiu routing_requested (segue 1, não 2/3)", () => {
    // A conversa emitiu 1x no INSERT; os 2 assigns (UPDATE) NÃO podem ter emitido
    // — não há trigger de UPDATE. Se isto for >1, há loop de eco (worker
    // reprocessaria o próprio assign).
    expect(routingEventCount(CONV_IDEM)).toBe(1);
  });
});
