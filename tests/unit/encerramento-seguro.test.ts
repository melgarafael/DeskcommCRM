import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { exigirControleDaConversa } from "@/lib/inbox/controle-da-conversa";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { pedirSatisfacaoAoEncerrar } from "@/lib/atendimento/satisfacao";
import { createAdminClient } from "@/lib/supabase/admin";
import { crmCloseConversation } from "@/lib/mcp/tools/comandos-de-conversa";
import type { McpContext } from "@/lib/mcp/types";
import { fecharConversaHandler } from "@/app/api/v1/conversations/[id]/_handler";
import { POST } from "@/app/api/v1/conversations/[id]/close/route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(),
}));
vi.mock("@/lib/inbox/controle-da-conversa", () => ({
  exigirControleDaConversa: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/atendimento/satisfacao", () => ({ pedirSatisfacaoAoEncerrar: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const MSG_IN_1 = "66666666-6666-4666-8666-666666666661";
const MSG_IN_2 = "66666666-6666-4666-8666-666666666662";
const USER_1 = "77777777-7777-4777-8777-777777777771";
const USER_2 = "77777777-7777-4777-8777-777777777772";
const SECTOR_1 = "88888888-8888-4888-8888-888888888881";
const SECTOR_2 = "88888888-8888-4888-8888-888888888882";
const TOKEN_ID = "99999999-9999-4999-8999-999999999999";

interface EstadoSimulado {
  conversation: {
    id: string;
    organization_id: string;
    contact_id: string;
    channel_session_id: string;
    status: string;
    assigned_to_user_id: string | null;
    assignee_kind: string | null;
    sector_id: string | null;
    service_revision: number;
    bot_silenced_until: string | null;
    last_inbound_at: string | null;
    metadata: Record<string, unknown>;
  };
  lastInboundMessageId: string | null;
  pendency: null | "open_agent_case" | "open_proposal" | "open_task" | "open_human_demand";
  onBeforeRpcLock?: () => void;
}

function criarEstadoInicial(): EstadoSimulado {
  return {
    conversation: {
      id: CONV_ID,
      organization_id: ORG_A,
      contact_id: CONTACT_ID,
      channel_session_id: SESSION_ID,
      status: "open",
      assigned_to_user_id: null,
      assignee_kind: "ai",
      sector_id: SECTOR_1,
      service_revision: 3,
      bot_silenced_until: null,
      last_inbound_at: "2026-11-26T12:00:00.000Z",
      metadata: {},
    },
    lastInboundMessageId: MSG_IN_1,
    pendency: null,
  };
}

function criarSupabaseMock(estado: EstadoSimulado) {
  return {
    from: (table: string) => {
      if (table !== "conversations") {
        throw new Error(`Tabela inesperada no mock: ${table}`);
      }
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq: (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            },
            maybeSingle: async () => {
              const c = estado.conversation;
              if (filters.id === c.id && filters.organization_id === c.organization_id) {
                return { data: c, error: null };
              }
              return { data: null, error: null };
            },
          };
          return chain;
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "fn_service_status") {
        const c = estado.conversation;
        if (args.p_org !== c.organization_id || args.p_conversation !== c.id) {
          return { data: null, error: { code: "P0002", message: "service_not_found" } };
        }
        if (args.p_expected != null && c.service_revision !== args.p_expected) {
          return { data: null, error: { code: "PT409", message: "service_stale" } };
        }
        if (c.status !== args.p_status) {
          c.status = String(args.p_status);
          c.service_revision += 1;
        }
        return { data: { ...c }, error: null };
      }

      if (fn !== "fn_safe_close_conversation") {
        throw new Error(`RPC inesperada: ${fn}`);
      }

      // Simula concorrência ocorrida entre a leitura prévia e a aquisição do lock no banco.
      if (estado.onBeforeRpcLock) {
        const cb = estado.onBeforeRpcLock;
        estado.onBeforeRpcLock = undefined;
        cb();
      }

      const c = estado.conversation;
      if (args.p_org !== c.organization_id || args.p_conversation !== c.id) {
        return { data: null, error: { code: "P0002", message: "service_not_found" } };
      }

      const key =
        typeof args.p_idempotency_key === "string" && args.p_idempotency_key.trim()
          ? args.p_idempotency_key.trim()
          : null;

      if (c.status === "closed" && key && c.metadata.safe_close_idempotency_key === key) {
        return {
          data: {
            closed: true,
            already_closed: true,
            idempotent_replay: true,
            last_inbound_message_id: estado.lastInboundMessageId,
            conversation: { ...c },
          },
          error: null,
        };
      }

      const errConflict = (reason: string) => ({
        data: null,
        error: {
          code: "PT409",
          message: `safe_close_conflict:${reason}`,
          details: JSON.stringify({ reason, conversation_id: c.id }),
        },
      });

      if (args.p_expected_revision != null && c.service_revision !== args.p_expected_revision) {
        return errConflict("service_revision_mismatch");
      }

      if (c.status === "closed" || c.status === "resolved" || c.status === "archived") {
        if (args.p_expected_status != null && c.status !== args.p_expected_status) {
          return errConflict("status_changed");
        }
        return {
          data: {
            closed: true,
            already_closed: true,
            idempotent_replay: false,
            last_inbound_message_id: estado.lastInboundMessageId,
            conversation: { ...c },
          },
          error: null,
        };
      }

      if (args.p_expected_status != null && c.status !== args.p_expected_status) {
        return errConflict("status_changed");
      }
      if (args.p_enforce_assignee && c.assigned_to_user_id !== (args.p_expected_assignee ?? null)) {
        return errConflict("assignee_changed");
      }
      if (args.p_enforce_sector && c.sector_id !== (args.p_expected_sector_id ?? null)) {
        return errConflict("sector_changed");
      }
      if (
        args.p_reject_human_assigned !== false &&
        (c.assigned_to_user_id !== null ||
          c.assignee_kind === "user" ||
          c.status === "claimed" ||
          (c.bot_silenced_until !== null && new Date(c.bot_silenced_until).getTime() > Date.now()))
      ) {
        return errConflict("human_attendance_active");
      }
      if (
        args.p_enforce_last_inbound_message &&
        estado.lastInboundMessageId !== (args.p_expected_last_inbound_message_id ?? null)
      ) {
        return errConflict("new_inbound_message");
      }
      if (
        args.p_expected_last_inbound_at != null &&
        c.last_inbound_at !== args.p_expected_last_inbound_at
      ) {
        return errConflict("new_inbound_message");
      }
      if (args.p_reject_open_pendencies !== false && estado.pendency !== null) {
        return errConflict(estado.pendency);
      }

      c.status = "closed";
      c.service_revision += 1;
      if (key) {
        c.metadata = { ...c.metadata, safe_close_idempotency_key: key };
      }

      return {
        data: {
          closed: true,
          already_closed: false,
          idempotent_replay: false,
          last_inbound_message_id: estado.lastInboundMessageId,
          conversation: { ...c },
        },
        error: null,
      };
    },
  };
}

let estado: EstadoSimulado;
let supabaseMock: ReturnType<typeof criarSupabaseMock>;

function chamarRota(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONV_ID}/close`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    }),
    { params: Promise.resolve({ id: CONV_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  estado = criarEstadoInicial();
  supabaseMock = criarSupabaseMock(estado);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(tetoDeEscritaDoToken).mockResolvedValue(null);
  vi.mocked(exigirControleDaConversa).mockResolvedValue(undefined);
  vi.mocked(pedirSatisfacaoAoEncerrar).mockResolvedValue({
    pedida: false,
    motivo: "desligada",
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(supabaseMock as never);
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    supabase: supabaseMock as never,
    organizationId: ORG_A,
    actor: { type: "api_token", id: TOKEN_ID },
    apiTokenId: TOKEN_ID,
    idioma: "pt-BR",
  } as never);
});

describe("PR 01 — Encerramento Seguro Condicional (REST + Handler + MCP)", () => {
  it("1. Encerramento válido com pré-condições corretas fecha, audita e atualiza revisão", async () => {
    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_status: "open",
      expected_last_inbound_message_id: MSG_IN_1,
      expected_assigned_to_user_id: null,
      expected_sector_id: SECTOR_1,
      idempotency_key: "req-1",
    });
    const json = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(json.data.status).toBe("closed");
    expect(json.data.service_revision).toBe(4);
    expect(json.data.already_closed).toBe(false);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(pedirSatisfacaoAoEncerrar).toHaveBeenCalledTimes(1);
  });

  it("2. Nova mensagem recebida entre avaliação e encerramento recusa com 409 new_inbound_message", async () => {
    estado.lastInboundMessageId = MSG_IN_2;

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
    });
    const json = (await res.json()) as { error: { code: string; details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("conflict");
    expect(json.error.details?.reason).toBe("new_inbound_message");
    expect(estado.conversation.status).toBe("open");
  });

  it("3. Mensagem recebida durante a operação concorrente (após lerConversa, antes do lock) é barrada atomicamente", async () => {
    estado.onBeforeRpcLock = () => {
      estado.lastInboundMessageId = MSG_IN_2;
    };

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
    });
    const json = (await res.json()) as { error: { details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(json.error.details?.reason).toBe("new_inbound_message");
    expect(estado.conversation.status).toBe("open");
  });

  it("4. Revisão desatualizada recusa com 409 service_revision_mismatch", async () => {
    estado.conversation.service_revision = 5;

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
    });
    const json = (await res.json()) as { error: { details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(json.error.details?.reason).toBe("service_revision_mismatch");
  });

  it("5. Mudança de responsável recusa com 409 assignee_changed", async () => {
    estado.conversation.assigned_to_user_id = USER_2;

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
      expected_assigned_to_user_id: USER_1,
    });
    const json = (await res.json()) as { error: { details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(json.error.details?.reason).toBe("assignee_changed");
  });

  it("6. Atendimento assumido por humano recusa com 409 human_attendance_active", async () => {
    estado.conversation.status = "claimed";
    estado.conversation.assignee_kind = "user";
    estado.conversation.assigned_to_user_id = USER_1;

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
    });
    const json = (await res.json()) as { error: { details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(json.error.details?.reason).toBe("human_attendance_active");
  });

  it("7. Transferência de departamento recusa com 409 sector_changed", async () => {
    estado.conversation.sector_id = SECTOR_2;

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
      expected_sector_id: SECTOR_1,
    });
    const json = (await res.json()) as { error: { details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(json.error.details?.reason).toBe("sector_changed");
  });

  it.each(["open_agent_case", "open_proposal", "open_task", "open_human_demand"] as const)(
    "8. Pendência impeditiva (%s) recusa com 409",
    async (pendencia) => {
      estado.pendency = pendencia;

      const res = await chamarRota({
        safe_close: true,
        expected_revision: 3,
        expected_last_inbound_message_id: MSG_IN_1,
      });
      const json = (await res.json()) as { error: { details?: { reason?: string } } };

      expect(res.status).toBe(409);
      expect(json.error.details?.reason).toBe(pendencia);
    },
  );

  it("9. Encerramentos simultâneos com expected_revision: apenas um fecha, o segundo recebe 409", async () => {
    const [r1, r2] = await Promise.all([
      chamarRota({
        safe_close: true,
        expected_revision: 3,
        expected_last_inbound_message_id: MSG_IN_1,
      }),
      chamarRota({
        safe_close: true,
        expected_revision: 3,
        expected_last_inbound_message_id: MSG_IN_1,
      }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);

    expect(statuses).toEqual([200, 409]);
    expect(estado.conversation.status).toBe("closed");
    expect(estado.conversation.service_revision).toBe(4);
  });

  it("10. Solicitação duplicada com mesma idempotency_key retorna 200 idempotente sem duplicar audit", async () => {
    const r1 = await chamarRota(
      { safe_close: true, expected_revision: 3, expected_last_inbound_message_id: MSG_IN_1 },
      { "Idempotency-Key": "dup-1" },
    );
    expect(r1.status).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);

    const r2 = await chamarRota(
      { safe_close: true, expected_revision: 3, expected_last_inbound_message_id: MSG_IN_1 },
      { "Idempotency-Key": "dup-1" },
    );
    const j2 = (await r2.json()) as {
      data: { idempotent_replay?: boolean; already_closed?: boolean };
    };

    expect(r2.status).toBe(200);
    expect(j2.data.idempotent_replay).toBe(true);
    expect(j2.data.already_closed).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(pedirSatisfacaoAoEncerrar).toHaveBeenCalledTimes(1);
  });

  it("11. Conversa já encerrada sem replay idempotente retorna 200 already_closed quando não reaberta", async () => {
    estado.conversation.status = "closed";
    estado.conversation.service_revision = 4;

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 4,
      expected_last_inbound_message_id: MSG_IN_1,
    });
    const json = (await res.json()) as { data: { already_closed?: boolean; status: string } };

    expect(res.status).toBe(200);
    expect(json.data.status).toBe("closed");
    expect(json.data.already_closed).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it("12. Conversa reaberta após avaliação (status voltou a open e revisão subiu) recusa com 409", async () => {
    estado.conversation.status = "open";
    estado.conversation.service_revision = 5;

    const res = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
    });
    expect(res.status).toBe(409);
  });

  it("13. Token sem autorização ou agente de IA é recusado com 403", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValueOnce({
      ok: false,
      response: new Response(
        JSON.stringify({ error: { code: "forbidden", message: "Sem escopo" } }),
        { status: 403 },
      ),
    } as never);
    const rRest = await chamarRota({ safe_close: true });
    expect(rRest.status).toBe(403);

    // Agente de IA no handler REST
    await expect(
      fecharConversaHandler(
        supabaseMock as never,
        {
          organization_id: ORG_A,
          actor: { type: "ai_agent", id: "agent-run-1" } as never,
          requestId: "req-ai",
          idioma: "pt-BR",
        },
        CONV_ID,
        { safeClose: true },
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });

    // Agente de IA na tool MCP
    const mcpCtxAgente: McpContext = {
      organizationId: ORG_A,
      actor: { type: "ai_agent", id: "agent-run-1" } as never,
      apiTokenId: TOKEN_ID,
      role: "admin",
      tokenScopes: ["mcp:write", "conversations:write"],
      requestId: "req-mcp-ai",
      supabase: supabaseMock as never,
    };
    await expect(
      crmCloseConversation.handler({ conversation_id: CONV_ID, safe_close: true }, mcpCtxAgente),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("14. Tentativa de acesso entre organizações retorna 404 sem vazar dados", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValueOnce({
      ok: true,
      supabase: supabaseMock as never,
      organizationId: ORG_B,
      actor: { type: "api_token", id: TOKEN_ID },
      apiTokenId: TOKEN_ID,
      idioma: "pt-BR",
    } as never);

    const res = await chamarRota({ safe_close: true, expected_revision: 3 });
    expect(res.status).toBe(404);
    expect(estado.conversation.status).toBe("open");
  });

  it("15. Regressão: fechamento manual legado (sem safe_close) continua usando fn_service_status", async () => {
    const res = await chamarRota({ expected_revision: 3 });
    const json = (await res.json()) as { data: { status: string; service_revision: number } };

    expect(res.status).toBe(200);
    expect(json.data.status).toBe("closed");
    expect(json.data.service_revision).toBe(4);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("15b. Regressão: o botão Fechar da tela manda Idempotency-Key em todo POST e segue no fechamento legado", async () => {
    // `lib/api/client.ts` carimba `Idempotency-Key` em todo POST; o cabeçalho
    // sozinho não pode ligar o modo condicional, senão a tela recebe 422.
    const res = await chamarRota({ expected_revision: 3 }, { "Idempotency-Key": "chave-do-apiclient" });
    const json = (await res.json()) as { data: { status: string; service_revision: number } };

    expect(res.status).toBe(200);
    expect(json.data.status).toBe("closed");
    expect(json.data.service_revision).toBe(4);
  });

  it("16. MCP crm_close_conversation funciona com token de integração autorizado (conversations:write)", async () => {
    const mcpCtxToken: McpContext = {
      organizationId: ORG_A,
      actor: { type: "api_token", id: TOKEN_ID },
      apiTokenId: TOKEN_ID,
      role: "agent",
      tokenScopes: ["mcp:write", "conversations:write"],
      requestId: "req-mcp-tok",
      supabase: supabaseMock as never,
    };
    const res = (await crmCloseConversation.handler(
      {
        conversation_id: CONV_ID,
        safe_close: true,
        expected_revision: 3,
        expected_last_inbound_message_id: MSG_IN_1,
      },
      mcpCtxToken,
    )) as Record<string, unknown>;

    expect(res.status).toBe("closed");
    expect(res.service_revision).toBe(4);
  });

  it("17. Pré-condições incompletas ou tentativa de desligar proteções recusam com 422", async () => {
    const rSemMsg = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_status: "open",
    });
    expect(rSemMsg.status).toBe(422);

    const rSemRev = await chamarRota({
      safe_close: true,
      expected_last_inbound_message_id: MSG_IN_1,
    });
    expect(rSemRev.status).toBe(422);

    const rContornoHumano = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
      reject_human_assigned: false,
    });
    expect(rContornoHumano.status).toBe(422);

    const rContornoPendencia = await chamarRota({
      safe_close: true,
      expected_revision: 3,
      expected_last_inbound_message_id: MSG_IN_1,
      reject_open_pendencies: false,
    });
    expect(rContornoPendencia.status).toBe(422);
    expect(estado.conversation.status).toBe("open");
  });
});
