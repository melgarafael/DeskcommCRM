import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processarDesinstalacao } from "./desinstalacao.handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

function adminFalso() {
  const chamadas: Array<{ tabela: string; patch: unknown; filtros: Array<[string, unknown]> }> = [];
  const admin = {
    from: (tabela: string) => ({
      update: (patch: unknown) => {
        const reg = { tabela, patch, filtros: [] as Array<[string, unknown]> };
        chamadas.push(reg);
        const cadeia = {
          eq: (c: string, v: unknown) => { reg.filtros.push([c, v]); return cadeia; },
          select: () => ({ maybeSingle: async () => ({ data: { id: "integ-1" }, error: null }) }),
          then: (ok: (v: { error: null }) => unknown) => ok({ error: null }),
        };
        return cadeia;
      },
    }),
  } as unknown as SupabaseClient;
  return { admin, chamadas };
}

const row: EventRow = {
  id: "ev", organization_id: "org-1", event_type: "nuvemshop.app_uninstalled", entity_kind: "nuvemshop_webhook",
  entity_id: null, payload: { store_id: "s1" }, metadata: {}, consumed_by: [], attempts: 0,
};

describe("nuvemshop-desinstalacao.v1", () => {
  it("desconecta a integração DA ORG e libera o run", async () => {
    const { admin, chamadas } = adminFalso();
    expect((await processarDesinstalacao(row, admin)).status).toBe("ok");
    const integ = chamadas.find((c) => c.tabela === "tenant_integrations")!;
    expect(integ.patch).toMatchObject({ status: "disconnected", status_reason: "app_uninstalled" });
    expect(integ.filtros).toContainEqual(["organization_id", "org-1"]);
    expect(chamadas.some((c) => c.tabela === "integration_sync_state")).toBe(true);
  });
});
