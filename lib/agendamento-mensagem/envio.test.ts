// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/cron/mensagens-agendadas/route";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: vi.fn(() => true) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: vi.fn(async () => ({ conversation_id: "conversation-1" })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));

let appointment: Record<string, unknown>;
let sessionError: { message: string; code: string } | null;
let sessionStatus: string | null;
let updates: Array<Record<string, unknown>>;
let sessionFilters: Array<[string, unknown]>;

function admin() {
  return {
    from(table: string) {
      if (table === "conversations") {
        // A escolha da conversa conectada lê as conversas do contato (com a sessão embutida).
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            sessionFilters.push([column, value]);
            return query;
          },
          then(resolve: (value: unknown) => unknown) {
            const linhas = [
              {
                id: "conv-1",
                channel_session_id: "session-1",
                last_inbound_at: null,
                created_at: null,
                channel_sessions: { status: sessionStatus },
              },
            ];
            return Promise.resolve({ data: sessionError ? null : linhas, error: sessionError }).then(resolve);
          },
        };
        return query;
      }
      if (table === "user_organizations" || table === "channel_sessions") {
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            // A sessão original é lida antes das conversas: os filtros dela também contam.
            if (table === "channel_sessions") sessionFilters.push([column, value]);
            return query;
          },
          is: () => query,
          maybeSingle: async () =>
            table === "user_organizations"
              ? { data: { role: "agent" }, error: null }
              : {
                  data: sessionError ? null : sessionStatus ? { status: sessionStatus } : null,
                  error: sessionError,
                },
        };
        return query;
      }
      if (table !== "mensagens_agendadas") throw new Error(`Unexpected table: ${table}`);
      let patch: Record<string, unknown> | null = null;
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        update: (values: Record<string, unknown>) => {
          patch = values;
          return query;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return query;
        },
        lte: () => query,
        order: () => query,
        limit: () => query,
        or: () => query,
        then(resolve: (value: unknown) => unknown) {
          if (appointment.status !== "agendada")
            return Promise.resolve({ data: [], error: null }).then(resolve);
          if (patch) {
            const claiming = typeof patch.claimed_until === "string";
            if (
              claiming &&
              appointment.claimed_until &&
              new Date(String(appointment.claimed_until)) >= new Date()
            ) {
              return Promise.resolve({ data: [], error: null }).then(resolve);
            }
            if (filters.id !== appointment.id) throw new Error("Unexpected appointment id");
            updates.push(patch);
            Object.assign(appointment, patch);
          }
          return Promise.resolve({ data: [{ ...appointment }], error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

function tick() {
  return GET(new NextRequest("http://localhost/api/v1/cron/mensagens-agendadas"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T12:00:00.000Z"));
  appointment = {
    id: "scheduled-1",
    organization_id: "org-1",
    organizations: { status: "active" },
    contact_id: "contact-1",
    conversation_id: "conv-1",
    channel_session_id: "session-1",
    created_by_user_id: "user-1",
    body: "Scheduled text",
    scheduled_at: "2026-11-16T11:59:00.000Z",
    se_desconectado: "cancelar",
    status: "agendada",
    claimed_until: null,
  };
  sessionError = null;
  sessionStatus = "WORKING";
  updates = [];
  sessionFilters = [];
  vi.mocked(autorizaCron).mockReturnValue(true);
  vi.mocked(createAdminClient).mockReturnValue(admin() as never);
  vi.mocked(sendMessageHandler).mockResolvedValue({ id: "message-1", status: "sent" } as never);
});

afterEach(() => vi.useRealTimers());

describe("scheduled messages and connection lookup failures", () => {
  it.each(["cancelar", "esperar"])(
    "keeps %s pending on a failed lookup and dispatches after recovery",
    async (policy) => {
      appointment.se_desconectado = policy;
      sessionError = { code: "57014", message: "statement timeout" };
      await expect(tick()).rejects.toThrow("statement timeout");
      expect(appointment.status).toBe("agendada");
      expect(updates.some((u) => "status" in u)).toBe(false);
      expect(sendMessageHandler).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      // A leitura que falha é a da sessão original, filtrada pela organização.
      expect(sessionFilters).toEqual([
        ["id", "session-1"],
        ["organization_id", "org-1"],
      ]);

      sessionError = null;
      vi.setSystemTime(new Date("2026-11-16T12:05:01.000Z"));
      const response = await tick();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { encaminhadas: 1, canceladas: 0 } });
      expect(appointment).toMatchObject({ status: "encaminhada", message_id: "message-1" });
      expect(sendMessageHandler).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "scheduled_message.dispatched" }),
      );
    },
  );

  it("still cancels a confirmed disconnected session under the cancel policy", async () => {
    sessionStatus = "STOPPED";
    expect((await tick()).status).toBe(200);
    expect(appointment).toMatchObject({ status: "cancelada", motivo: "numero_desconectado" });
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "scheduled_message.cancelled" }),
    );
  });

  it("still waits for a confirmed disconnected session under the wait policy", async () => {
    appointment.se_desconectado = "esperar";
    sessionStatus = "STOPPED";
    const response = await tick();
    expect(await response.json()).toMatchObject({ data: { esperando: 1, canceladas: 0 } });
    expect(appointment).toMatchObject({ status: "agendada", claimed_until: null });
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("still treats an absent session as disconnected", async () => {
    sessionStatus = null;
    await tick();
    expect(appointment).toMatchObject({ status: "cancelada", motivo: "numero_desconectado" });
  });

  it("preserves the cron authorization refusal", async () => {
    vi.mocked(autorizaCron).mockReturnValue(false);
    expect((await tick()).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
