import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A tela de conectar um número por provedor parceiro.
 *
 * ─── O defeito que estes casos existem para impedir ─────────────────────────
 *
 * Conectar são DUAS pontas: a chave (nós falamos com o provedor) e o webhook (o
 * provedor fala conosco). Quem faz só a primeira **envia e nunca recebe** — e o
 * defeito aparece horas depois, como "o cliente respondeu e não chegou", sem
 * nada na tela dizendo por quê.
 *
 * Por isso o segundo passo é obrigatório na interface, e por isso metade dos
 * casos prova que ele APARECE com o que precisa ser copiado.
 */

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));
const toastOk = vi.fn();
const toastErro = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (m: string) => toastOk(m), error: (m: string) => toastErro(m) } }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

import { CanalParceiroClient } from "@/components/connections/CanalParceiroClient";

const desconectado = {
  data: {
    label: "Zernio",
    connected: false,
    account_id: null,
    phone_number: null,
    display_name: null,
    status: null,
    has_api_key: false,
    webhook_url: null,
  },
};

const conectado = {
  data: {
    ...desconectado.data,
    connected: true,
    account_id: "acc_1",
    phone_number: "+19392301037",
    display_name: "MP wp",
    status: "WORKING",
    has_api_key: true,
    webhook_url: "https://crm.exemplo/api/v1/webhooks/channel/tok123",
  },
};

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  toastOk.mockReset();
  toastErro.mockReset();
});

describe("estado inicial", () => {
  it("mostra a marca que veio do SERVIDOR, não uma string da tela", async () => {
    // O rótulo vem do servidor porque a tela não pode nomear provider — e para
    // que um segundo parceiro não exija mudar este componente.
    getMock.mockResolvedValue(desconectado);
    render(<CanalParceiroClient />);
    expect(await screen.findByText(/Conectar por Zernio/)).toBeInTheDocument();
  });

  it("diz que não está conectado quando não está", async () => {
    getMock.mockResolvedValue(desconectado);
    render(<CanalParceiroClient />);
    expect(await screen.findByText("Não conectado")).toBeInTheDocument();
  });

  it("mostra o número quando já está conectado", async () => {
    getMock.mockResolvedValue(conectado);
    render(<CanalParceiroClient />);
    expect(await screen.findByText("Conectado")).toBeInTheDocument();
    expect(screen.getByText(/\+19392301037/)).toBeInTheDocument();
  });

  it("com chave gravada, o campo diz que existe — nunca mostra qual é", async () => {
    getMock.mockResolvedValue(conectado);
    render(<CanalParceiroClient />);
    const campo = await screen.findByLabelText(/Chave de API/);
    // O campo existe no PRIMEIRO render, antes de a leitura do estado voltar —
    // e é só depois dela que o placeholder passa a dizer "gravada". Afirmar
    // isso na linha seguinte ao `findByLabelText` é uma corrida: ela é ganha
    // quase sempre, e perdida quando a máquina está carregada (medido: duas
    // rodadas da suíte inteira, mesma árvore, desfechos diferentes).
    await waitFor(() =>
      expect(campo).toHaveAttribute("placeholder", expect.stringMatching(/gravada/i)),
    );
    expect((campo as HTMLInputElement).value).toBe("");
    expect(campo).toHaveAttribute("type", "password");
  });

  it("falha ao ler o estado não trava a tela — o formulário continua servindo", async () => {
    getMock.mockRejectedValue(new Error("500"));
    render(<CanalParceiroClient />);
    expect(await screen.findByLabelText(/Chave de API/)).toBeInTheDocument();
  });
});

describe("conectar", () => {
  const preencher = async () => {
    fireEvent.change(await screen.findByLabelText("Conta"), { target: { value: "acc_1" } });
    fireEvent.change(screen.getByLabelText(/Chave de API/), { target: { value: "sk_live_x" } });
  };

  it("o botão fica desabilitado sem os dois campos", async () => {
    getMock.mockResolvedValue(desconectado);
    render(<CanalParceiroClient />);
    const botao = await screen.findByRole("button", { name: /conectar/i });
    expect(botao).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Conta"), { target: { value: "acc_1" } });
    expect(botao).toBeDisabled();
  });

  it("manda conta e chave para a rota", async () => {
    getMock.mockResolvedValue(desconectado);
    postMock.mockResolvedValue({
      data: { webhook_url: "https://x/w/1", webhook_secret: "s3cr3t", phone_number: null, quality_rating: null },
    });
    render(<CanalParceiroClient />);
    await preencher();
    fireEvent.click(screen.getByRole("button", { name: /conectar/i }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/channels/partner", {
        account_id: "acc_1",
        api_key: "sk_live_x",
      }),
    );
  });

  it("DEPOIS de conectar mostra a URL e o segredo, com o aviso de que sem isso não recebe", async () => {
    getMock.mockResolvedValue(desconectado);
    postMock.mockResolvedValue({
      data: {
        webhook_url: "https://crm.exemplo/api/v1/webhooks/channel/tok123",
        webhook_secret: "segredo-do-webhook",
        phone_number: "+19392301037",
        quality_rating: "GREEN",
      },
    });
    render(<CanalParceiroClient />);
    await preencher();
    fireEvent.click(screen.getByRole("button", { name: /conectar/i }));

    expect(await screen.findByText(/Falta ligar a volta/)).toBeInTheDocument();
    expect(screen.getByText("https://crm.exemplo/api/v1/webhooks/channel/tok123")).toBeInTheDocument();
    expect(screen.getByText("segredo-do-webhook")).toBeInTheDocument();
    // O aviso é o que impede o operador parar no passo 1 e achar que terminou.
    expect(screen.getByText(/envia mas não recebe/)).toBeInTheDocument();
  });

  it("a chave sai do campo depois de gravada — não deixa uma cópia a mais do segredo", async () => {
    getMock.mockResolvedValue(desconectado);
    postMock.mockResolvedValue({ data: { webhook_url: "https://x/w/1", webhook_secret: "s" } });
    render(<CanalParceiroClient />);
    await preencher();
    fireEvent.click(screen.getByRole("button", { name: /conectar/i }));

    await waitFor(() =>
      expect((screen.getByLabelText(/Chave de API/) as HTMLInputElement).value).toBe(""),
    );
  });

  it("credencial recusada mostra o motivo do provedor, não um erro genérico", async () => {
    getMock.mockResolvedValue(desconectado);
    postMock.mockRejectedValue(new Error("Chave recusada pelo provedor."));
    render(<CanalParceiroClient />);
    await preencher();
    fireEvent.click(screen.getByRole("button", { name: /conectar/i }));

    await waitFor(() => expect(toastErro).toHaveBeenCalledWith("Chave recusada pelo provedor."));
    // E NÃO mostra o passo 2: não há webhook a colar se a conexão falhou.
    expect(screen.queryByText(/Falta ligar a volta/)).not.toBeInTheDocument();
  });

  it("já conectado mostra a URL do webhook mas NÃO o segredo", async () => {
    getMock.mockResolvedValue(conectado);
    render(<CanalParceiroClient />);
    expect(await screen.findByText("https://crm.exemplo/api/v1/webhooks/channel/tok123")).toBeInTheDocument();
    expect(screen.queryByText(/Segredo \(assinatura\)/)).not.toBeInTheDocument();
  });
});
