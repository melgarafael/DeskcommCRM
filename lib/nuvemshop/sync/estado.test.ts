import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { marcarIntegracaoDesautorizada } from "./desautorizada";
import { fecharRun, type EstadoDoSync } from "./estado";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/** Dublê encadeável: toda cadeia resolve em `resultados[tabela]` (ou vazio). */
function fakeAdmin(resultados: Record<string, { data?: unknown; error?: unknown }[]>) {
  const chamadas: string[] = [];
  const admin = {
    from(tabela: string) {
      chamadas.push(tabela);
      const r = resultados[tabela]?.shift() ?? { data: null, error: null };
      const cadeia: Record<string, unknown> = {};
      for (const m of ["update", "insert", "select", "eq"]) cadeia[m] = () => cadeia;
      cadeia.maybeSingle = () => Promise.resolve(r);
      cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve(r).then(ok);
      return cadeia;
    },
  };
  return { admin: admin as unknown as SupabaseClient, chamadas };
}

const AGORA = new Date("2026-10-08T12:00:00.000Z");
const estado = (runId: string | null) => ({ organization_id: "org-1", run_id: runId, alvo_fim: AGORA.toISOString() }) as EstadoDoSync;

describe("fecharRun", () => {
  it("run_id nulo → null, sem consulta", async () => {
    const { admin, chamadas } = fakeAdmin({});
    await expect(fecharRun(admin, estado(null), AGORA)).resolves.toBeNull();
    expect(chamadas).toEqual([]);
  });

  it("fechamento que não casou não toca tenant_integrations", async () => {
    const { admin, chamadas } = fakeAdmin({ integration_sync_state: [{ data: null }] });
    await expect(fecharRun(admin, estado("r1"), AGORA)).resolves.toBeNull();
    expect(chamadas).toEqual(["integration_sync_state"]);
  });

  it("erro ao gravar last_sync_at lança", async () => {
    const { admin } = fakeAdmin({ integration_sync_state: [{ data: { organization_id: "org-1" } }], tenant_integrations: [{ error: { message: "x" } }] });
    await expect(fecharRun(admin, estado("r1"), AGORA)).rejects.toThrow("sync_state_last_sync:x");
  });
});

describe("marcarIntegracaoDesautorizada", () => {
  it("erro no 1º update lança e não abre aviso", async () => {
    const { admin, chamadas } = fakeAdmin({ tenant_integrations: [{ error: { code: "XX000" } }] });
    await expect(marcarIntegracaoDesautorizada(admin, { id: "i", organizationId: "org-1" })).rejects.toThrow("desautorizar_integracao:XX000");
    expect(chamadas).not.toContain("agent_inbox_items");
  });

  it("erro no estado lança e não abre aviso", async () => {
    const { admin, chamadas } = fakeAdmin({ integration_sync_state: [{ error: { code: "XX001" } }] });
    await expect(marcarIntegracaoDesautorizada(admin, { id: "i", organizationId: "org-1" })).rejects.toThrow("desautorizar_estado:XX001");
    expect(chamadas).not.toContain("agent_inbox_items");
  });
});
