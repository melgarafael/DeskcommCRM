/**
 * /admin/cobranca da PR 3a (spec da cobrança §7a, §9): a Visão geral ensina o
 * próximo passo, a Conexão testa a chave e pede confirmação para publicar, e a
 * Régua mostra a linha do tempo que a empresa vai viver.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), refresh: vi.fn(), showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post, patch: h.patch } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: h.showApiError }));

import { ConexaoDaCobranca } from "@/app/admin/(protected)/cobranca/_conexao";
import { CopiarLinkDePagamento } from "@/app/admin/(protected)/cobranca/_copiar-link";
import { ReguaDaCobranca } from "@/app/admin/(protected)/cobranca/_regua";
import { FaixaDoModoDeTeste, VisaoGeral } from "@/app/admin/(protected)/cobranca/_visao-geral";
import { ApiError } from "@/lib/api/types";
import { montarChecklist, type DadosDaVisaoGeral } from "@/lib/cobranca/visao-geral";

const CHAVE = ["sk", "test", "51HtelaDeConexao0042"].join("_");
const CHAVE_ASAAS = "$" + ["aact", "hmlg", "000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6Oj0042"].join("_");
const VAZIA: DadosDaVisaoGeral = {
  provedor: null, modo: null, chaveLast4: null, urlDoWebhook: "https://crm.exemplo.com/api/v1/webhooks/cobranca/stripe",
  ultimoAvisoEm: null, ultimaLeituraEm: null, compraConcluida: false, emailPronto: false, planoDoCadastro: false,
  problemas: { credencialInvalida: 0, cobrancaDupla: 0, pagouCancelada: 0, avisosComErro: 0, avisosRecusados: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.post.mockResolvedValue({ data: { modo: "teste", webhook: "automatico", publicadas: 0 } });
  h.patch.mockResolvedValue({ data: { tolerancia_dias: 10 } });
});
afterEach(cleanup);

describe("Conexão", () => {
  it("⭐ envia o provedor e a chave digitada, e limpa o campo depois", async () => {
    const u = userEvent.setup();
    render(<ConexaoDaCobranca provedor={null} modo={null} last4={null} urlDoWebhook={VAZIA.urlDoWebhook} />);
    await u.type(screen.getByLabelText("Chave secreta"), CHAVE);
    await u.click(screen.getByRole("button", { name: "Testar e conectar" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/api/v1/admin/cobranca/conexao", { provedor: "stripe", chave: CHAVE }));
    expect((screen.getByLabelText("Chave secreta") as HTMLInputElement).value).toBe("");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("⭐ publicar pede confirmação dizendo quantas empresas voltam ao teste grátis, e reenvia confirmado", async () => {
    const u = userEvent.setup();
    h.post.mockRejectedValueOnce(new ApiError(409, "publicacao_requer_confirmacao", { assinaturas_de_teste: 2 }, "r", "x"));
    render(<ConexaoDaCobranca provedor="stripe" modo="teste" last4="0042" urlDoWebhook={VAZIA.urlDoWebhook} />);
    await u.type(screen.getByLabelText("Chave secreta"), CHAVE.replace("test", "live"));
    await u.click(screen.getByRole("button", { name: "Testar e conectar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("2 empresas assinaram");
    await u.click(screen.getByRole("button", { name: "Publicar mesmo assim" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith("/api/v1/admin/cobranca/conexao", expect.objectContaining({ confirmar_publicacao: true })));
  });

  it("mostra o selo do modo e só os 4 últimos da chave", () => {
    render(<ConexaoDaCobranca provedor="stripe" modo="teste" last4="0042" urlDoWebhook={VAZIA.urlDoWebhook} />);
    expect(screen.getByText("MODO DE TESTE")).toBeTruthy();
    expect(screen.getByText(/…0042/)).toBeTruthy();
  });

  it("⭐ sem endereço https público: avisa ANTES do clique o que fazer, e o botão fica desligado", async () => {
    const u = userEvent.setup();
    render(<ConexaoDaCobranca provedor={null} modo={null} last4={null} urlDoWebhook={null} />);
    expect(screen.getByRole("alert").textContent).toContain("https público");
    await u.type(screen.getByLabelText("Chave secreta"), CHAVE);
    expect((screen.getByRole("button", { name: "Testar e conectar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Régua", () => {
  it("salva a tolerância e mostra a linha do tempo com os dias", async () => {
    const u = userEvent.setup();
    render(<ReguaDaCobranca tolerancia={7} />);
    expect(screen.getByText(/Dia 5:/)).toBeTruthy();
    const campo = screen.getByLabelText("Dias de tolerância");
    await u.clear(campo);
    await u.type(campo, "10");
    expect(screen.getByText(/Dia 8:/)).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Salvar régua" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith("/api/v1/admin/cobranca/regua", { tolerancia_dias: 10 }));
  });
});

describe("Visão geral", () => {
  it("⭐ cada passo do checklist diz se está feito, e o próximo leva a quem faz", () => {
    const { container } = render(<VisaoGeral dados={VAZIA} checklist={montarChecklist(VAZIA)} idioma="pt-BR" agora={new Date("2026-10-10T12:00:00Z")} />);
    expect(container.querySelector('[data-passo="chave"]')?.getAttribute("data-feito")).toBe("false");
    expect(screen.getByRole("link", { name: "Fazer agora" }).getAttribute("href")).toBe("/admin/cobranca?aba=conexao");
    expect(screen.queryByText(/duas assinaturas ativas/)).toBeNull();
  });

  it("problemas do dono aparecem só quando existem", () => {
    const comProblema = { ...VAZIA, problemas: { ...VAZIA.problemas, cobrancaDupla: 2 } };
    render(<VisaoGeral dados={comProblema} checklist={montarChecklist(comProblema)} idioma="pt-BR" agora={new Date()} />);
    expect(screen.getByText(/2 clientes com duas assinaturas ativas/)).toBeTruthy();
  });

  it("⭐ avisos recusados por assinatura viram problema com o que fazer (segredo trocado não fica em silêncio)", () => {
    const recusados = { ...VAZIA, problemas: { ...VAZIA.problemas, avisosRecusados: 4 } };
    render(<VisaoGeral dados={recusados} checklist={montarChecklist(recusados)} idioma="pt-BR" agora={new Date()} />);
    expect(screen.getByText(/4 avisos de pagamento recusados/)).toBeTruthy();
  });

  it("um problema só fala no singular, sem '(s)'", () => {
    const um = { ...VAZIA, problemas: { ...VAZIA.problemas, cobrancaDupla: 1 } };
    render(<VisaoGeral dados={um} checklist={montarChecklist(um)} idioma="pt-BR" agora={new Date()} />);
    expect(screen.getByText(/^1 cliente com duas assinaturas ativas/)).toBeTruthy();
  });

  it("⭐ em modo de teste, a faixa diz que as empresas reais ainda não pagam; em produção, some", () => {
    const { rerender } = render(<FaixaDoModoDeTeste modo="teste" idioma="pt-BR" />);
    expect(screen.getByRole("alert").textContent).toContain("não conseguem pagar");
    rerender(<FaixaDoModoDeTeste modo="producao" idioma="pt-BR" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Clientes", () => {
  it("⭐ copiar o link de pagamento põe o link na área de transferência (o revendedor manda pelo WhatsApp)", async () => {
    const u = userEvent.setup();
    render(<CopiarLinkDePagamento link="https://invoice.stripe.com/i/x" />);
    await u.click(screen.getByRole("button", { name: "Copiar link de pagamento" }));
    expect(await navigator.clipboard.readText()).toBe("https://invoice.stripe.com/i/x");
  });
});

describe("Conexão com o Asaas (PR 3b)", () => {
  it("⭐ a escolha Stripe × Asaas tem uma frase cada, sem prometer débito automático no Pix; escolher o Asaas troca o rótulo, a dica, o exemplo da chave e a URL do aviso", async () => {
    render(<ConexaoDaCobranca provedor={null} modo={null} last4={null} urlDoWebhook={VAZIA.urlDoWebhook} />);
    expect(screen.getByText(/cobra o cartão sozinho todo mês e aceita boleto, mas não tem Pix\./)).toBeTruthy();
    expect(screen.getByText(/paga por Pix, boleto ou cartão/)).toBeTruthy();
    expect(screen.getByText(/Recomendado se seus clientes estão no Brasil\./)).toBeTruthy();
    expect(screen.queryByText(/recorrentes/)).toBeNull();
    await userEvent.setup().selectOptions(screen.getByLabelText("Provedor"), "asaas");
    expect((screen.getByLabelText("Chave de API do Asaas") as HTMLInputElement).placeholder).toBe("$aact_hmlg_…");
    expect(screen.getByText(/No Asaas: menu Integrações/)).toBeTruthy();
    expect(screen.getByText("https://crm.exemplo.com/api/v1/webhooks/cobranca/asaas")).toBeTruthy();
  });

  it("⭐ Asaas sem API de avisos: URL, token e eventos copiáveis UMA vez, e 'Pronto' fecha o passo", async () => {
    const TOKEN = ["token", "do", "aviso", "0123456789abcdef"].join("_");
    h.post.mockResolvedValue({
      data: { modo: "teste", webhook: { manual: { url: "https://crm.exemplo.com/api/v1/webhooks/cobranca/asaas", segredo: TOKEN, eventos: ["PAYMENT_CONFIRMED", "PAYMENT_OVERDUE"] } }, publicadas: 0 },
    });
    const u = userEvent.setup();
    render(<ConexaoDaCobranca provedor={null} modo={null} last4={null} urlDoWebhook={VAZIA.urlDoWebhook} />);
    await u.selectOptions(screen.getByLabelText("Provedor"), "asaas");
    await u.type(screen.getByLabelText("Chave de API do Asaas"), CHAVE_ASAAS);
    await u.click(screen.getByRole("button", { name: "Testar e conectar" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/api/v1/admin/cobranca/conexao", { provedor: "asaas", chave: CHAVE_ASAAS }));
    const nome = "Falta um passo: cadastre o aviso de pagamento no Asaas";
    const passo = await screen.findByRole("region", { name: nome });
    expect(passo.textContent).toContain(TOKEN);
    // Os eventos se marcam um a um no painel do Asaas: um por linha, não uma lista para colar.
    expect([...passo.querySelectorAll("li[data-evento]")].map((li) => li.textContent)).toEqual(["PAYMENT_CONFIRMED", "PAYMENT_OVERDUE"]);
    // Cada campo do formulário do Asaas com o valor certo, e o aviso que já existir é EDITADO, não duplicado.
    for (const campo of ["Versão da API: v3", "Fila de sincronização ativada: Sim", "Tipo de envio: Sequencial", "edite-o e troque só o token"]) {
      expect(passo.textContent).toContain(campo);
    }
    const { toast } = await import("sonner");
    expect(toast.warning).toHaveBeenCalledWith("Conectado. Falta um passo: cadastre o aviso no Asaas (veja abaixo).");
    expect(toast.success).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Copiar token" }));
    expect(await navigator.clipboard.readText()).toBe(TOKEN);
    await u.click(screen.getByRole("button", { name: "Pronto, já cadastrei" }));
    expect(screen.queryByRole("region", { name: nome })).toBeNull();
  });
});

describe("Visão geral com o Asaas (PR 3b)", () => {
  const ASAAS = { ...VAZIA, provedor: "asaas" as const };

  it("⭐ avisos recusados do Asaas dizem que o token do aviso não é o do sistema e como trocá-lo, sem a palavra 'assinatura'", () => {
    const d = { ...ASAAS, problemas: { ...VAZIA.problemas, avisosRecusados: 3 } };
    render(<VisaoGeral dados={d} checklist={montarChecklist(d)} idioma="pt-BR" agora={new Date()} />);
    expect(screen.getByText(/^3 avisos do Asaas recusados nas últimas 24 h/).textContent).toContain("troque nele o token pelo novo");
    expect(screen.queryByText(/a assinatura não confere/)).toBeNull();
  });

  it("avisos sem empresa, no Asaas, lembram que a conta pode ter outras vendas (o aviso assina todos os pagamentos dela)", () => {
    const d = { ...ASAAS, problemas: { ...VAZIA.problemas, avisosComErro: 1 } };
    render(<VisaoGeral dados={d} checklist={montarChecklist(d)} idioma="pt-BR" agora={new Date()} />);
    expect(screen.getByText(/^1 aviso do provedor sem empresa correspondente/).textContent).toContain("outras vendas");
  });

  it("controle: na Stripe, as frases de sempre", () => {
    const d = { ...VAZIA, provedor: "stripe" as const, problemas: { ...VAZIA.problemas, avisosRecusados: 1, avisosComErro: 1 } };
    render(<VisaoGeral dados={d} checklist={montarChecklist(d)} idioma="pt-BR" agora={new Date()} />);
    expect(screen.getByText(/a assinatura não confere/)).toBeTruthy();
    expect(screen.queryByText(/outras vendas/)).toBeNull();
  });
});
