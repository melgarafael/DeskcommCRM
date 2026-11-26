/**
 * Ciclo de vida completo das mensagens institucionais (PR 02):
 *
 * - Eco `fromMe` da WAHA em corrida pré-carimbo: reconhece eco institucional
 *   sem chamar `fn_mark_conversation_message` e sem silenciar IA / nascer lead;
 * - `redriveQueued` do `session-reconciler`: aborta linha `queued` institucional
 *   se a conversa foi encerrada/resolvida/arquivada antes do resgate;
 * - Retries (`reenvioDesaceleradoAtende` / `reenvioDaMensagem`): `sent_via='system'`
 *   nunca entra em retentativa humana/automática;
 * - Preservação dos indicadores e fluxos de atendimento (`comandoDaConversa`,
 *   `painel-de-atendimento`, `devolucao-automatica` e `jaNaoHaOQueResponder`).
 */
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { createLogger } from "@/lib/agent-engine/obs/logger";
import { createFollowupTurnHandler } from "@/lib/agent-engine/agent/followup-turn";
import { redriveQueued } from "@/lib/agent-engine/edge/crm/session-reconciler";
import { jaNaoHaOQueResponder } from "@/lib/agent-engine/queue/espera-de-saldo";
import { selecionarVencidas } from "@/lib/escalacao/devolucao-automatica";
import { eFalaDaEquipe, ultimaFalaEDaEquipe } from "@/lib/escalacao/fala-da-equipe";
import { createSupabaseRetomadaAoDevolverDb } from "@/lib/escalacao/retomada-ao-devolver";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { montarColunas } from "@/lib/inbox/painel-de-atendimento";
import { reenvioDaMensagem } from "@/lib/messaging/reenvio";
import { reenvioDesaceleradoAtende } from "@/lib/messaging/reenvio-desacelerado";
import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

afterEach(() => {
  vi.restoreAllMocks();
});

function dbEcoWaha(opts: { institucional: boolean; texto: string }) {
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const conversa = {
    id: "conversa-1",
    organization_id: "org-1",
    bot_silenced_until: null as string | null,
  };
  const messages: Array<Record<string, unknown>> = [
    {
      id: "envio-1",
      organization_id: "org-1",
      conversation_id: "conversa-1",
      external_id: null,
      direction: "outbound",
      status: "queued",
      sent_via: "system",
      body: opts.texto,
      type: "chat",
      updated_at: new Date().toISOString(),
      metadata: opts.institucional ? { dispatch_mode: "institutional" } : {},
    },
  ];

  const casa = (m: Record<string, unknown>, filtros: Array<[string, unknown, string]>) =>
    filtros.every(([c, v, op]) => {
      if (op === "in") return (v as unknown[]).includes(m[c]);
      if (op === "neq") return m[c] !== v;
      return m[c] === v;
    });

  const queryMessages = (acao: "select" | "delete") => {
    const filtros: Array<[string, unknown, string]> = [];
    const q: Record<string, unknown> = {
      eq(c: string, v: unknown) {
        filtros.push([c, v, "eq"]);
        return q;
      },
      in(c: string, v: unknown[]) {
        filtros.push([c, v, "in"]);
        return q;
      },
      neq(c: string, v: unknown) {
        filtros.push([c, v, "neq"]);
        return q;
      },
      gte: () => q,
      order: () => q,
      limit: () => q,
      async maybeSingle() {
        const achou = messages.find((m) => casa(m, filtros));
        return { data: achou ? { id: achou.id } : null, error: null };
      },
      then(ok: (v: unknown) => unknown) {
        if (acao === "delete") {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (casa(messages[i]!, filtros)) messages.splice(i, 1);
          }
          return Promise.resolve(ok({ error: null }));
        }
        return Promise.resolve(
          ok({
            data: messages.filter((m) => casa(m, filtros)).map((m) => ({ ...m })),
            error: null,
          }),
        );
      },
    };
    return q;
  };

  const admin = {
    from: (tabela: string) => ({
      select: () =>
        tabela === "conversations"
          ? {
              eq() {
                return this;
              },
              async maybeSingle() {
                return { data: { bot_silenced_until: conversa.bot_silenced_until }, error: null };
              },
            }
          : queryMessages("select"),
      delete: () => queryMessages("delete"),
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          async maybeSingle() {
            const nova = { id: `eco-${messages.length + 1}`, ...linha };
            messages.push(nova);
            return { data: { id: nova.id }, error: null };
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        if (tabela === "conversations") Object.assign(conversa, patch);
        const enc: Record<string, unknown> = { error: null };
        enc.eq = () => enc;
        enc.in = () => enc;
        return enc;
      },
    }),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };

  return { admin, rpcCalls, conversa };
}

describe("Ciclo de vida institucional (PR 02)", () => {
  it("WAHA eco pré-carimbo: eco institucional NÃO chama fn_mark_conversation_message e NÃO pausa IA; controle operacional marca", async () => {
    const texto = "Aviso institucional de atualização cadastral.";
    const payload: WahaPayload = {
      id: "true_5531999998888@c.us_3EB0ECOINST1",
      from: "5531999998888@c.us",
      fromMe: true,
      body: texto,
      type: "chat",
      timestamp: 1_760_000_000,
    };
    const envelope: WahaEnvelope = { event: "message.any", session: "default", payload };

    const inst = dbEcoWaha({ institucional: true, texto });
    await dispatchWahaEvent(
      inst.admin as never,
      { id: "sess-1", organization_id: "org-1" } as never,
      envelope,
      "req-inst",
    );

    expect(inst.rpcCalls.some((c) => c.fn === "fn_mark_conversation_message")).toBe(false);
    expect(inst.conversa.bot_silenced_until).toBeNull();

    const op = dbEcoWaha({ institucional: false, texto });
    await dispatchWahaEvent(
      op.admin as never,
      { id: "sess-1", organization_id: "org-1" } as never,
      envelope,
      "req-op",
    );

    expect(op.rpcCalls.some((c) => c.fn === "fn_mark_conversation_message")).toBe(true);
    expect(op.conversa.bot_silenced_until).toBeNull();
  });

  it("session-reconciler (redriveQueued): falha linha institucional se conversa encerrou e reenvia se continuar aberta", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: { id: "3EB0REDRIVE" } }), { status: 200 }),
      );

    const filaFechada = [
      {
        id: "m-q-fechada",
        organization_id: "org-1",
        conversation_id: "conv-fechada",
        contact_id: "contact-1",
        body: "Aviso preso antes do fechamento",
        sent_via: "system",
        waha_session_name: "default",
        wa_identity: null,
        wa_lid: null,
        phone_number: "+5531999998888",
        is_group: false,
        group_chat_id: null,
      },
    ];
    const updatesFechada: Array<{ sql: string; params: unknown[] }> = [];
    const poolFechada = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
        if (/select\s+m\.id/i.test(sql)) return { rows: filaFechada };
        if (/select\s+s\.metadata/i.test(sql)) {
          return {
            rows: [
              {
                metadata: {},
                phone_number: "+5531999998888",
                operante: true,
                conversation_status: "resolved",
                message_metadata: { dispatch_mode: "institutional" },
              },
            ],
          };
        }
        if (/update\s+messages/i.test(sql)) updatesFechada.push({ sql, params });
        return { rows: [] };
      }),
    };

    const reenviadasFechada = await redriveQueued(
      poolFechada as unknown as pg.Pool,
      {
        wahaBaseUrl: "http://127.0.0.1:9999",
        wahaApiKey: "k",
        intervalMs: 1,
        redriveMinAgeMs: 0,
        redriveBatchSize: 10,
        redriveSpacingMs: 0,
      },
      createLogger(),
    );
    expect(reenviadasFechada).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      updatesFechada.some(
        (u) => u.sql.includes("conversation_closed") && u.params.includes("m-q-fechada"),
      ),
    ).toBe(true);

    // Controle: conversa ativa reenvia normalmente.
    const poolAberta = {
      query: vi.fn(async (sql: string) => {
        if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
        if (/select\s+m\.id/i.test(sql))
          return {
            rows: [{ ...filaFechada[0], id: "m-q-aberta", conversation_id: "conv-aberta" }],
          };
        if (/select\s+s\.metadata/i.test(sql)) {
          return {
            rows: [
              {
                metadata: {},
                phone_number: "+5531999998888",
                operante: true,
                conversation_status: "open",
                message_metadata: { dispatch_mode: "institutional" },
              },
            ],
          };
        }
        if (/update\s+messages/i.test(sql)) return { rows: [{ id: "m-q-aberta" }] };
        return { rows: [] };
      }),
    };
    const reenviadasAberta = await redriveQueued(
      poolAberta as unknown as pg.Pool,
      {
        wahaBaseUrl: "http://127.0.0.1:9999",
        wahaApiKey: "k",
        intervalMs: 1,
        redriveMinAgeMs: 0,
        redriveBatchSize: 10,
        redriveSpacingMs: 0,
      },
      createLogger(),
    );
    expect(reenviadasAberta).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retentativas e painel/devolução/espera-de-saldo: sent_via='system' institucional não entra em retry e não distorce o atendimento", async () => {
    expect(reenvioDesaceleradoAtende("system")).toBe(false);
    expect(
      reenvioDaMensagem(
        {
          organization_id: "org-1",
          conversation_id: "conv-1",
          direction: "outbound",
          sent_via: "system",
          sent_by_user_id: null,
          type: "text",
          body: "Aviso",
          media_storage_path: null,
          status: "failed",
          error_code: "provider_error",
          metadata: { dispatch_mode: "institutional" },
        },
        { userId: "u-1", podeReenviarDeOutros: true },
      ),
    ).toBe("nenhum");

    // Com estado da conversa preservado pelo envio institucional:
    const agora = new Date("2026-11-25T12:00:00.000Z");
    const estadoPreservado = {
      status: "pending",
      automaticoDaOrg: true,
      assigned_to_user_id: null,
      assignee_kind: null,
      bot_silenced_until: "infinity",
      last_handoff_reason: null,
      force_human: false,
      is_group: false,
      is_blocked: false,
      automaticoDaConversa: true,
    };
    expect(comandoDaConversa(estadoPreservado, agora).comando.quem).toBe("aguardando");

    // Devolução automática mantém o último sinal humano antigo (não renovado por envio institucional).
    const vencidas = selecionarVencidas(
      [
        {
          id: "conv-1",
          organization_id: "org-1",
          channel_session_id: "sess-1",
          status: "open",
          assignee_kind: "user",
          assigned_to_user_id: "u-1",
          assigned_at: "2026-11-25T10:00:00.000Z",
          bot_silenced_until: "infinity",
          last_handoff_at: "2026-11-25T10:00:00.000Z",
          last_outbound_at: null,
          status_changed_at: "2026-11-25T10:00:00.000Z",
          metadata: {},
        },
      ],
      {
        prazoPorOrg: new Map([["org-1", 30]]),
        sessoesComAgente: new Map([["org-1", new Set(["sess-1"])]]),
        agoraMs: agora.getTime(),
      },
    );
    expect(vencidas).toHaveLength(1);

    // Painel mantém conversa em "Aguardando" quando cliente falou por último (last_outbound_at nulo).
    const painel = montarColunas(
      [
        {
          id: "conv-fila",
          status: "pending",
          comando_da_conversa: "aguardando",
          created_at: "2026-11-25T10:00:00.000Z",
          last_inbound_at: "2026-11-25T11:30:00.000Z",
          last_outbound_at: null,
          last_message_at: "2026-11-25T11:30:00.000Z",
          awaiting_since: "2026-11-25T11:30:00.000Z",
          bot_silenced_until: "infinity",
        },
      ],
      "America/Sao_Paulo",
      agora,
    );
    expect(painel.aguardando.map((c) => c.id)).toEqual(["conv-fila"]);
    expect(painel.emAtendimento).toEqual([]);

    // Espera de saldo não cancela turno da IA pendente porque last_outbound_at não avançou.
    const respondida = await jaNaoHaOQueResponder(
      { query: (async () => ({ rows: [{ respondida: false }] })) as never },
      { kind: "inbound_turn", organization_id: "org-1", payload: { conversation_id: "conv-1" } },
    );
    expect(respondida).toBe(false);

    // Régua de fala humana da equipe recusa sent_via='system' institucional e não retoma a IA.
    expect(eFalaDaEquipe({ direction: "outbound", sent_via: "system" })).toBe(false);
    expect(ultimaFalaEDaEquipe({ direction: "outbound", sent_via: "system" })).toBe(false);
  });

  it("createSupabaseRetomadaAoDevolverDb: ignora aviso institucional mais recente e preserva última fala operacional", async () => {
    const linhas = [
      { direction: "outbound", sent_via: "system", metadata: { dispatch_mode: "institutional" } },
      { direction: "outbound", sent_via: "user", metadata: {} },
      { direction: "inbound", sent_via: "external_device", metadata: {} },
    ];
    const montarAdmin = (rows: typeof linhas) =>
      ({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  order: () => ({
                    limit: async () => ({ data: rows, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }) as never;

    const db = createSupabaseRetomadaAoDevolverDb(montarAdmin(linhas));
    expect(await db.ultimaMensagem("org-1", "conv-1")).toEqual({
      direction: "outbound",
      sent_via: "user",
    });

    const dbSoInstitucional = createSupabaseRetomadaAoDevolverDb(montarAdmin([linhas[0]!]));
    expect(await dbSoInstitucional.ultimaMensagem("org-1", "conv-1")).toBeNull();
  });

  it("createFollowupTurnHandler (mode='retomada'): SQL exclui mensagens institucionais ao decidir retomada", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("from conversations c left join demandas d")) {
          return {
            rows: [
              {
                organization_id: "11111111-1111-4111-8111-111111111111",
                contact_id: "22222222-2222-4222-8222-222222222222",
                conversation_id: "33333333-3333-4333-8333-333333333333",
                service_revision: 1,
                demanda_id: null,
                demanda_revision: null,
                status: "open",
                demanda_fechada_em: null,
              },
            ],
          };
        }
        if (sql.includes("from conversations c") && sql.includes("channel_sessions cs")) {
          return {
            rows: [{ channel_session_id: "sess-1", archived_at: null, canal_desativado: null }],
          };
        }
        if (sql.includes("from messages")) {
          // Simula que o banco filtrará o aviso institucional mais recente e devolverá
          // a última mensagem operacional real (cliente falou por último).
          return {
            rows: [
              {
                direction: "inbound",
                sent_via: "external_device",
                type: "text",
                body: "Ainda estou aguardando",
                media_url: null,
                media_storage_path: null,
                media_derived_text: null,
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as never;

    const handler = createFollowupTurnHandler({ log: createLogger() } as never);
    await handler(
      {
        id: "job-1",
        organization_id: "11111111-1111-4111-8111-111111111111",
        contact_id: "22222222-2222-4222-8222-222222222222",
        kind: "followup_turn",
        payload: {
          mode: "retomada",
          conversation_id: "33333333-3333-4333-8333-333333333333",
          channel_session_id: "sess-1",
          service_boundary: {
            organization_id: "11111111-1111-4111-8111-111111111111",
            contact_id: "22222222-2222-4222-8222-222222222222",
            conversation_id: "33333333-3333-4333-8333-333333333333",
            service_revision: 1,
            demanda_id: null,
            demanda_revision: null,
          },
        },
      } as never,
      pool,
      { workerId: "w-1" },
    );

    const sqlMensagens = queries.find((q) => q.includes("from messages"));
    expect(sqlMensagens).toBeDefined();
    expect(sqlMensagens).toContain("coalesce(metadata->>'dispatch_mode', '') <> 'institutional'");
  });
});
