import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/cron/mensagens-agendadas/route";
import { encaminharAgendamento } from "@/lib/agendamento-mensagem/envio";

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/agendamento-mensagem/envio", () => ({
  autorAindaTemAcesso: vi.fn(async () => true),
  sessaoEstaConectada: vi.fn(async () => true),
  encaminharAgendamento: vi.fn(async () => ({
    desfecho: "encaminhada",
    message_id: "message",
  })),
}));

const ativa = {
  id: "active-message",
  organization_id: "active-org",
  scheduled_at: "2026-01-02T10:00:00.000Z",
  organizations: { status: "active" },
};

const fila = [
  ...Array.from({ length: 50 }, (_, i) => ({
    id: `paused-message-${i}`,
    organization_id: "paused-org",
    scheduled_at: "2026-01-01T10:00:00.000Z",
    organizations: { status: "suspended" },
  })),
  ativa,
];

const admin = createClient("http://database.test", "test-key", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const colunas = url.searchParams.get("select");
      if (url.pathname.endsWith("/organizations")) {
        return Response.json([{ id: "paused-org" }]);
      }
      if (init?.method === "PATCH") {
        if (!colunas) return new Response(null, { status: 204 });
        return Response.json(fila.filter((linha) => url.searchParams.get("id") === `eq.${linha.id}`));
      }

      // PostgREST filters parent rows by embedded status only with an inner join.
      const filtraOrg =
        colunas?.includes("organizations:organization_id!inner(status)") &&
        url.searchParams.get("organizations.status") === "eq.active";
      const devidas = filtraOrg ? fila.filter((linha) => linha.organizations.status === "active") : fila;
      return Response.json(devidas.slice(0, Number(url.searchParams.get("limit"))));
    },
  },
});

describe("scheduled messages batch", () => {
  it("dispatches an active organization's message when older suspended rows fill the batch", async () => {
    const res = await GET(new NextRequest("http://localhost/api/v1/cron/mensagens-agendadas"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { processadas: 1, encaminhadas: 1 } });
    expect(encaminharAgendamento).toHaveBeenCalledTimes(1);
    expect(encaminharAgendamento).toHaveBeenCalledWith(admin, expect.objectContaining({ id: ativa.id }));
  });
});
