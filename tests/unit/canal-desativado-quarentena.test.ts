/**
 * Canal DESATIVADO pelo operador — quarentena de ponta a ponta.
 *
 * A lei: desativado nunca entra na inbox. A entrega é gravada, mas não
 * aparece na lista, não dispara IA, não gera follow-up e não envia.
 * Reativou, tudo volta sem reimportar nada.
 *
 * Cada caso abaixo prende um elo — quem soltar um deles vê exatamente este
 * arquivo ficar vermelho, e não a suíte inteira:
 *
 * 1. `canalDesativado()` — só o booleano `true` desliga;
 * 2. `idsDosCanaisDesativados()` — lista para a inbox; erro vira lista vazia;
 * 3. `followup_turn` — job de canal desativado é consumido ANTES do turno,
 *    sem retentativa e sem o aviso crítico de job morto (#2329);
 * 4. `PATCH/GET .../disabled` — validação, auditoria e leitura;
 * 5. envio — canal desativado recusa com `channel_disabled`, sem rede.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { canalDesativado, idsDosCanaisDesativados } from "@/lib/channels/desativado";
import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

describe("canalDesativado — só o booleano true desliga", () => {
  it.each([
    [{ disabled: true }, true],
    [{ disabled: false }, false],
    [{}, false],
    [{ disabled: "true" }, false],
    [{ disabled: 1 }, false],
    [null, false],
    [undefined, false],
    ["lixo", false],
  ])("metadata %j → %s", (metadata, esperado) => {
    expect(canalDesativado(metadata)).toBe(esperado);
  });
});

describe("idsDosCanaisDesativados — a lista da quarentena da inbox", () => {
  it("devolve só os ids (a rota filtra pelo operador ->> )", async () => {
    let filtroVisto: unknown[] = [];
    const db = {
      from: () => {
        const cadeia: Record<string, () => unknown> = {};
        cadeia.select = () => cadeia;
        cadeia.eq = () => cadeia;
        cadeia.filter = ((col: string, op: string, val: unknown) => {
          filtroVisto = [col, op, val];
          return Promise.resolve({ data: [{ id: "canal-off" }], error: null });
        }) as unknown as () => unknown;
        return cadeia;
      },
    } as never;
    const ids = await idsDosCanaisDesativados(db, "org-1");
    expect(filtroVisto).toEqual(["metadata->>disabled", "eq", "true"]);
    expect(ids).toEqual(["canal-off"]);
  });

  it("erro de leitura vira lista vazia (a inbox decide; IA e envio barram por conta própria)", async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ filter: async () => ({ data: null, error: { message: "x" } }) }) }),
      }),
    } as never;
    await expect(idsDosCanaisDesativados(db, "org-1")).resolves.toEqual([]);
  });

  it("cliente sem .filter (dublê estreito) não derruba a lista", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({}) }) }) } as never;
    await expect(idsDosCanaisDesativados(db, "org-1")).resolves.toEqual([]);
  });
});

const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1", organization_id: ORG, contact_id: LEAD, kind: "followup_turn",
    source_event_id: null, payload: { service_boundary: boundary }, status: "running",
    priority: 0, run_after: new Date(), attempts: 1, max_attempts: 3, last_error: null,
    locked_by: "w1", locked_at: new Date(), created_at: new Date(), ...over,
  } as JobRow;
}

function poolComCanal(desativado: boolean) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    return {
      rows: [{
        channel_session_id: CANAL, archived_at: null,
        canal_desativado: desativado ? "true" : null,
      }],
    };
  });
  return { pool: { query } as never, query };
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

describe("followup_turn — canal desativado não paga o turno", () => {
  /**
   * Consumidor 5 da #2329. Antes, o `throw` mandava o job para a fila de
   * retentativa: 5 tentativas gastas e um `dead` com aviso CRÍTICO "Job
   * descartado" na Central, UM por follow-up — e o canal seguia desligado, sem
   * ninguém poder fazer nada. O desfecho próprio é consumir sem erro: o turno
   * NÃO roda (isto é o que este teste prende), o job termina `done` e o motivo
   * fica no log.
   *
   * Quem devolver o `throw` vê este teste vermelho — e a Central, com um alerta
   * crítico por follow-up de canal pausado.
   */
  it("canal desativado consome o job SEM ERRO e nunca roda o turno", async () => {
    const { pool } = poolComCanal(true);
    const handler = criarHandler({} as never);
    await expect(handler(job(), pool, { workerId: "w1" })).resolves.toBeUndefined();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("canal ligado passa da guarda (o resto do caminho é dos outros testes)", async () => {
    const { pool, query } = poolComCanal(false);
    const handler = criarHandler({} as never);
    // Segue adiante e cai à frente (inscrição/ritual) — o que não pode
    // acontecer é morrer AQUI com motivo de canal.
    const erro = await handler(job(), pool, { workerId: "w1" }).then(
      () => new Error("era para recusar à frente"),
      (e: unknown) => e,
    );
    expect(String((erro as Error)?.message ?? erro)).not.toMatch(/canal (desativado|arquivado)/);
    const usos = query.mock.calls.map((c) => String(c[0]));
    expect(usos.some((s) => s.includes("canal_desativado"))).toBe(true);
  });
});

describe("PATCH /api/v1/channel-sessions/[id]/disabled — o toggle", () => {
  const CANAL_ID = "44444444-4444-4444-8444-444444444444";
  const ORG_ID = "11111111-1111-4111-8111-111111111111";
  const ctx = () => ({ params: Promise.resolve({ id: CANAL_ID }) });
  const reqCom = (corpo: unknown) =>
    new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL_ID}/disabled`, {
      method: "PATCH",
      body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    });

  let rpcChamadas: Array<{ nome: string; args: Record<string, unknown> }>;
  let auditoria: Array<Record<string, unknown>>;

  async function mocks(rpcRetorno: { data: unknown; error: null } = { data: 1, error: null }) {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { requireSupportWrite } = await import("@/lib/impersonate/support");
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { audit } = await import("@/lib/audit");
    vi.mocked(requireSupportWrite).mockResolvedValue(undefined as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      org: { orgId: ORG_ID },
    } as never);
    rpcChamadas = [];
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { metadata: {} }, error: null }) }) }) }) }),
      }),
      rpc: vi.fn(async (nome: string, args: Record<string, unknown>) => {
        rpcChamadas.push({ nome, args });
        return rpcRetorno;
      }),
    } as never);
    auditoria = [];
    vi.mocked(audit).mockImplementation(async (a: unknown) => {
      auditoria.push(a as Record<string, unknown>);
      return undefined;
    });
  }

  it("id fora de uuid → 422 sem tocar no banco", async () => {
    await mocks();
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/disabled/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/v1/channel-sessions/nao-uuid/disabled", { method: "PATCH", body: "{}" }),
      { params: Promise.resolve({ id: "nao-uuid" }) },
    );
    expect(res.status).toBe(422);
    expect(rpcChamadas).toEqual([]);
  });

  it("corpo sem booleano → 422 (string 'true' não liga)", async () => {
    await mocks();
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/disabled/route");
    for (const corpo of ['"true"', "1", "{}", "null"]) {
      const res = await PATCH(reqCom(corpo), ctx());
      expect(res.status).toBe(422);
    }
    expect(rpcChamadas).toEqual([]);
  });

  it("desligar chama a RPC atômica e audita channel.disabled", async () => {
    await mocks();
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/disabled/route");
    const res = await PATCH(reqCom({ disabled: true }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { disabled: true } });
    expect(rpcChamadas).toEqual([
      { nome: "fn_definir_canal_desativado", args: { p_org: ORG_ID, p_canal: CANAL_ID, p_desativado: true } },
    ]);
    expect(auditoria.map((a) => a.action)).toEqual(["channel.disabled"]);
  });

  it("religar audita channel.enabled (a trilha diz nos dois sentidos)", async () => {
    await mocks();
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/disabled/route");
    const res = await PATCH(reqCom({ disabled: false }), ctx());
    expect(res.status).toBe(200);
    expect(auditoria.map((a) => a.action)).toEqual(["channel.enabled"]);
  });

  it("RPC com 0 linhas → 404 (canal de outra org ou arquivado)", async () => {
    await mocks({ data: 0, error: null });
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/disabled/route");
    const res = await PATCH(reqCom({ disabled: true }), ctx());
    expect(res.status).toBe(404);
    expect(auditoria).toEqual([]);
  });

  it("GET lê o estado (desligado e ligado)", async () => {
    await mocks();
    const { GET } = await import("@/app/api/v1/channel-sessions/[id]/disabled/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL_ID}/disabled`),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { disabled: false } });
  });
});

describe("inbox — conversa de canal desativado não lista (quarentena)", () => {
  const CANAL_OFF = "66666666-6666-4666-8666-666666666666";
  const CANAL_ON = "77777777-7777-4777-8777-777777777777";

  function linha(id: string, canal: string) {
    return {
      id, organization_id: "org-1", channel_session_id: canal, status: "open",
      comando_da_conversa: "aguardando", last_message_at: "2026-10-04T10:00:00Z",
      awaiting_since: "2026-10-04T10:00:00Z", last_inbound_at: "2026-10-04T10:00:00Z",
      created_at: "2026-10-04T09:00:00Z",
    };
  }

  // Dublê mínimo do PostgREST: `eq/in/not/filter/order/limit` compõem, o resto
  // passa. A tabela `channel_sessions` carrega metadata (é o que o filtro
  // `metadata->>disabled` lê); `conversations` aplica os filtros de verdade
  // (é o que prova a fiação, não o dublê).
  function bancoFake(
    sessoes: Array<{ id: string; metadata?: Record<string, unknown> }>,
    conversas: Array<Record<string, unknown>>,
  ) {
    // Como no banco: sessão pertence à org (o filtro de organização a remove sem ele).
    const linhasSessao = sessoes.map((s) => ({ organization_id: "org-1", ...s }));
    const cadeia = (tabela: string) => {
      let linhas: Array<Record<string, unknown>> =
        tabela === "conversations" ? [...conversas] : [...linhasSessao];
      let teto = Number.POSITIVE_INFINITY;
      const self: Record<string, (...a: unknown[]) => unknown> = {
        select: () => self,
        eq: (col, val) => {
          linhas = linhas.filter((r) => (r as Record<string, unknown>)[col as string] === val);
          return self;
        },
        in: (col, vals) => {
          linhas = linhas.filter((r) => (vals as unknown[]).includes((r as Record<string, unknown>)[col as string]));
          return self;
        },
        filter: (col, op, val) => {
          if (col === "metadata->>disabled" && op === "eq") {
            linhas = linhas.filter(
              (r) => ((r as Record<string, unknown>).metadata as Record<string, unknown> | undefined)?.disabled === (val === "true"),
            );
          }
          return self;
        },
        not: (col, op, val) => {
          if (op === "in" && typeof val === "string") {
            const fora = val.replace(/[()]/g, "").split(",").filter(Boolean);
            linhas = linhas.filter((r) => !fora.includes(String((r as Record<string, unknown>)[col as string])));
          }
          return self;
        },
        order: () => self,
        limit: (n) => {
          teto = n as number;
          return self;
        },
        then: (...rest: unknown[]) =>
          (rest[0] as (v: unknown) => unknown)({ data: linhas.slice(0, teto), error: null }),
      };
      return self;
    };
    return { from: (t: string) => cadeia(t) } as never;
  }

  const ctxLista = { organization_id: "org-1", requestId: "req-1", actor: { type: "user", id: "u-1" } } as never;

  it("lista exclui a conversa do canal desligado e mantém a do ligado", async () => {
    const { listConversationsHandler } = await import("@/app/api/v1/conversations/_handler");
    const db = bancoFake(
      [{ id: CANAL_OFF, metadata: { disabled: true } }, { id: CANAL_ON, metadata: {} }],
      [linha("conv-off", CANAL_OFF), linha("conv-on", CANAL_ON)],
    );
    const r = await listConversationsHandler(db, ctxLista, { limit: 50 } as never);
    expect(r.conversations.map((c: { id: string }) => c.id)).toEqual(["conv-on"]);
  });

  it("sem canal desligado, nada é excluído (o corte não come a lista normal)", async () => {
    const { listConversationsHandler } = await import("@/app/api/v1/conversations/_handler");
    const db = bancoFake(
      [{ id: CANAL_OFF, metadata: {} }, { id: CANAL_ON, metadata: {} }],
      [linha("conv-off", CANAL_OFF), linha("conv-on", CANAL_ON)],
    );
    const r = await listConversationsHandler(db, ctxLista, { limit: 50 } as never);
    expect(r.conversations.map((c: { id: string }) => c.id).sort()).toEqual(["conv-off", "conv-on"]);
  });
});

describe("envio — canal desativado recusa sem tocar a rede", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const CONV = "22222222-2222-4222-8222-222222222222";
  const CONTACT = "33333333-3333-4333-8333-333333333333";
  const SESSION = "44444444-4444-4444-8444-444444444444";
  const USER = "55555555-5555-4555-8555-555555555555";

  function conversa(metadata: Record<string, unknown> | undefined) {
    return {
      id: CONV, organization_id: ORG, contact_id: CONTACT, channel_session_id: SESSION,
      is_group: false, group_chat_id: null, provider_conversation_id: null,
      contacts: { phone_number: "+595991733685", wa_identity: null, wa_lid: null, is_blocked: false },
      channel_sessions: {
        provider: "waha", waha_session_name: "default", status: "WORKING",
        ...(metadata === undefined ? {} : { metadata }),
      },
    };
  }

  const ctxEnvio = {
    organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1",
  } as never;

  it("canal desativado → failed/channel_disabled e fetch nunca chamado", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");
    const fetchMock = vi.fn(async () => Response.json({ key: { id: "TEXT1" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { criarDubleDoHandler } = await import("@/tests/helpers/duble-do-handler");
      const { sendMessageHandler } = await import("@/app/api/v1/messages/_handler");
      const { supabase } = criarDubleDoHandler({
        conversation: conversa({ disabled: true }),
        templateRow: null,
        projetarConversa: true,
      });
      const msg = await sendMessageHandler(supabase as never, ctxEnvio, {
        conversation_id: CONV, type: "text", body: "oi",
      } as never);
      expect(msg.status).toBe("failed");
      expect(msg.error_code).toBe("channel_disabled");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("canal ligado envia normal (a guarda não engoliu o caminho bom)", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");
    const fetchMock = vi.fn(async () => Response.json({ key: { id: "TEXT1" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { criarDubleDoHandler } = await import("@/tests/helpers/duble-do-handler");
      const { sendMessageHandler } = await import("@/app/api/v1/messages/_handler");
      const { supabase } = criarDubleDoHandler({
        conversation: conversa({}),
        templateRow: null,
        projetarConversa: true,
      });
      const msg = await sendMessageHandler(supabase as never, ctxEnvio, {
        conversation_id: CONV, type: "text", body: "oi",
      } as never);
      expect(msg.status).toBe("sent");
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
