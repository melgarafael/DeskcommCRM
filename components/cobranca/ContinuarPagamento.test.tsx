import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/types";

const h = vi.hoisted(() => ({ post: vi.fn(), abrir: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post } }));
vi.mock("@/lib/cobranca/navegar", () => ({ abrirNoNavegador: h.abrir }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace, refresh: h.refresh }) }));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({ useT: () => (s: string) => s }));
import { ContinuarPagamento } from "./ContinuarPagamento";

const props = {
  temIntencao: true, automatico: true, provedor: "stripe" as const,
  clienteExiste: false, documentoInicial: null, voltou: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  h.post.mockResolvedValue({ data: { url: "https://pagamento.example.test/fatura" } });
});
describe("continuidade até o pagamento", () => {
  it("StrictMode cancela a montagem de ensaio e faz um único POST", async () => {
    render(<StrictMode><ContinuarPagamento {...props} /></StrictMode>);
    await waitFor(() => expect(h.abrir).toHaveBeenCalledTimes(1));
    expect(h.post).toHaveBeenCalledTimes(1);
  });
  it("intenção confirmada prossegue sem terceiro Assinar e só por POST nativo", async () => {
    render(<ContinuarPagamento {...props} />);
    await waitFor(() => expect(h.abrir).toHaveBeenCalledWith("https://pagamento.example.test/fatura"));
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/checkout", { volta: "contratacao", continuar_cadastro: true }, { timeoutMs: 90_000 });
    expect(screen.queryByRole("button", { name: "Assinar" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("?retomar=1");
  });
  it("simples login/retomada sem intenção não inicia cobrança", () => {
    render(<ContinuarPagamento {...props} automatico={false} temIntencao={false} />);
    expect(h.post).not.toHaveBeenCalled();
    expect(screen.getByText(/Confira o plano e o período/)).toBeVisible();
  });
  it("Asaas pede somente documento faltante; preenchê-lo não envia antes do clique", async () => {
    render(<ContinuarPagamento {...props} provedor="asaas" />);
    const continuar = screen.getByRole("button", { name: "Continuar para pagamento" });
    expect(continuar).toBeDisabled();
    expect(h.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("CPF ou CNPJ de quem paga"), { target: { value: "11222333000181" } });
    expect(continuar).toBeEnabled();
    expect(h.post).not.toHaveBeenCalled();
    fireEvent.click(continuar);
    await waitFor(() => expect(h.abrir).toHaveBeenCalledTimes(1));
    expect(h.post.mock.calls[0]?.[1]).toEqual({ volta: "contratacao", continuar_cadastro: true, documento: "11222333000181" });
  });
  it("sem recibo anterior o clique atual confirma manualmente o pagamento, sem inventar intenção", async () => {
    render(<ContinuarPagamento {...props} provedor="asaas" automatico={false} temIntencao={false} />);
    fireEvent.change(screen.getByLabelText("CPF ou CNPJ de quem paga"), { target: { value: "11222333000181" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar para pagamento" }));
    await waitFor(() => expect(h.abrir).toHaveBeenCalledTimes(1));
    expect(h.post.mock.calls[0]?.[1]).toEqual({ volta: "contratacao", documento: "11222333000181" });
  });
  it("plano alterado ou recibo expirado relê o resumo, sem criar nem repetir cobrança", async () => {
    h.post.mockRejectedValueOnce(new ApiError(409, "state_conflict", undefined, "r", "Confira seu plano e continue para o pagamento."));
    render(<ContinuarPagamento {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Confira seu plano");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.abrir).not.toHaveBeenCalled();
  });
  it("duplo clique enquanto aguarda mantém uma única requisição", async () => {
    let concluir!: (v: { data: { url: string } }) => void;
    h.post.mockImplementationOnce(() => new Promise((resolve) => { concluir = resolve; }));
    render(<ContinuarPagamento {...props} automatico={false} />);
    const botao = screen.getByRole("button", { name: "Continuar para pagamento" });
    fireEvent.click(botao); fireEvent.click(botao);
    expect(h.post).toHaveBeenCalledTimes(1);
    concluir({ data: { url: "https://pagamento.example.test/fatura" } });
    await waitFor(() => expect(h.abrir).toHaveBeenCalledTimes(1));
  });
  it("resposta perdida/checkout já existente usa a fatura do gateway", async () => {
    h.post.mockRejectedValueOnce(new ApiError(409, "pagamento_em_andamento", { link_de_pagamento: "https://pagamento.example.test/existente" }, "r", "Em andamento"));
    render(<ContinuarPagamento {...props} />);
    await waitFor(() => expect(h.abrir).toHaveBeenCalledWith("https://pagamento.example.test/existente"));
    expect(h.post).toHaveBeenCalledTimes(1);
  });
  it("falha de gateway mantém saída recuperável sem redirecionar ou repetir automaticamente", async () => {
    h.post.mockRejectedValueOnce(new ApiError(503, "provedor_indisponivel", undefined, "r", "Tente novamente em instantes."));
    render(<ContinuarPagamento {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Tente novamente em instantes.");
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeEnabled();
    expect(h.abrir).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledTimes(1);
  });
  it("URL de sucesso e Já paguei sem confirmação não liberam acesso", async () => {
    h.post.mockResolvedValue({ data: { estado: "trial", org_operante: false } });
    render(<ContinuarPagamento {...props} automatico={false} voltou />);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/sincronizar", {}));
    expect(await screen.findByRole("status")).toHaveTextContent("Ainda não identificamos");
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.abrir).not.toHaveBeenCalled();
  });
  it("só confirmação real e org operante levam aos primeiros passos", async () => {
    h.post.mockResolvedValue({ data: { estado: "ativa", org_operante: true } });
    render(<ContinuarPagamento {...props} automatico={false} voltou />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/onboarding/welcome"));
  });
  it("pagamento ativo com bloqueio administrativo permanece bloqueado", async () => {
    h.post.mockResolvedValue({ data: { estado: "ativa", org_operante: false } });
    render(<ContinuarPagamento {...props} automatico={false} voltou />);
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.replace).not.toHaveBeenCalled();
  });
  it("cancelamento confirmado mostra o estado e apenas relê a tela, sem novo checkout", async () => {
    h.post.mockResolvedValue({ data: { estado: "cancelada", org_operante: false } });
    render(<ContinuarPagamento {...props} automatico={false} voltou />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Cancelada"));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.abrir).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("/api/v1/cobranca/assinatura/sincronizar", {});
  });
  it("retomada de assinatura cancelada já informa o estado antes de qualquer ação", () => {
    render(<ContinuarPagamento {...props} automatico={false} temIntencao={false} cancelada />);
    expect(screen.getByRole("status")).toHaveTextContent("Cancelada");
    expect(h.post).not.toHaveBeenCalled();
  });
  it("provedor ausente não tenta criar e mostra limite honesto", () => {
    render(<ContinuarPagamento {...props} provedor={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("ainda não está disponível");
    expect(h.post).not.toHaveBeenCalled();
  });
  it("link perigoso do retorno é recusado", async () => {
    h.post.mockResolvedValueOnce({ data: { url: "javascript:alert(1)" } });
    render(<ContinuarPagamento {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível preparar");
    expect(h.abrir).not.toHaveBeenCalled();
  });
});
