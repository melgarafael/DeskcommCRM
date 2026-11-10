/**
 * ── Os QUATRO caminhos da tela do servidor MCP externo (#2948) ──────────────
 *
 *   1. CADASTRO — salvar manda o endereço e a chave para a action que já
 *      existia, e a chave aparece UMA vez (o bloco nasce do resultado do
 *      salvar, não do campo ao vivo);
 *   2. RECUSA   — o veredito do anti-SSRF (`endpoint_inseguro`) chega à tela
 *      como erro com todas as letras, e NADA é anunciado como salvo;
 *   3. TESTE    — "Testar conexão" chama `listarFerramentasMcpExternas` e conta
 *      o que o servidor oferece;
 *   4. REMOÇÃO  — remover usa a MESMA action, com endereço e chave vazios (é o
 *      contrato de apagar dela).
 *
 * As duas actions são mockadas de propósito: aqui se mede a TELA — o contrato
 * de cada caminho. O anti-SSRF, a cifragem e o gate de permissão têm teste
 * próprio no ponto de entrada, em
 * `tests/unit/cadastro-do-mcp-externo-e-o-platform-admin.test.ts`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/settings/definirServidorMcpExterno", () => ({
  definirServidorMcpExterno: vi.fn(),
}));
vi.mock("@/app/actions/settings/listarFerramentasMcpExternas", () => ({
  listarFerramentasMcpExternas: vi.fn(),
}));
// O dicionário de verdade fica de fora: o que se mede é o literal da tela, e a
// tradução tem guarda própria (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`).
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/lib/auth/ir-ao-desafio-de-mfa", () => ({ irAoDesafioDeMfa: vi.fn() }));

import { definirServidorMcpExterno } from "@/app/actions/settings/definirServidorMcpExterno";
import { listarFerramentasMcpExternas } from "@/app/actions/settings/listarFerramentasMcpExternas";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

import { CadastroDoServidorMcpExterno } from "./CadastroDoServidorMcpExterno";

const ENDERECO = "https://erp.loja/mcp";
const CHAVE = "segredo-do-erp-abcd";
/** O de sempre: o endereço de metadados da nuvem que o guard recusa. */
const ENDERECO_INSEGURO = "http://169.254.169.254/mcp";

const cadastro = () => vi.mocked(definirServidorMcpExterno);
const listagem = () => vi.mocked(listarFerramentasMcpExternas);

function abrir() {
  render(<CadastroDoServidorMcpExterno />);
}

function digitar(endpoint: string, chave = CHAVE) {
  fireEvent.change(screen.getByTestId("endpoint"), { target: { value: endpoint } });
  fireEvent.change(screen.getByTestId("chave"), { target: { value: chave } });
}

const valorDoCampoDaChave = () => (screen.getByTestId("chave") as HTMLInputElement).value;

beforeEach(() => {
  cadastro().mockReset();
  cadastro().mockResolvedValue({ ok: true, chaveUltimos4: "abcd" });
  listagem().mockReset();
  listagem().mockResolvedValue({ ok: true, host: "erp.loja", ferramentas: [] });
  vi.mocked(irAoDesafioDeMfa).mockReset();
});

describe("cadastro: a chave só aparece na criação", () => {
  it("salvar manda endereço e chave para a action, revela os quatro últimos e limpa o campo", async () => {
    abrir();
    // ANTES de salvar não existe bloco de chave nenhum: é esta metade que torna
    // a promessa "só na criação" verdadeira.
    expect(screen.queryByTestId("chave-criada")).toBeNull();

    digitar(ENDERECO);
    fireEvent.click(screen.getByTestId("salvar"));

    await waitFor(() => expect(cadastro()).toHaveBeenCalledWith({ endpoint: ENDERECO, chave: CHAVE }));
    await waitFor(() => expect(screen.getByTestId("chave-criada")).toBeInTheDocument());
    expect(screen.getByTestId("chave-criada").textContent).toContain("abcd");
    // A chave sai da tela junto com a revelação: deixá-la no campo faria o
    // segredo sobreviver sem ninguém ter pedido.
    expect(valorDoCampoDaChave()).toBe("");
    expect(screen.getByTestId("aviso").textContent).toContain("Configuração salva");
    expect(screen.queryByTestId("erro")).toBeNull();
  });
});

describe("recusa do anti-SSRF: a tela diz o motivo, e nada mais", () => {
  it("endpoint inseguro aparece como erro claro e não anuncia salvo nem revela chave", async () => {
    cadastro().mockResolvedValue({ ok: false, error: "endpoint_inseguro" });
    abrir();
    digitar(ENDERECO_INSEGURO);
    fireEvent.click(screen.getByTestId("salvar"));

    // O endereço vai como foi digitado: quem recusa é o guard da action, não
    // uma regra paralela escrita nesta tela.
    await waitFor(() =>
      expect(cadastro()).toHaveBeenCalledWith({ endpoint: ENDERECO_INSEGURO, chave: CHAVE }),
    );
    await waitFor(() => expect(screen.getByTestId("erro")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("recusado por segurança");
    expect(screen.queryByTestId("aviso")).toBeNull();
    expect(screen.queryByTestId("chave-criada")).toBeNull();
  });
});

describe("teste: a tela pergunta ao servidor salvo o que ele oferece", () => {
  it("testar conexão chama a listagem e conta as ferramentas anunciadas", async () => {
    listagem().mockResolvedValue({
      ok: true,
      host: "erp.loja:8443",
      ferramentas: [
        {
          nome: "consultar_contrato",
          descricao: "Contrato do cliente",
          ids: ["mcp_externo:leitura:consultar_contrato"],
          declaradaLeitura: true,
        },
        {
          nome: "abrir_fatura",
          descricao: null,
          ids: ["mcp_externo:escrita:abrir_fatura"],
          declaradaLeitura: false,
        },
      ],
    });
    abrir();
    fireEvent.click(screen.getByTestId("testar"));

    await waitFor(() => expect(listagem()).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("ferramentas")).toBeInTheDocument());
    expect(screen.getByText(/O servidor respondeu com 2 ferramentas/)).toBeInTheDocument();
    expect(screen.getByTestId("ferramentas").textContent).toContain("consultar_contrato");
    expect(screen.getByText("erp.loja:8443")).toBeInTheDocument();
    expect(screen.queryByTestId("erro")).toBeNull();
  });

  it("servidor que não responde é recusa com frase própria — não silêncio nem sucesso", async () => {
    listagem().mockResolvedValue({ ok: false, error: "sem_servidor" });
    abrir();
    fireEvent.click(screen.getByTestId("testar"));

    await waitFor(() => expect(screen.getByTestId("erro")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("Nenhum servidor externo respondeu");
    expect(screen.queryByTestId("ferramentas")).toBeNull();
  });
});

describe("salvar com um campo vazio não vira remoção", () => {
  // Na action, endereço OU chave vazios APAGAM o registro. Sem esta guarda,
  // trocar só o endereço (deixando a chave em branco) removia o servidor e a
  // tela dizia "Configuração salva".
  it.each([
    ["chave vazia", ENDERECO, ""],
    ["endereço vazio", "", CHAVE],
  ])("%s: não chama a action e diz o que falta", async (_caso, endpoint, chave) => {
    abrir();
    digitar(endpoint, chave);
    fireEvent.click(screen.getByTestId("salvar"));

    await waitFor(() => expect(screen.getByTestId("erro")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("use Remover");
    expect(cadastro()).not.toHaveBeenCalled();
    expect(screen.queryByTestId("aviso")).toBeNull();
  });
});

describe("remoção: a mesma action, com o contrato de apagar", () => {
  it("remover manda endereço e chave vazios, avisa o desfecho e não revela chave nenhuma", async () => {
    abrir();
    digitar(ENDERECO);
    fireEvent.click(screen.getByTestId("remover"));

    await waitFor(() => expect(cadastro()).toHaveBeenCalledWith({ endpoint: "", chave: "" }));
    await waitFor(() => expect(screen.getByTestId("aviso").textContent).toContain("removido"));
    // A revelação é da CRIAÇÃO: remover não tem chave nenhuma para mostrar.
    expect(screen.queryByTestId("chave-criada")).toBeNull();
    expect(valorDoCampoDaChave()).toBe("");
    expect(screen.queryByTestId("erro")).toBeNull();
  });
});

describe("recusa por falta do código: a tela leva ao desafio", () => {
  it("mfa_required ao salvar leva ao código (entrar de novo não o pediria a quem confiou no dispositivo)", async () => {
    cadastro().mockResolvedValue({ ok: false, error: "mfa_required" });
    abrir();
    digitar(ENDERECO);
    fireEvent.click(screen.getByTestId("salvar"));

    await waitFor(() => expect(irAoDesafioDeMfa).toHaveBeenCalledTimes(1));
  });

  it("CONTROLE: outra recusa mostra a frase e fica na tela", async () => {
    cadastro().mockResolvedValue({ ok: false, error: "endpoint_inseguro" });
    abrir();
    digitar(ENDERECO_INSEGURO);
    fireEvent.click(screen.getByTestId("salvar"));

    await waitFor(() => expect(screen.getByTestId("erro")).toBeInTheDocument());
    expect(irAoDesafioDeMfa).not.toHaveBeenCalled();
  });
});
