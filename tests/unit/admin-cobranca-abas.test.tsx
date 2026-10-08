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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post, patch: h.patch } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: h.showApiError }));

import { ConexaoDaCobranca } from "@/app/admin/(protected)/cobranca/_conexao";
import { CopiarLinkDePagamento } from "@/app/admin/(protected)/cobranca/_copiar-link";
import { ReguaDaCobranca } from "@/app/admin/(protected)/cobranca/_regua";
import { FaixaDoModoDeTeste, VisaoGeral } from "@/app/admin/(protected)/cobranca/_visao-geral";
import { ApiError } from "@/lib/api/types";
import { montarChecklist, type DadosDaVisaoGeral } from "@/lib/cobranca/visao-geral";

const CHAVE = ["sk", "test", "51HtelaDeConexao0042"].join("_");
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
