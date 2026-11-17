import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const g = vi.hoisted(() => ({ db: vi.fn(), sync: vi.fn(), select: vi.fn(), ligado: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: g.db }));
vi.mock("@/lib/amigo/sync", () => ({ syncAmigo: g.sync }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: g.ligado }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { POST } from "./route";
const pedir = () =>
  POST(new NextRequest("http://localhost/api/v1/cron/amigo-sync", { method: "POST" }));
beforeEach(() => {
  vi.clearAllMocks();
  g.ligado.mockResolvedValue(true);
  g.from.mockImplementation(() => {
    let selection = "";
    const q = {
      select: (value: string) => {
        selection = value;
        g.select(value);
        return q;
      },
      eq: () => q,
      or: () => q,
      order: () => q,
      limit: async () =>
        selection.includes("!amigo_connections_organization_id_fkey!inner")
          ? { data: [], error: null }
          : { data: null, error: { code: "PGRST201" } },
    };
    return q;
  });
  g.db.mockReturnValue({ from: g.from });
});
it("usa a chave estrangeira explícita para evitar os relacionamentos ambíguos do PostgREST", async () => {
  const response = await pedir();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { examined: 0, failed: 0 } });
  expect(g.sync).not.toHaveBeenCalled();
});
it("com o módulo desligado a rodada sai sem ler nenhuma tabela do módulo", async () => {
  g.ligado.mockResolvedValue(false);
  const response = await pedir();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { pulado: "modulo_desligado" } });
  expect(g.from).not.toHaveBeenCalled();
  expect(g.sync).not.toHaveBeenCalled();
});
