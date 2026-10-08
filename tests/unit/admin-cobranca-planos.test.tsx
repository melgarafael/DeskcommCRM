/**
 * A aba de Planos de /admin/cobranca (spec da cobrança §9): criar, editar,
 * arquivar e marcar o plano do cadastro, pelas rotas das Tasks 23 e 24. O
 * formulário recusa antes da rota o que o banco recusaria (preço < R$ 5).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), refresh: vi.fn(), erro: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: h.erro } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post, patch: h.patch } }));

import { PlanosDaInstalacao, type PlanoDaTela } from "@/app/admin/(protected)/cobranca/_planos";

const PLANO: PlanoDaTela = {
  id: "cccccccc-0000-4000-8000-000000000001", nome: "Básico", preco_cents: 4990, intervalo: "mes", trial_dias: 14,
  max_assentos: 3, max_canais: null, teto_ia_usd_cents: null, padrao_no_cadastro: false, oferecido_ao_cliente: true, arquivado_em: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.post.mockResolvedValue({ data: PLANO });
  h.patch.mockResolvedValue({ data: PLANO });
});
afterEach(cleanup);

async function preencher(u: ReturnType<typeof userEvent.setup>, preco: string) {
  await u.type(screen.getByLabelText("Nome do plano"), "Pro");
  await u.type(screen.getByLabelText("Preço (R$)"), preco);
  await u.clear(screen.getByLabelText("Dias de teste grátis"));
  await u.type(screen.getByLabelText("Dias de teste grátis"), "7");
  await u.type(screen.getByLabelText("Máximo de pessoas"), "5");
}

describe("Planos da instalação", () => {
  it("criar manda centavos e limites vazios como nulos, e recarrega a tela", async () => {
    const u = userEvent.setup();
    render(<PlanosDaInstalacao planos={[]} />);
    await preencher(u, "99,90");
    await u.click(screen.getByRole("button", { name: "Salvar plano" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    expect(h.post).toHaveBeenCalledWith("/api/v1/admin/cobranca/planos", {
      nome: "Pro", preco_cents: 9990, intervalo: "mes", trial_dias: 7,
      max_assentos: 5, max_canais: null, teto_ia_usd_cents: null,
    });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("preço abaixo de R$ 5 não chega à rota", async () => {
    const u = userEvent.setup();
    render(<PlanosDaInstalacao planos={[]} />);
    await preencher(u, "4,99");
    await u.click(screen.getByRole("button", { name: "Salvar plano" }));
    expect(h.post).not.toHaveBeenCalled();
    expect(h.erro).toHaveBeenCalled();
  });

  it("arquivar e usar no cadastro são PATCH do plano", async () => {
    const u = userEvent.setup();
    render(<PlanosDaInstalacao planos={[PLANO]} />);
    await u.click(screen.getByRole("button", { name: "Arquivar" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`/api/v1/admin/cobranca/planos/${PLANO.id}`, { arquivado: true }));
    await u.click(screen.getByRole("button", { name: "Usar no cadastro" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`/api/v1/admin/cobranca/planos/${PLANO.id}`, { padrao_no_cadastro: true }));
  });

  it("editar carrega o plano no formulário e salva por PATCH", async () => {
    const u = userEvent.setup();
    render(<PlanosDaInstalacao planos={[PLANO]} />);
    await u.click(screen.getByRole("button", { name: "Editar" }));
    expect((screen.getByLabelText("Nome do plano") as HTMLInputElement).value).toBe("Básico");
    expect((screen.getByLabelText("Preço (R$)") as HTMLInputElement).value).toBe("49,90");
    await u.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1));
    expect(h.patch.mock.calls[0]![0]).toBe(`/api/v1/admin/cobranca/planos/${PLANO.id}`);
    expect(h.patch.mock.calls[0]![1]).toMatchObject({ nome: "Básico", preco_cents: 4990, max_assentos: 3 });
  });
  it("⭐ esconder um plano das empresas é PATCH, e o plano escondido mostra que só o dono o atribui", async () => {
    const u = userEvent.setup();
    const { rerender } = render(<PlanosDaInstalacao planos={[PLANO]} />);
    await u.click(screen.getByRole("button", { name: "Esconder das empresas" }));
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith(`/api/v1/admin/cobranca/planos/${PLANO.id}`, { oferecido_ao_cliente: false }),
    );
    rerender(<PlanosDaInstalacao planos={[{ ...PLANO, oferecido_ao_cliente: false }]} />);
    expect(screen.getByText("Só você atribui")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mostrar às empresas" })).toBeTruthy();
  });
});
