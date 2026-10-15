/**
 * O card Cobrança do painel do tenant (spec da cobrança §7g, §9): atribuir um
 * plano à isenta, trocar em teste, dar prazo e tornar isenta — cada ação é uma
 * rota do dono, e a tela recarrega depois.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), del: vi.fn(), refresh: vi.fn(), invalidate: vi.fn(), showApiError: vi.fn(), copiar: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: h.invalidate }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post, patch: h.patch, delete: h.del } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: h.showApiError }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: h.copiar }));

import { CardDeCobranca, fimDoDia } from "@/components/admin/tenants/CardDeCobranca";
import { ApiError } from "@/lib/api/types";

const ORG = "bbbbbbbb-0000-4000-8000-000000000001";
const BASE = `/api/v1/admin/tenants/${ORG}/assinatura`;
const BASICO = { id: "cccccccc-0000-4000-8000-000000000001", nome: "Básico", arquivado_em: null };
const PRO = { id: "cccccccc-0000-4000-8000-000000000002", nome: "Pro", arquivado_em: null };
const VELHO = { id: "cccccccc-0000-4000-8000-000000000003", nome: "Velho", arquivado_em: "2026-09-01T00:00:00Z" };
const EM_TESTE = { plano_id: BASICO.id, estado: "trial" as const, trial_ate: "2026-10-10T12:00:00Z", prazo_extra_ate: null, provedor: null, plano_agendado_id: null, proximo_vencimento: null };

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of [h.post, h.patch, h.del]) f.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe("card Cobrança do tenant", () => {
  it("isenta: diz isso, oferece só planos ativos, e atribuir chama POST", async () => {
    const u = userEvent.setup();
    render(<CardDeCobranca orgId={ORG} planos={[BASICO, PRO, VELHO]} assinatura={null} suspensaPorCobranca={false} rotuloAntigo={null} />);
    expect(screen.getByText("Isenta: não paga e não tem limites.")).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Velho" })).toBeNull();
    await u.selectOptions(screen.getByLabelText("Plano da empresa"), PRO.id);
    await u.click(screen.getByRole("button", { name: "Atribuir plano" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(BASE, { plano_id: PRO.id }));
    expect(h.refresh).toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "tenant", ORG] });
    expect(screen.queryByRole("button", { name: "Dar prazo" })).toBeNull();
  });

  it("com assinatura: trocar é PATCH, dar prazo manda o fim do dia, tornar isenta é DELETE", async () => {
    const u = userEvent.setup();
    render(<CardDeCobranca orgId={ORG} planos={[BASICO, PRO]} assinatura={EM_TESTE} suspensaPorCobranca={false} rotuloAntigo={null} />);
    expect(screen.getByText("Teste grátis")).toBeTruthy();
    await u.selectOptions(screen.getByLabelText("Plano da empresa"), PRO.id);
    await u.click(screen.getByRole("button", { name: "Trocar plano" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(BASE, { plano_id: PRO.id }));
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    await u.type(screen.getByLabelText("Dar prazo até"), "2026-10-20");
    await u.click(screen.getByRole("button", { name: "Dar prazo" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/prazo`, { ate: fimDoDia("2026-10-20") }));
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(2));
    await u.click(screen.getByRole("button", { name: "Tornar isenta" }));
    await waitFor(() => expect(h.del).toHaveBeenCalledWith(BASE));
    // Ações e banner da página leem o cache ["admin","tenant",id]; o refresh não o toca.
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(3));
    expect(h.invalidate).toHaveBeenLastCalledWith({ queryKey: ["admin", "tenant", ORG] });
  });

  it("suspensa por cobrança sem linha: avisa e ainda oferece tornar isenta (cura a tentativa que caiu)", async () => {
    const u = userEvent.setup();
    render(<CardDeCobranca orgId={ORG} planos={[BASICO]} assinatura={null} suspensaPorCobranca rotuloAntigo="pro" />);
    expect(screen.getByRole("status").textContent).toContain("Suspensa por falta de pagamento");
    expect(screen.getByRole("button", { name: "Tornar isenta" })).toBeTruthy();
    expect(screen.getByText(/Rótulo antigo:/).textContent).toContain("pro");
    await u.click(screen.getByRole("button", { name: "Tornar isenta" }));
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "tenant", ORG] }));
  });

  it("⭐ trocar para um plano onde o uso não cabe: a LISTA do que remover (D-4), sem toast genérico nem refresh", async () => {
    const u = userEvent.setup();
    h.patch.mockRejectedValueOnce(
      new ApiError(409, "plan_limit_reached", { excedente: { assentos: 2, canais: 1 } }, "req-1", "O uso atual não cabe no plano escolhido."),
    );
    render(<CardDeCobranca orgId={ORG} planos={[BASICO, PRO]} assinatura={EM_TESTE} suspensaPorCobranca={false} rotuloAntigo={null} />);
    await u.selectOptions(screen.getByLabelText("Plano da empresa"), PRO.id);
    await u.click(screen.getByRole("button", { name: "Trocar plano" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("Revogue o acesso de 2 pessoa(s) em Equipe.");
    expect(alerta.textContent).toContain("Exclua 1 número(s) em Conexões.");
    expect(h.showApiError).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("outro erro da rota segue pelo toast de sempre, e nenhuma lista aparece", async () => {
    const u = userEvent.setup();
    const erro = new ApiError(409, "pagamento_pendente", undefined, "req-2", "O teste grátis acabou.");
    h.patch.mockRejectedValueOnce(erro);
    render(<CardDeCobranca orgId={ORG} planos={[BASICO, PRO]} assinatura={EM_TESTE} suspensaPorCobranca={false} rotuloAntigo={null} />);
    await u.click(screen.getByRole("button", { name: "Trocar plano" }));
    await waitFor(() => expect(h.showApiError).toHaveBeenCalledWith(erro));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fimDoDia devolve ISO UTC do fim daquele dia local", () => {
    expect(new Date(fimDoDia("2026-10-20")).getTime()).toBe(new Date(2026, 9, 20, 23, 59, 59).getTime());
  });
});

describe("link de pagamento", () => {
  const LINK = "https://checkout.stripe.com/c/pay/cs_test_link";
  const CNPJ = "11222333000181";
  const gerar = () => screen.getByRole("button", { name: "Gerar link de pagamento" });
  const card = (extra: Partial<Parameters<typeof CardDeCobranca>[0]> = {}) =>
    render(<CardDeCobranca orgId={ORG} planos={[BASICO]} assinatura={EM_TESTE} suspensaPorCobranca={false} rotuloAntigo={null} {...extra} />);

  it("campo só com pedeDocumento, pré-preenchido; dígito errado desabilita e não posta", async () => {
    const u = userEvent.setup();
    card();
    expect(screen.queryByLabelText("CPF ou CNPJ de quem paga")).toBeNull();
    cleanup();
    card({ pedeDocumento: true, documentoDoCadastro: CNPJ });
    const campo = screen.getByLabelText("CPF ou CNPJ de quem paga") as HTMLInputElement;
    expect(campo.value).toBe(CNPJ);
    expect((gerar() as HTMLButtonElement).disabled).toBe(false);
    await u.clear(campo);
    await u.type(campo, "11.222.333/0001-80");
    expect(campo.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Confira o CPF ou CNPJ: os dígitos não batem.")).toBeTruthy();
    expect((gerar() as HTMLButtonElement).disabled).toBe(true);
    await u.click(gerar());
    expect(h.post).not.toHaveBeenCalled();
  });

  it("POST em ${BASE}/checkout com o documento sem máscara; o link aparece readOnly e Copiar chama copyToClipboard", async () => {
    const u = userEvent.setup();
    h.post.mockResolvedValueOnce({ data: { url: LINK } });
    h.copiar.mockResolvedValue(true);
    card({ pedeDocumento: true });
    expect((gerar() as HTMLButtonElement).disabled).toBe(true);
    await u.type(screen.getByLabelText("CPF ou CNPJ de quem paga"), "11.222.333/0001-81");
    await u.click(gerar());
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/checkout`, { documento: CNPJ }));
    const campo = (await screen.findByLabelText("Link de pagamento")) as HTMLInputElement;
    expect(campo.value).toBe(LINK);
    expect(campo.readOnly).toBe(true);
    expect(h.refresh).toHaveBeenCalled();
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "tenant", ORG] }));
    await u.click(screen.getByRole("button", { name: "Copiar link de pagamento" }));
    expect(h.copiar).toHaveBeenCalledWith(LINK);
  });

  it("⭐ trocar o plano tira o link da tela (a troca o expira no provedor); troca recusada o mantém", async () => {
    const u = userEvent.setup();
    h.post.mockResolvedValueOnce({ data: { url: LINK } });
    card({ planos: [BASICO, PRO] });
    await u.click(gerar());
    await screen.findByLabelText("Link de pagamento");
    const erro = new ApiError(409, "conflict", undefined, "req-4", "Recusado.");
    h.patch.mockRejectedValueOnce(erro);
    await u.click(screen.getByRole("button", { name: "Trocar plano" }));
    await waitFor(() => expect(h.showApiError).toHaveBeenCalledWith(erro));
    expect(screen.getByLabelText("Link de pagamento")).toBeTruthy();
    await u.selectOptions(screen.getByLabelText("Plano da empresa"), PRO.id);
    await u.click(screen.getByRole("button", { name: "Trocar plano" }));
    await waitFor(() => expect(h.patch).toHaveBeenLastCalledWith(BASE, { plano_id: PRO.id }));
    await waitFor(() => expect(screen.queryByLabelText("Link de pagamento")).toBeNull());
    expect(screen.queryByRole("button", { name: "Copiar link de pagamento" })).toBeNull();
  });

  it("sem pedeDocumento posta {}", async () => {
    const u = userEvent.setup();
    h.post.mockResolvedValueOnce({ data: { url: LINK } });
    card();
    await u.click(gerar());
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/checkout`, {}));
  });

  it("sem bloco em ativa e em isenta", () => {
    card({ assinatura: { ...EM_TESTE, estado: "ativa" } });
    expect(screen.queryByRole("button", { name: "Gerar link de pagamento" })).toBeNull();
    cleanup();
    card({ assinatura: null, pedeDocumento: true });
    expect(screen.queryByRole("button", { name: "Gerar link de pagamento" })).toBeNull();
    expect(screen.queryByLabelText("CPF ou CNPJ de quem paga")).toBeNull();
  });

  it("erro vai para showApiError e não mostra link", async () => {
    const u = userEvent.setup();
    const erro = new ApiError(409, "empresa_sem_email", undefined, "req-3", "A empresa ainda não tem administrador com e-mail. Gere o link depois que um convite de administrador for aceito.");
    h.post.mockRejectedValueOnce(erro);
    card();
    await u.click(gerar());
    await waitFor(() => expect(h.showApiError).toHaveBeenCalledWith(erro));
    expect(screen.queryByLabelText("Link de pagamento")).toBeNull();
    expect(h.refresh).not.toHaveBeenCalled();
    expect((gerar() as HTMLButtonElement).disabled).toBe(false);
  });
});
