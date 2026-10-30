import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ configured: vi.fn(), admin: vi.fn(), get: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: mocks.configured }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/logger", () => ({ logger: { info: mocks.info, warn: mocks.warn } }));
import { rotulosDosResponsaveisDaAgenda } from "./rotulos-dos-responsaveis";
import { sufixoDoMembro } from "@/lib/users/rotulo-do-atendente";
beforeEach(() => {
  vi.resetAllMocks(); mocks.configured.mockReturnValue(true);
  mocks.admin.mockReturnValue({ auth: { admin: { getUserById: mocks.get } } });
  mocks.get.mockImplementation(async (id: string) => ({ data: { user: { id, email: `${id}@example.test`, user_metadata: {} } }, error: null }));
});
describe("leitura mínima dos IDs previamente autorizados", () => {
  it("consulta apenas IDs recebidos, deduplica e não lista usuários", async () => {
    const r = await rotulosDosResponsaveisDaAgenda(["a", "a", "b"]);
    expect(mocks.get.mock.calls).toEqual([["a"], ["b"]]);
    expect([...r.keys()]).toEqual(["a", "b"]);
    expect(r.get("foreign")).toBeUndefined();
    expect(r.get("a")).toEqual({ full_name: null, display_label: "a@example.test" });
  });
  it("sem membros não inicializa admin", async () => {
    expect((await rotulosDosResponsaveisDaAgenda([])).size).toBe(0); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("sem service role conserva cada ID com estado explícito", async () => {
    mocks.configured.mockReturnValue(false);
    const r = await rotulosDosResponsaveisDaAgenda(["a", "b"]);
    expect(r.get("a")?.display_label).toBe(`Identidade indisponível · ${sufixoDoMembro("a")}`);
    expect(r.get("b")?.display_label).toBe(`Identidade indisponível · ${sufixoDoMembro("b")}`); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("falha ao inicializar admin não derruba a página", async () => {
    mocks.admin.mockImplementation(() => { throw Error("private@example.test"); });
    expect((await rotulosDosResponsaveisDaAgenda(["a"])).get("a")?.display_label).toBe(`Identidade indisponível · ${sufixoDoMembro("a")}`);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private@example.test");
  });
  it.each(["error", "throw", "missing", "wrong-id"])("falha %s não vira identidade vazia nem atribui outro usuário", async (kind) => {
    mocks.get.mockImplementation(async (id: string) => {
      if (id === "b") return { data: { user: { id, user_metadata: { full_name: "  Bruno  " } } }, error: null };
      if (kind === "throw") throw Error("secret@example.test");
      return { data: { user: kind === "missing" ? null : { id: kind === "wrong-id" ? "foreign" : id, email: "secret@example.test" } }, error: kind === "error" ? { message: "secret@example.test" } : null };
    });
    const r = await rotulosDosResponsaveisDaAgenda(["a", "b"]);
    expect(r.get("a")).toEqual({ full_name: null, display_label: `Identidade indisponível · ${sufixoDoMembro("a")}` });
    expect(r.get("b")).toEqual({ full_name: "Bruno", display_label: "Bruno" });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("secret@example.test");
  });
});
