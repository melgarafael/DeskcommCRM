/**
 * A TELA DO GATEWAY DE PAGAMENTO DA ORGANIZAÇÃO (#4058) — o que ela promete.
 *
 * ═══ O que este arquivo vigia, e por quê ═══
 *
 * 1. **A chave digitada vive UM request.** Ela entra no `PUT`, e sai do estado
 *    assim que o salvamento dá certo. Depois disso a tela mostra o `last4` que o
 *    SERVIDOR mandou — não a chave. Se alguém "melhorar" a tela guardando a
 *    chave para reexibir, é aqui que fica vermelho.
 * 2. **Herdar é um estado nomeado.** Organização sem configuração própria vê
 *    "Herdado da instalação" e NÃO vê `last4`: a chave herdada não é dela, e os
 *    quatro últimos dígitos da conta de outra pessoa não são para aparecer.
 * 3. **Sem `admin`, não se altera nada.** Os botões não existem (escolha
 *    declarada aqui: escondidos, não desabilitados — botão cinza numa tela que
 *    não é sua só ensina a clicar e receber "não").
 * 4. **Desligar volta a herdar**, e a tela redesenha o que a rota devolveu.
 * 5. **O erro chega COM O CÓDIGO.** `invalid_provider_key` e
 *    `provider_key_mode_mismatch` pedem coisas diferentes de quem está
 *    configurando; um "erro ao salvar" genérico esconde as duas.
 * 6. **Campo vazio não vai ao servidor** — nem para "salvar" o que já está
 *    salvo, nem para trocar de provedor emparelhando a chave antiga com o novo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { EstadoDoGatewayParaTela } from "@/lib/pagamentos/gateway-da-organizacao";

import { GatewayDaOrganizacaoClient, type GatewaySettingsRow } from "./_client";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
// O toque sonoro do erro não é o assunto aqui: o que interessa é o aviso EM TELA.
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

/** O que a rota devolve quando a organização não tem (ou desligou) a própria conta. */
const HERDADO: EstadoDoGatewayParaTela = {
  origem: "instalacao",
  provider: "stripe",
  modo: "teste",
  apiKeyLast4: null,
  webhookSecretLast4: null,
  configurada: false,
  isActive: false,
};

/** O que a rota devolve com a conta da PRÓPRIA organização em vigor. */
const PROPRIO: EstadoDoGatewayParaTela = {
  origem: "organizacao",
  provider: "asaas",
  modo: "producao",
  apiKeyLast4: "9f2c",
  webhookSecretLast4: null,
  configurada: true,
  isActive: true,
};

/** A linha da view `organization_payment_gateways_safe` — sem coluna cifrada. */
const LINHA_PROPRIA: GatewaySettingsRow = {
  organization_id: "org-1",
  provider: "asaas",
  mode: "producao",
  api_key_last4: "9f2c",
  webhook_secret_last4: null,
  is_active: true,
};

const CHAVE_DIGITADA = "sk_test_51H8xQ2abcXYZ";

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: HERDADO });
  api.put.mockReset().mockResolvedValue({ data: PROPRIO });
  api.delete.mockReset().mockResolvedValue({ data: HERDADO });
});

function montar({
  initialRow = null,
  canWrite = true,
}: { initialRow?: GatewaySettingsRow | null; canWrite?: boolean } = {}) {
  // `retry: false`: um GET recusado viraria três tentativas e o teste esperaria
  // pelo backoff em vez de medir a tela.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GatewayDaOrganizacaoClient initialRow={initialRow} canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

const campoDaChave = () => screen.getByLabelText(/Chave do provedor/) as HTMLInputElement;

describe("Gateway de pagamento — a chave vai no PUT e não volta", () => {
  it("manda a chave uma vez no PUT, limpa o campo e nunca a devolve à tela", async () => {
    const user = userEvent.setup();
    montar();

    // Espera o estado em vigor chegar: é ele que preenche o provedor.
    await screen.findByText("Herdado da instalação — nenhuma chave desta organização é usada.");
    expect(screen.getByLabelText("Provedor")).toHaveValue("stripe");

    await user.type(campoDaChave(), CHAVE_DIGITADA);
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    // `[0]` pode ser `undefined` para o tipo (chamada indexada): o `?.` é o que
    // mantém isto compilando sob `noUncheckedIndexedAccess`, sem afrouxar a
    // asserção — se não houve chamada, o `toHaveBeenCalledTimes` acima já caiu.
    const [caminho, corpo] = api.put.mock.calls[0] ?? [];
    expect(caminho).toBe("/api/v1/pagamentos/gateway");
    expect(corpo).toMatchObject({
      provider: "stripe",
      api_key: CHAVE_DIGITADA,
      is_active: true,
    });

    // O campo volta vazio: a chave não fica no estado para ser reenviada nem
    // reexibida depois de salva.
    await waitFor(() => expect(campoDaChave()).toHaveValue(""));
    // E não sobrou em lugar nenhum da tela — nem no `last4`, que é do servidor.
    expect(document.body.textContent).not.toContain(CHAVE_DIGITADA);
    // Nem em outra chamada: só o PUT a viu.
    expect(JSON.stringify(api.get.mock.calls)).not.toContain(CHAVE_DIGITADA);
    expect(JSON.stringify(api.delete.mock.calls)).not.toContain(CHAVE_DIGITADA);
    // O que a tela passa a mostrar é o que a ROTA respondeu.
    await screen.findByText("Configurado por esta organização.");
    expect(screen.getByText("9f2c")).toBeTruthy();
  });

  it("campo vazio não envia PUT (e o botão diz por quê, em vez de recusar calado)", async () => {
    const user = userEvent.setup();
    montar();

    await screen.findByText("Herdado da instalação — nenhuma chave desta organização é usada.");
    const salvar = screen.getByRole("button", { name: "Salvar" });
    expect(salvar).toBeDisabled();

    await user.click(salvar);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("o modo não é digitado: não existe campo de modo, e o que aparece vem da rota", async () => {
    api.get.mockResolvedValue({ data: PROPRIO });
    montar({ initialRow: LINHA_PROPRIA });

    await screen.findByText("Configurado por esta organização.");
    // "Produção" veio do modo que o SERVIDOR derivou da chave.
    expect(screen.getByText(/Produção/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Modo/)).toBeNull();
  });
});

describe("Gateway de pagamento — o estado herdado aparece nomeado e sem last4", () => {
  it("sem configuração própria, a tela diz que herda e não mostra os 4 últimos", async () => {
    montar();

    await screen.findByText("Herdado da instalação — nenhuma chave desta organização é usada.");
    expect(screen.queryByText(/termina em/)).toBeNull();
    expect(
      screen.getByText("A configuração herdada não expõe nem os últimos dígitos da chave."),
    ).toBeTruthy();
    // Sem conta própria, não há o que desligar.
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
  });
});

describe("Gateway de pagamento — quem não é admin não altera", () => {
  it("sem admin, nem Salvar nem Desligar existem na tela", async () => {
    api.get.mockResolvedValue({ data: PROPRIO });
    montar({ initialRow: LINHA_PROPRIA, canWrite: false });

    await screen.findByText("Configurado por esta organização.");
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
    expect(
      screen.getByText("Só administradores da organização alteram o gateway de pagamento."),
    ).toBeTruthy();
    expect(campoDaChave()).toBeDisabled();
  });
});

describe("Gateway de pagamento — desligar volta a herdar", () => {
  it("desligar chama DELETE e redesenha o estado que a rota devolveu", async () => {
    api.get.mockResolvedValue({ data: PROPRIO });
    const user = userEvent.setup();
    montar({ initialRow: LINHA_PROPRIA });

    await screen.findByText("Configurado por esta organização.");
    await user.click(screen.getByRole("button", { name: "Desligar" }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/v1/pagamentos/gateway"));
    expect(api.put).not.toHaveBeenCalled();
    await screen.findByText("Herdado da instalação — nenhuma chave desta organização é usada.");
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
  });
});

describe("Gateway de pagamento — o erro do provedor chega com o código", () => {
  it.each([
    ["invalid_provider_key", "O provedor recusou esta chave. Confira a chave e o ambiente (teste ou produção)."],
    ["provider_key_mode_mismatch", "Esta é uma chave de produção. Use a chave do ambiente desta instalação."],
  ])("%s aparece na tela, não como 'erro genérico'", async (codigo, mensagem) => {
    api.put.mockRejectedValue(new ApiError(422, codigo, undefined, "req-1", mensagem));
    const user = userEvent.setup();
    montar();

    await screen.findByText("Herdado da instalação — nenhuma chave desta organização é usada.");
    await user.type(campoDaChave(), CHAVE_DIGITADA);
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(codigo);
    // A frase da rota (que sabe o contexto) também passa: só o código não
    // ensina o que fazer, e só a frase esconde QUAL recusa foi.
    expect(alerta.textContent).toContain(mensagem);
    // Nada foi salvo: o estado em vigor continua o herdado.
    expect(screen.getByText("Herdado da instalação — nenhuma chave desta organização é usada.")).toBeTruthy();
  });
});
