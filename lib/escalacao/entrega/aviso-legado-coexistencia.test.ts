import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  enabled: undefined as unknown,
  queryError: null as unknown,
  apply: vi.fn(async () => ({ consumer_key: "legacy", status: "ok", detail: "native" })),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://example.invalid" } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { settings: { handoff_delivery: { enabled: f.enabled } } },
          error: f.queryError,
        }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/escalacao/aviso-de-handoff", () => ({
  aplicaAvisoHandoff: f.apply,
  criarPersistenciaAvisoHandoff: () => ({}),
  EVENTO_AVISO_HANDOFF: "ai.handoff_aviso_solicitado",
  HANDLER_AVISO_HANDOFF: "escalacao-aviso-handoff.v1",
}));
vi.mock("@/lib/escalacao/aviso-ao-suporte", () => ({ createSupabaseAvisoDb: () => ({}) }));
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: async () => ({}),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: async () => ({}),
}));
import { avisoDeHandoffHandler } from "../aviso-de-handoff.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
const row = { organization_id: "11111111-1111-4111-8111-111111111111" } as EventRow;
beforeEach(() => {
  f.enabled = undefined;
  f.queryError = null;
  f.apply.mockClear();
});
it.each([undefined, false, "true"])("config %s preserva aviso nativo", async (value) => {
  f.enabled = value;
  expect((await avisoDeHandoffHandler.handle(row)).status).toBe("ok");
  expect(f.apply).toHaveBeenCalledOnce();
});
it("opt-in explícito não dispara dois avisos de consumidores diferentes", async () => {
  f.enabled = true;
  expect((await avisoDeHandoffHandler.handle(row)).detail).toBe("handoff_delivery_owns_notice");
  expect(f.apply).not.toHaveBeenCalled();
});
it("falha de leitura não envia sem conseguir decidir o consumidor", async () => {
  f.queryError = { message: "synthetic failure" };
  expect((await avisoDeHandoffHandler.handle(row)).status).toBe("error");
  expect(f.apply).not.toHaveBeenCalled();
});
