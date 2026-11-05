/**
 * A ação que entrega ao painel lateral o módulo COMPLETO (spec 33, F4, tarefa 5): organização da
 * sessão, mesma fonte da rota, e `null` para tudo que a rota responderia com 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireRole, modulosNaTela } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  modulosNaTela: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/extensions/modulos-na-tela", () => ({ modulosNaTela }));

import { moduloParaOPainel } from "./moduloParaOPainel";

const ORG = "00000000-0000-4000-8000-000000000001";
const MODULO = {
  slug: "acme-comanda",
  titulo: "Comanda",
  icone: "ListChecks",
  serviceOrigin: "https://comanda.exemplo.test",
  installationId: "00000000-0000-4000-8000-000000000003",
};

beforeEach(() => {
  requireRole.mockReset();
  modulosNaTela.mockReset();
  requireRole.mockResolvedValue({ ok: true, user: { idioma: "pt-BR" }, org: { orgId: ORG } });
  modulosNaTela.mockResolvedValue([MODULO]);
});

describe("moduloParaOPainel", () => {
  it("devolve o módulo da organização da SESSÃO", async () => {
    await expect(moduloParaOPainel(MODULO.slug)).resolves.toEqual(MODULO);
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
    expect(modulosNaTela).toHaveBeenCalledWith(ORG, { locale: "pt-BR" });
  });

  it("slug fora da lista da organização devolve null", async () => {
    await expect(moduloParaOPainel("outro-modulo")).resolves.toBeNull();
  });

  it("slug malformado devolve null sem consultar nada", async () => {
    for (const ruim of ["../x", "A_B", "", "a".repeat(200)]) {
      await expect(moduloParaOPainel(ruim)).resolves.toBeNull();
    }
    expect(requireRole).not.toHaveBeenCalled();
    expect(modulosNaTela).not.toHaveBeenCalled();
  });

  it("sessão recusada devolve null e nem consulta os módulos", async () => {
    requireRole.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    await expect(moduloParaOPainel(MODULO.slug)).resolves.toBeNull();
    expect(modulosNaTela).not.toHaveBeenCalled();
  });

  it("erro ao ler os módulos devolve null (lado seguro)", async () => {
    modulosNaTela.mockRejectedValue(new Error("banco fora"));
    await expect(moduloParaOPainel(MODULO.slug)).resolves.toBeNull();
  });
});
