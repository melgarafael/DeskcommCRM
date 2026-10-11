/**
 * Plano e cobrança com o provedor (spec da cobrança §7b–§7f, §9): cada botão é
 * uma rota da empresa, e cada situação é uma frase que um leigo entende.
 * Pagar em um clique é o que recupera a receita do revendedor.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn(), refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), abrir: vi.fn(), showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: h.push, replace: h.replace }) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post } }));
vi.mock("@/lib/cobranca/navegar", () => ({ abrirNoNavegador: h.abrir }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: h.showApiError }));

import { ApiError } from "@/lib/api/types";
import { AcoesDaAssinatura, type PropsDasAcoes } from "@/components/cobranca/AcoesDaAssinatura";
import { PainelDaAssinatura } from "@/components/cobranca/PainelDaAssinatura";
import type { DadosDoPainel } from "@/lib/cobranca/painel";

const PLANO = { id: "plano-a", nome: "Essencial", preco_cents: 4990, intervalo: "mes", max_assentos: null, max_canais: null, teto_ia_usd_cents: null };
const PRO = { id: "plano-b", nome: "Profissional", preco_cents: 9990, intervalo: "mes" };
const BASE: NonNullable<DadosDoPainel["assinatura"]> = {
  estado: "ativa", trial_ate: null, prazo_extra_ate: null, proximo_vencimento: "2026-11-01T12:00:00Z", vencida_desde: null,
  cancela_no_fim: false, modo: "teste", provedor: "stripe", link_de_pagamento: null, assinaturas_vivas: 1, plano_agendado: null,
};
const painel = (a: Partial<typeof BASE>): DadosDoPainel => ({
  assinatura: { ...BASE, ...a }, plano: PLANO, uso: { assentos: 1, canais: 1 }, gastoIaUsdCents: 0, planosParaTroca: [PRO], fuso: null,
  checkout: { provedor: "stripe", documentoDoCadastro: null },
});
const acoes = (p: Partial<PropsDasAcoes> = {}): PropsDasAcoes => ({
  estado: "ativa", temProvedor: true, assinaturasVivas: 1, linkDePagamento: null, cancelaNoFim: false,
  planosParaTroca: [PRO], voltouDoCheckout: false, noHub: false, provedor: "stripe", documentoDoCadastro: null, ...p,
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("as situações, em frases", () => {
  it.each([
    [{ estado: "trial" as const, trial_ate: "2026-10-20T12:00:00Z", assinaturas_vivas: 1 }, /^Teste grátis até \d{2}\/\d{2}\/\d{4} · 1ª cobrança agendada$/],
    [{ estado: "em_atraso" as const, vencida_desde: "2026-10-05T12:00:00Z" }, /^Em atraso desde \d{2}\/\d{2}\/\d{4}$/],
    [{ cancela_no_fim: true }, /^Cancelada, acesso até \d{2}\/\d{2}\/\d{4}$/],
  ])("%j", (a, frase) => {
    render(<PainelDaAssinatura dados={painel(a)} idioma="pt-BR" />);
    expect(screen.getByText(frase)).toBeTruthy();
  });

  it("o plano agendado aparece com a data em que vale", () => {
    render(<PainelDaAssinatura dados={painel({ plano_agendado: { id: "plano-b", nome: "Profissional" } })} idioma="pt-BR" />);
    expect(screen.getByText(/Novo plano a partir de \d{2}\/\d{2}\/\d{4}: Profissional/)).toBeTruthy();
  });
});

describe("AcoesDaAssinatura", () => {
  it("⭐ Assinar abre o checkout do provedor", async () => {
    h.post.mockResolvedValue({ data: { url: "https://checkout.stripe.com/c/pay/cs_1" } });
    render(<AcoesDaAssinatura {...acoes({ estado: "trial", temProvedor: false, assinaturasVivas: 0 })} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Assinar" }));
    await waitFor(() => expect(h.abrir).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_1"));
    expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/checkout", {});
  });

  it("⭐ em atraso: Pagar agora é o link da fatura, e Já paguei diz quando ainda não identificou", async () => {
    h.post.mockResolvedValue({ data: { estado: "em_atraso", assinaturas_vivas: 1, org_operante: true } });
    render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", linkDePagamento: "https://invoice.stripe.com/i/x" })} />);
    expect(screen.getByRole("link", { name: "Pagar agora" }).getAttribute("href")).toBe("https://invoice.stripe.com/i/x");
    await userEvent.setup().click(screen.getByRole("button", { name: "Já paguei" }));
    expect((await screen.findByRole("status")).textContent).toContain("Ainda não identificamos o pagamento");
  });

  it("no hub, o Já paguei que reativou a empresa leva de volta ao sistema", async () => {
    h.post.mockResolvedValue({ data: { estado: "ativa", assinaturas_vivas: 1, org_operante: true } });
    render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", noHub: true })} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Já paguei" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/app"));
  });

  it("⭐ em atraso SEM fatura pagável (pausada / incobrável sem link): Gerenciar pagamento vira o botão principal, com o que fazer", () => {
    render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", linkDePagamento: null, assinaturasVivas: 1 })} />);
    expect(screen.queryByRole("link", { name: "Pagar agora" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assinar" })).toBeNull();
    expect(screen.getByText(/Atualize o cartão em Gerenciar pagamento/)).toBeTruthy();
    const botoes = screen.getAllByRole("button").map((b) => b.textContent);
    expect(botoes[0]).toBe("Gerenciar pagamento");
  });

  it("⭐ link que não é https não vira href: sem 'Pagar agora' e o portal assume", () => {
    render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", linkDePagamento: "javascript:alert(1)", assinaturasVivas: 1 })} />);
    expect(screen.queryByRole("link", { name: "Pagar agora" })).toBeNull();
    expect(screen.getByRole("button", { name: "Gerenciar pagamento" })).toBeTruthy();
  });

  it("teste grátis que acabou sem assinatura (sem provedor): não há 'Já paguei' — o botão é Assinar", () => {
    render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", temProvedor: false, assinaturasVivas: 0 })} />);
    expect(screen.queryByRole("button", { name: "Já paguei" })).toBeNull();
    expect(screen.getByRole("button", { name: "Assinar" })).toBeTruthy();
  });

  it("⭐ no hub, Assinar pede a volta pelo hub, e a volta do checkout relê e leva ao sistema quando a empresa voltou", async () => {
    h.post.mockResolvedValue({ data: { url: "https://checkout.stripe.com/c/pay/cs_2" } });
    const { unmount } = render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", temProvedor: false, assinaturasVivas: 0, noHub: true })} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Assinar" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/checkout", { volta: "hub" }));
    unmount();
    h.post.mockResolvedValue({ data: { estado: "ativa", assinaturas_vivas: 1, org_operante: true } });
    render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", noHub: true, voltouDoCheckout: true })} />);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/app"));
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("⭐ trocar de plano mostra a data em que o novo vale", async () => {
    const u = userEvent.setup();
    h.post.mockResolvedValue({ data: { changed: true, quando: "agendado", plano_id: "plano-a", plano_agendado_id: "plano-b", vale_a_partir_de: "2026-11-01T12:00:00Z" } });
    render(<AcoesDaAssinatura {...acoes()} />);
    await u.click(screen.getByRole("button", { name: "Trocar de plano" }));
    await u.selectOptions(screen.getByLabelText("Novo plano"), "plano-b");
    await u.click(screen.getByRole("button", { name: "Confirmar troca" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/O novo plano vale a partir de \d{2}\/\d{2}/);
    expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/plano", { plano_id: "plano-b" });
  });

  it("cancelar pede confirmação e diz até quando o acesso vale", async () => {
    const u = userEvent.setup();
    h.post.mockResolvedValue({ data: { changed: true, acesso_ate: "2026-11-01T12:00:00Z" } });
    render(<AcoesDaAssinatura {...acoes()} />);
    await u.click(screen.getByRole("button", { name: "Cancelar assinatura" }));
    expect(h.post).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Confirmar cancelamento" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Você mantém o acesso até \d{2}\/\d{2}/);
  });

  it("voltou do checkout: relê uma vez e dá o recado, sem repetir a frase do painel", async () => {
    h.post.mockResolvedValue({ data: { estado: "trial", assinaturas_vivas: 1, org_operante: true } });
    render(<AcoesDaAssinatura {...acoes({ estado: "trial", voltouDoCheckout: true })} />);
    const recado = await screen.findByRole("status");
    expect(recado.textContent).toContain("primeira cobrança sai no fim do teste grátis");
    expect(recado.textContent).not.toContain("1ª cobrança agendada");
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledWith("/app/settings/billing");
  });

  it("⭐ no hub, desmontar para a espera da volta do checkout: nenhuma releitura nem redirecionamento depois", async () => {
    vi.useFakeTimers();
    try {
      h.post.mockResolvedValue({ data: { estado: "em_atraso", assinaturas_vivas: 1, org_operante: false } });
      const { unmount } = render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", voltouDoCheckout: true, noHub: true })} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.post).toHaveBeenCalledTimes(1);
      unmount();
      h.post.mockResolvedValue({ data: { estado: "ativa", assinaturas_vivas: 1, org_operante: true } });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.push).not.toHaveBeenCalled();
      expect(h.replace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("⭐ erro da API conhecido sai pelo dicionário (nunca a mensagem crua do servidor); desconhecido cai numa frase genérica", async () => {
    const user = userEvent.setup();
    h.post.mockRejectedValueOnce(new ApiError(429, "rate_limited", undefined, "req-1", "mensagem crua do servidor"));
    const { unmount } = render(<AcoesDaAssinatura {...acoes({ estado: "trial", temProvedor: false, assinaturasVivas: 0 })} />);
    await user.click(screen.getByRole("button", { name: "Assinar" }));
    expect((await screen.findByRole("status")).textContent).toBe("Muitas tentativas seguidas. Aguarde um minuto e tente de novo.");
    unmount();
    h.post.mockRejectedValueOnce(new ApiError(500, "codigo_que_ninguem_mapeou", undefined, "req-2", "stack interna vazando"));
    render(<AcoesDaAssinatura {...acoes({ estado: "trial", temProvedor: false, assinaturasVivas: 0 })} />);
    await user.click(screen.getByRole("button", { name: "Assinar" }));
    const recado = (await screen.findByRole("status")).textContent;
    expect(recado).toBe("Não foi possível concluir agora. Tente de novo.");
    expect(recado).not.toContain("stack interna");
  });
});

describe("Asaas no Plano e cobrança (PR 3b)", () => {
  const CNPJ = ["11", "222", "333", "0001", "81"].join("");
  const CPF = ["529", "982", "247", "25"].join("");
  const asaasSemCliente = (p: Partial<PropsDasAcoes> = {}) =>
    acoes({ estado: "trial", temProvedor: false, assinaturasVivas: 0, provedor: "asaas", documentoDoCadastro: CNPJ, ...p });

  it("⭐ Assinar pede CPF ou CNPJ, pré-preenchido do cadastro, e envia o documento sem máscara", async () => {
    h.post.mockResolvedValue({ data: { url: "https://pagamento.example.com/i/abc" } });
    const u = userEvent.setup();
    render(<AcoesDaAssinatura {...asaasSemCliente()} />);
    const campo = screen.getByLabelText("CPF ou CNPJ de quem paga") as HTMLInputElement;
    expect(campo.value).toBe(CNPJ);
    await u.clear(campo);
    await u.type(campo, "529.982.247-25");
    await u.click(screen.getByRole("button", { name: "Assinar" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/checkout", { documento: CPF }));
  });

  it("⭐ no Asaas a fatura abre numa NOVA aba e o sistema fica: link 'Abrir a fatura', o recado de voltar e o 'Já paguei'", async () => {
    h.post.mockResolvedValue({ data: { url: "https://pagamento.example.com/i/abc" } });
    render(<AcoesDaAssinatura {...asaasSemCliente()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Assinar" }));
    const fatura = await screen.findByRole("link", { name: "Abrir a fatura" });
    expect(fatura.getAttribute("href")).toBe("https://pagamento.example.com/i/abc");
    expect(fatura.getAttribute("target")).toBe("_blank");
    expect(fatura.getAttribute("rel")).toContain("noopener");
    expect(h.abrir).not.toHaveBeenCalled();
    expect(screen.getByText(/volte aqui e clique em Já paguei/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Já paguei" })).toBeTruthy();
  });

  it("⭐ dígito verificador errado: o botão não envia e a tela diz o que conferir", async () => {
    const u = userEvent.setup();
    render(<AcoesDaAssinatura {...asaasSemCliente({ documentoDoCadastro: null })} />);
    await u.type(screen.getByLabelText("CPF ou CNPJ de quem paga"), CPF.slice(0, 10) + "6");
    expect(screen.getByText("Confira o CPF ou CNPJ: os dígitos não batem.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Assinar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("no hub, o documento vai junto com a volta pelo hub", async () => {
    h.post.mockResolvedValue({ data: { url: "https://pagamento.example.com/i/abc" } });
    render(<AcoesDaAssinatura {...asaasSemCliente({ estado: "em_atraso", noHub: true })} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Assinar" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/checkout", { volta: "hub", documento: CNPJ }));
  });

  it("quem já é cliente no Asaas (reassinar) e quem paga pela Stripe não veem o campo", () => {
    const { unmount } = render(<AcoesDaAssinatura {...acoes({ estado: "cancelada", temProvedor: true, assinaturasVivas: 0, provedor: "asaas" })} />);
    expect(screen.queryByLabelText("CPF ou CNPJ de quem paga")).toBeNull();
    unmount();
    render(<AcoesDaAssinatura {...acoes({ estado: "trial", temProvedor: false, assinaturasVivas: 0 })} />);
    expect(screen.queryByLabelText("CPF ou CNPJ de quem paga")).toBeNull();
  });

  it("⭐ o Asaas não tem portal: em atraso, 'Pagar agora' e nada de 'Gerenciar pagamento' (o link da cobrança já é o pagamento)", () => {
    render(<AcoesDaAssinatura {...acoes({ estado: "em_atraso", provedor: "asaas", linkDePagamento: "https://pagamento.example.com/i/x" })} />);
    expect(screen.getByRole("link", { name: "Pagar agora" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gerenciar pagamento" })).toBeNull();
  });

  it("⭐ em dia no Asaas, o link da cobrança seguinte (gerada 40 dias antes) é 'Adiantar a próxima mensalidade', nunca 'Pagar agora'", () => {
    render(<AcoesDaAssinatura {...acoes({ estado: "ativa", provedor: "asaas", linkDePagamento: "https://pagamento.example.com/i/x" })} />);
    expect(screen.getByRole("link", { name: "Adiantar a próxima mensalidade" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Pagar agora" })).toBeNull();
  });

  it("⭐ teste grátis no Asaas com a assinatura criada: 'Já paguei' relê (quem pagou o Pix não espera o cron); na Stripe, não", () => {
    const { unmount } = render(<AcoesDaAssinatura {...acoes({ estado: "trial", provedor: "asaas", temProvedor: true, assinaturasVivas: 1 })} />);
    expect(screen.getByRole("button", { name: "Já paguei" })).toBeTruthy();
    unmount();
    render(<AcoesDaAssinatura {...acoes({ estado: "trial", provedor: "stripe", temProvedor: true, assinaturasVivas: 1 })} />);
    expect(screen.queryByRole("button", { name: "Já paguei" })).toBeNull();
  });

  it("⭐ trocar de plano com o período em uso ainda pendente: a frase diz o que fazer (pagar), não 'aguarde'", async () => {
    const u = userEvent.setup();
    h.post.mockRejectedValue(new ApiError(409, "pagamento_do_periodo_pendente", undefined, "r", "x"));
    render(<AcoesDaAssinatura {...acoes({ provedor: "asaas" })} />);
    await u.click(screen.getByRole("button", { name: "Trocar de plano" }));
    await u.selectOptions(screen.getByLabelText("Novo plano"), "plano-b");
    await u.click(screen.getByRole("button", { name: "Confirmar troca" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      'A mensalidade de agora ainda não foi paga. Pague em "Pagar agora" e troque de plano depois que o pagamento for confirmado (Pix: minutos; boleto: até 1 dia útil).',
    );
  });

  it("⭐ o Asaas recusou um documento de dígitos certos: a tela diz que foi o documento", async () => {
    h.post.mockRejectedValue(new ApiError(422, "documento_recusado", undefined, "r", "x"));
    render(<AcoesDaAssinatura {...asaasSemCliente()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Assinar" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "O provedor de pagamento não aceitou este CPF ou CNPJ. Confira o número ou informe outro documento.",
    );
  });
});
