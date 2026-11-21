/**
 * A ROTA `/app/m/[modulo]` (spec 33, F4, tarefa 3).
 *
 * Prova: a organização vem da sessão (`requireRole("viewer")`), o módulo é procurado dentre os que
 * `modulosNaTela(org)` devolve, e ausente (desligado, removido, fora da faixa, sem endereço, de outra
 * organização) ou sessão recusada vira 404. Título da página = título do módulo.
 */
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireRole, modulosNaTela, quadro } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  modulosNaTela: vi.fn(),
  quadro: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/extensions/modulos-na-tela", () => ({ modulosNaTela }));
vi.mock("@/components/modulo/QuadroDoModulo", () => ({
  QuadroDoModulo: (props: { modulo: { slug: string } }) => {
    quadro(props);
    return <div data-testid="quadro">{props.modulo.slug}</div>;
  },
}));

import ModuloPage from "./page";

const ORG = "00000000-0000-4000-8000-000000000001";
const MODULO = {
  slug: "equipe-exemplo-modulo",
  titulo: "Módulo de exemplo",
  icone: "ListChecks",
  serviceOrigin: "https://modulo.exemplo.test",
  installationId: "00000000-0000-4000-8000-000000000003",
};

beforeEach(() => {
  requireRole.mockReset();
  modulosNaTela.mockReset();
  quadro.mockReset();
  requireRole.mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG },
  });
  modulosNaTela.mockResolvedValue([MODULO]);
});

describe("/app/m/[modulo]", () => {
  it("exige sessão de viewer e procura o módulo na organização da SESSÃO", async () => {
    const pagina = await ModuloPage({ params: Promise.resolve({ modulo: MODULO.slug }) });
    const vista = render(pagina);
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
    expect(modulosNaTela).toHaveBeenCalledWith(ORG, { locale: "pt-BR" });
    expect(vista.getByTestId("quadro").textContent).toBe(MODULO.slug);
    expect(quadro).toHaveBeenCalledWith({ modulo: MODULO });
  });

  it("título da página = título do módulo", async () => {
    const vista = render(
      await ModuloPage({ params: Promise.resolve({ modulo: MODULO.slug }) }),
    );
    expect(document.querySelector("title")?.textContent ?? vista.container.textContent).toContain(
      MODULO.titulo,
    );
  });

  it("slug que não está na lista da organização dá 404", async () => {
    await expect(
      ModuloPage({ params: Promise.resolve({ modulo: "outro-modulo" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("organização sem nenhum módulo dá 404", async () => {
    modulosNaTela.mockResolvedValue([]);
    await expect(
      ModuloPage({ params: Promise.resolve({ modulo: MODULO.slug }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sessão recusada dá 404 e nem consulta os módulos", async () => {
    requireRole.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    await expect(
      ModuloPage({ params: Promise.resolve({ modulo: MODULO.slug }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(modulosNaTela).not.toHaveBeenCalled();
  });
});
