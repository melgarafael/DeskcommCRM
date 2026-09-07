/**
 * Bug reportado: quando um atendente manda mensagem manualmente numa conversa,
 * a IA "fica quieta" só por coincidência de timing (nenhum turno novo foi
 * disparado) — e volta a responder junto com o humano assim que o CLIENTE manda
 * a próxima mensagem, porque `isLeadInHandoff` (lib/agent-engine/agent/human-
 * handoff.ts) só olha `contacts.force_human`/`conversations.bot_silenced_until`,
 * e nenhum envio manual tocava nenhum dos dois.
 *
 * A correção: `sendMessageHandler` (`_handler.ts`) estende `bot_silenced_until`
 * para 5min à frente quando quem envia é um humano (`ctx.actor.type === "user"`)
 * — sliding window, renovada a cada mensagem. Nunca ENCURTA um silêncio maior já
 * setado (nem o 'infinity' do handoff permanente, que `isLeadInHandoff` também
 * lê — ver `lib/ai/handoff/orchestrator.ts` e `human-handoff.ts:performHumanHandoff`).
 */
import { createServer } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/send-whatsapp";
import "@/lib/automation/actions/send-ai-message";
import type { ActionCtx } from "@/lib/automation/types";
import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";
const generation = vi.hoisted(() => ({ run: async () => ({ ok: true as const, texto: "Resposta gerada" }), authorize: vi.fn(async () => {}) }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({ gerarAbordagemDeFormulario: () => generation.run() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/automation/dados-do-formulario", () => ({ dadosDoFormularioDoContexto: async () => ({ dados: {}, origem: "form", veioDeFormulario: true }) }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: generation.authorize }));
const pacing = vi.hoisted(() => ({ run: async () => {} }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: () => pacing.run(), checkDailyLimit: vi.fn() }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const AGENT_RUN = '66666666-6666-4666-8666-666666666666';

type Row = Record<string, unknown>;

function conversationRow(botSilencedUntil: string | null): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: botSilencedUntil,
    contacts: { phone_number: '+5531999998888', wa_identity: null, is_blocked: false },
    channel_sessions: { provider: 'waha', waha_session_name: 'default', status: 'WORKING' },
  };
}

/** Captura o patch do UPDATE em `conversations` — é isso que os casos verificam. */
function makeSupabase(botSilencedUntil: string | null, snapshot?: () => Record<string, unknown>) {
  const patches: Row[] = [];
  const client = {
    from(table: string) {
      if (table === "channel_sessions") {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: { metadata: {} }, error: null }),
        };
        return query;
      }
      if(table==='calendar_appointments'){
        const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,limit:()=>q,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(resolve)};
        return q;
      }
      if(table==='organizations'){
        const q={select:()=>q,eq:()=>q,single:async()=>({data:{settings:{}},error:null})};return q;
      }

      if (table === 'conversations') {
        return {
          select: () => {
            const chain = { eq: () => chain, maybeSingle: async () => ({ data: conversationRow(botSilencedUntil), error: null }) };
            return chain;
          },
          update: (patch: Row) => {
            patches.push(patch);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      if (table === 'messages') {
        return {
          insert: (row: Row) => {
            const nova = { id: 'msg-1', external_id: null, ack: null, error_code: null, error_message: null, ...row };
            return { select: () => ({ single: async () => ({ data: nova, error: null }) }) };
          },
          update: (patch: Row) => ({
            eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'msg-1', ...patch }, error: null }) }) }),
          }),
        };
      }
      if (table === "contacts") {
        // O envio carimba `contacts.last_activity_at` (migration 0162). O dublê
        // é encadeável SEM LIMITE de propósito: a consulta filtra por id E por
        // organização (este handler também roda com o client de service role,
        // que bypassa RLS), e um dublê que fixa a quantidade de `eq` quebra
        // quando a consulta ganha um filtro novo — com um erro que não fala do
        // comportamento sob teste.
        const cadeiaContacts: Record<string, unknown> = {
          eq: () => cadeiaContacts,
          then: (resolve: (v: { error: null }) => unknown) =>
            Promise.resolve({ error: null }).then(resolve),
        };
        return { update: () => cadeiaContacts };
      }
      throw new Error(`fake_supabase: tabela inesperada '${table}'`);
    },
    rpc: async () => ({ data: snapshot ? snapshot() : { organization_id: ORG, contact_id: CONTACT, conversation_id: CONV, service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null }, error: null }),
  };
  return { supabase: client as unknown as SupabaseClient, patches };
}

const input = { conversation_id: CONV, type: 'text', body: 'oi' } as SendMessageInput;

function wahaConfigured() {
  vi.stubEnv('WAHA_API_BASE_URL', 'http://localhost:3030');
  vi.stubEnv('WAHA_API_KEY', 'hash123');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: { id: 'BARE1' } }), { status: 200 })));
}

afterEach(() => {
  pacing.run = async () => {};
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sendMessageHandler — silêncio da IA de 5min após resposta manual humana', () => {
  it('humano manda mensagem numa conversa sem silêncio → bot_silenced_until vira ~agora+5min', async () => {
    wahaConfigured();
    const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };
    const { supabase, patches } = makeSupabase(null);

    const before = Date.now();
    await sendMessageHandler(supabase, ctx, input);
    const after = Date.now();

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until, 'não silenciou a IA após resposta manual').toBeDefined();
    const silencedUntil = new Date(convPatch.bot_silenced_until as string).getTime();
    expect(silencedUntil).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 1000);
    expect(silencedUntil).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 1000);
  });

  it('IA envia mensagem (ai_agent) → NÃO mexe em bot_silenced_until', async () => {
    wahaConfigured();
    const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'ai_agent', id: AGENT_RUN, role: 'agent' }, requestId: 'req-2', serviceBoundary: { organization_id: ORG, contact_id: CONTACT, conversation_id: CONV, service_revision: 1, demanda_id: null, demanda_revision: null } };
    const { supabase, patches } = makeSupabase(null);

    await sendMessageHandler(supabase, ctx, input);

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until, 'a IA silenciou a si mesma ao responder').toBeUndefined();
  });

  it('handoff permanente (infinity) já ativo → resposta manual NÃO encurta para 5min', async () => {
    wahaConfigured();
    const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-3' };
    const { supabase, patches } = makeSupabase('infinity');

    await sendMessageHandler(supabase, ctx, input);

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until, 'rebaixou o handoff permanente para uma janela de 5min').toBeUndefined();
  });

  it('silêncio finito já maior que 5min (ex.: 30min) → resposta manual não encurta', async () => {
    wahaConfigured();
    const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-4' };
    const trintaMin = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { supabase, patches } = makeSupabase(trintaMin);

    await sendMessageHandler(supabase, ctx, input);

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until, 'encurtou um silêncio maior já setado').toBeUndefined();
  });

  it('silêncio finito menor que 5min (ex.: 1min) → resposta manual estende (sliding window)', async () => {
    wahaConfigured();
    const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-5' };
    const umMin = new Date(Date.now() + 60 * 1000).toISOString();
    const { supabase, patches } = makeSupabase(umMin);

    const before = Date.now();
    await sendMessageHandler(supabase, ctx, input);

    const convPatch = patches[patches.length - 1]!;
    expect(convPatch.bot_silenced_until, 'não renovou a janela com a nova mensagem').toBeDefined();
    const silencedUntil = new Date(convPatch.bot_silenced_until as string).getTime();
    expect(silencedUntil).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 1000);
  });
});

// A guarda do sink é exercitada além da guarda inicial; fetch/WAHA são reais.
it('sink recusa close/reopen ocorrido depois da primeira leitura e receiver recebe zero', async () => {
  const received: string[] = [];
  const receiver = createServer((req, res) => { received.push(req.url ?? ""); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: { id: 'REAL1' } })); });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  try {
    const address = receiver.address(); if (!address || typeof address === 'string') throw new Error('receiver');
    vi.stubEnv('WAHA_API_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('WAHA_API_KEY', 'local-test');
    const boundary = { organization_id: ORG, contact_id: CONTACT, conversation_id: CONV, service_revision: 1, demanda_id: null, demanda_revision: null };
    const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'ai_agent', id: AGENT_RUN, role: 'agent' }, requestId: 'sink-test', serviceBoundary: boundary };
    for (const changed of [{ status: 'closed', service_revision: 2 }, { status: 'open', service_revision: 3 }]) {
      let reads = 0;
      const { supabase } = makeSupabase(null, () => ({ ...boundary, status: 'open', demanda_fechada_em: null, ...(reads++ === 0 ? {} : changed) }));
      await expect(sendMessageHandler(supabase, ctx, input)).rejects.toThrow('service_boundary_stale');
      expect(reads).toBe(2);
      expect(received).toHaveLength(0);
    }
    // Close/reopen durante resolução assíncrona do destinatário no adapter:
    // leituras do provider podem ocorrer, mas nenhum envio é aceito.
    let reads = 0;
    const late = makeSupabase(null, () => ({ ...boundary, status: 'open', demanda_fechada_em: null, service_revision: reads++ < 2 ? 1 : 3 }));
    await expect(sendMessageHandler(late.supabase, ctx, input)).rejects.toThrow('service_boundary_stale');
    expect(reads).toBe(3);
    expect(received.filter((url) => url.endsWith('/sendText'))).toHaveLength(0);
    // Controle positivo: o mesmo handler e transporte chegam ao receiver quando vigente.
    await sendMessageHandler(makeSupabase(null).supabase, ctx, input);
    expect(received.filter((url) => url.endsWith("/sendText"))).toHaveLength(1);
  } finally { await new Promise<void>((resolve) => receiver.close(() => resolve())); }
});


it("ação de automação conserva origem durante pacing e dois envios vigentes chegam ao receiver", async () => {
  const hits: string[] = [];
  const receiver = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: { id: "ACTION" } })); });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const address = receiver.address(); if (!address || typeof address === "string") throw new Error("receiver");
    vi.stubEnv("WAHA_API_BASE_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("WAHA_API_KEY", "local-test");
    const boundary = { organization_id: ORG, contact_id: CONTACT, conversation_id: CONV, service_revision: 1, demanda_id: null, demanda_revision: null };
    let revision = 1;
    const { supabase } = makeSupabase(null, () => ({ ...boundary, service_revision: revision, status: "open", demanda_fechada_em: null }));
    const ctx = { admin: supabase, organizationId: ORG, ruleId: USER, ruleName: "Teste", requestId: "rule-test",
      serviceBoundaries: new Map(), event: { event_type: "lead.created", payload: { service_origin: { kind: "continuation", boundary } } },
      context: { contact: { id: CONTACT, phone_number: "+5531999998888" } } } as unknown as ActionCtx;
    const action = getAction("send_whatsapp_message")!;
    const config = { channel_session_id: SESSION, template: "Olá" };
    pacing.run = async () => { revision = 3; };
    expect((await action.execute(ctx, config)).status).toBe("failed");
    expect(hits).toHaveLength(0);
    revision = 1; pacing.run = async () => {};
    expect((await action.execute(ctx, config)).status).toBe("success");
    expect((await action.execute(ctx, config)).status).toBe("success");
    expect(hits.filter((url) => url.endsWith("/sendText"))).toHaveLength(2);
    revision = 3;
    expect((await action.execute(ctx, config)).status).toBe("failed");
    expect(hits.filter((url) => url.endsWith("/sendText"))).toHaveLength(2);
    // A outra action conserva origem durante a espera pelo modelo.
    revision = 1;
    generation.authorize.mockClear();
    generation.run = async () => { revision = 3; return { ok: true, texto: "Resposta gerada" }; };
    const ai = getAction("send_ai_message")!;
    const aiConfig = { channel_session_id: SESSION, agent_id: AGENT_RUN, instruction: "Responda" };
    expect((await ai.execute(ctx, aiConfig)).status).toBe("failed");
    expect(generation.authorize).not.toHaveBeenCalled();
    expect(hits.filter((url) => url.endsWith("/sendText"))).toHaveLength(2);
    revision = 1; generation.run = async () => ({ ok: true, texto: "Resposta gerada" });
    expect((await ai.execute(ctx, aiConfig)).status).toBe("success");
    expect(generation.authorize).toHaveBeenCalledTimes(1);
    expect(hits.filter((url) => url.endsWith("/sendText"))).toHaveLength(3);
    revision = 3;
    // Aviso humano independente conserva autoria de sistema sem exigir job.
    const aviso = await avisarLeadDoCrm(supabase, { organizationId: ORG, contactId: CONTACT, conversationId: CONV, reason: "requested_human" });
    expect(aviso.avisado).toBe(true);
    expect(hits.filter((url) => url.endsWith("/sendText"))).toHaveLength(4);
    const antigo = await avisarLeadDoCrm(supabase, { organizationId: ORG, contactId: CONTACT, conversationId: CONV, reason: "Caso antigo", serviceBoundary: boundary });
    expect(antigo.avisado).toBe(false);
    expect(hits.filter((url) => url.endsWith("/sendText"))).toHaveLength(4);
  } finally { await new Promise<void>((resolve) => receiver.close(() => resolve())); }
});
