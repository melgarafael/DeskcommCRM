import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EDITAR UM ITEM DO CATÁLOGO SEM DESATIVAR E CRIAR OUTRO (#2641).
 *
 * Em Configurações › Financeiro cada item só tinha "Desativar": para corrigir
 * um nome digitado errado ou uma conta de destino errada era preciso
 * desativar e cadastrar de novo, e o catálogo acumulava duplicata inativa.
 * A rota PATCH `/api/v1/financeiro/catalogo/[tipo]` já existia — quem não a
 * chamava era a TELA.
 *
 * O que este arquivo mede, cada caso com a mesma régua da criação:
 *
 *   1. clicar em Editar num item existente preenche o formulário da SEÇÃO com
 *      o item e o Salvar chama o PATCH com o mesmo corpo da criação + o id;
 *   2. nada de DELETE nem POST — a edição não pode virar desativar-e-recriar;
 *   3. a validação da edição é a da criação: nome de 1 letra deixa o Salvar
 *      desabilitado;
 *   4. controle: sem papel manager (podeEditar=false) não há Editar — como
 *      não há Desativar. Ele passa também no código anterior, de propósito:
 *      é a régua de permissão, não a do defeito;
 *   5. as cinco listas (contas, formas de pagamento, plano de contas, regras
 *      de comissão e recorrencias) — todas caíam juntas, porque todas tinham
 *      só `aoRemover`/`onInativar`.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { CatalogoFinanceiro } from "@/app/app/settings/tenant/financeiro/_client";

const CONTA_CAIXA = "11111111-1111-4111-8111-111111111111";
const CONTA_BANCO = "22222222-2222-4222-8222-222222222222";
const FORMA_PIX = "33333333-3333-4333-8333-333333333333";
const PLANO_SERVICOS = "44444444-4444-4444-8444-444444444444";
const REGRA_ANA = "55555555-5555-4555-8555-555555555555";
const RECORRENCIA_ALUGUEL = "66666666-6666-4666-8666-666666666666";

/** O que o servidor devolveria para cada `/api/v1/financeiro/catalogo/<tipo>`. */
const DADOS: Record<string, unknown[]> = {
  contas: [
    {
      id: CONTA_CAIXA,
      name: "Caixa principal",
      kind: "cash",
      opening_balance_cents: 0,
      currency: "BRL",
    },
    {
      id: CONTA_BANCO,
      name: "Banco do dia",
      kind: "bank",
      opening_balance_cents: 0,
      currency: "BRL",
    },
  ],
  formas_de_pagamento: [{ id: FORMA_PIX, name: "Pix", account_id: CONTA_CAIXA }],
  planos_de_conta: [{ id: PLANO_SERVICOS, name: "Serviços", direction: "in" }],
  regras_de_comissao: [
    {
      id: REGRA_ANA,
      name: "Ana",
      attendant_user_id: "u-ana",
      event_type_id: null,
      percent: 30,
    },
  ],
  recorrencias: [
    {
      id: RECORRENCIA_ALUGUEL,
      name: "Aluguel",
      account_id: CONTA_CAIXA,
      direction: "out",
      amount_cents: 250000,
      currency: "BRL",
      day_of_month: 5,
    },
  ],
  // `/api/v1/team/assignable` e `/api/v1/agenda/tipos` terminam em outros nomes.
  assignable: [{ user_id: "u-ana", name: "Ana Souza", email: null }],
  tipos: [{ id: "s-1", name: "Manicure" }],
};

async function montar(podeEditar = true) {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  render(
    <QueryClientProvider client={cliente}>
      <CatalogoFinanceiro podeEditar={podeEditar} comissaoDisponivel />
    </QueryClientProvider>,
  );
}

/** A seção inteira: os mesmos rótulos (nome, entrada/saída) aparecem em duas listas. */
async function secao(titulo: string): Promise<HTMLElement> {
  const cabecalho = await screen.findByRole("heading", { name: titulo, level: 2 });
  const bloco = cabecalho.closest("section");
  if (!bloco) throw new Error(`a seção "${titulo}" não está dentro de <section>`);
  return bloco as HTMLElement;
}

async function linha(bloco: HTMLElement, texto: RegExp | string): Promise<HTMLElement> {
  const alvo = await within(bloco).findByText(texto, { exact: false });
  const item = alvo.closest("li");
  if (!item) throw new Error(`"${texto}" não está dentro de <li>`);
  return item as HTMLElement;
}

/** O botão "Editar" mora NA linha do item — por isso a busca é dentro da lista. */
async function editarItem(bloco: HTMLElement, texto: RegExp | string): Promise<void> {
  fireEvent.click(within(await linha(bloco, texto)).getByRole("button", { name: "Editar" }));
}

function valorDe(bloco: HTMLElement, rotulo: string): HTMLInputElement {
  return within(bloco).getByLabelText(rotulo) as HTMLInputElement;
}

function salvarDe(bloco: HTMLElement): HTMLButtonElement {
  return within(bloco).getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockImplementation(async (caminho: string) => {
    const tipo = caminho.split("/").pop() ?? "";
    return { data: DADOS[tipo] ?? [] } as never;
  });
  vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
  vi.mocked(apiClient.patch).mockResolvedValue({ data: {} } as never);
  vi.mocked(apiClient.delete).mockResolvedValue({ data: {} } as never);
});

describe("editar item do catálogo financeiro pela tela (#2641)", () => {
  it("edita uma conta existente pelo PATCH, sem desativar e sem recriar", async () => {
    await montar();
    const bloco = await secao("Contas");
    await editarItem(bloco, "Caixa principal");

    const nome = valorDe(bloco, "Nome da conta");
    expect(nome.value).toBe("Caixa principal");
    fireEvent.change(nome, { target: { value: "Caixa geral" } });
    fireEvent.click(salvarDe(bloco));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/financeiro/catalogo/contas", {
        name: "Caixa geral",
        kind: "cash",
        id: CONTA_CAIXA,
      }),
    );
    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("edita a conta de destino de uma forma de pagamento", async () => {
    await montar();
    const bloco = await secao("Formas de pagamento");
    await editarItem(bloco, "Pix →");

    expect(valorDe(bloco, "Nome da forma de pagamento").value).toBe("Pix");
    expect(valorDe(bloco, "Conta de destino").value).toBe(CONTA_CAIXA);
    fireEvent.change(valorDe(bloco, "Conta de destino"), { target: { value: CONTA_BANCO } });
    fireEvent.click(salvarDe(bloco));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        "/api/v1/financeiro/catalogo/formas_de_pagamento",
        {
          name: "Pix",
          account_id: CONTA_BANCO,
          id: FORMA_PIX,
        },
      ),
    );
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it("edita a direção de um plano de contas", async () => {
    await montar();
    const bloco = await secao("Plano de contas");
    await editarItem(bloco, "Serviços ·");

    expect(valorDe(bloco, "Nome do plano de contas").value).toBe("Serviços");
    expect(valorDe(bloco, "Entrada ou saída").value).toBe("in");
    fireEvent.change(valorDe(bloco, "Entrada ou saída"), { target: { value: "out" } });
    fireEvent.click(salvarDe(bloco));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/financeiro/catalogo/planos_de_conta", {
        name: "Serviços",
        direction: "out",
        id: PLANO_SERVICOS,
      }),
    );
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it("edita uma regra de comissão com os mesmos campos da criação", async () => {
    await montar();
    const bloco = await secao("Comissão");
    await editarItem(bloco, "Ana Souza · 30%");

    expect(valorDe(bloco, "Percentual").value).toBe("30");
    expect(valorDe(bloco, "Pessoa").value).toBe("u-ana");
    fireEvent.change(valorDe(bloco, "Percentual"), { target: { value: "35" } });
    fireEvent.click(salvarDe(bloco));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        "/api/v1/financeiro/catalogo/regras_de_comissao",
        {
          name: "Ana Souza",
          attendant_user_id: "u-ana",
          event_type_id: null,
          percent: 35,
          id: REGRA_ANA,
        },
      ),
    );
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it("edita um lançamento recorrente com os mesmos campos da criação", async () => {
    await montar();
    const bloco = await secao("Todo mês");
    await editarItem(bloco, "Aluguel ·");

    expect(valorDe(bloco, "Nome do lançamento").value).toBe("Aluguel");
    expect(valorDe(bloco, "Valor").value).toBe("2500,00");
    expect(valorDe(bloco, "Dia do mês").value).toBe("5");
    fireEvent.change(valorDe(bloco, "Valor"), { target: { value: "3000" } });
    fireEvent.change(valorDe(bloco, "Dia do mês"), { target: { value: "10" } });
    fireEvent.click(salvarDe(bloco));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/financeiro/catalogo/recorrencias", {
        name: "Aluguel",
        account_id: CONTA_CAIXA,
        direction: "out",
        amount_cents: 300000,
        day_of_month: 10,
        id: RECORRENCIA_ALUGUEL,
      }),
    );
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it("na edição, 'Decidir depois' TIRA a conta da forma de pagamento", async () => {
    // Omitir `account_id` (como a criação faz) deixaria a conta antiga no lugar:
    // o PATCH só grava o que vem no corpo.
    await montar();
    const bloco = await secao("Formas de pagamento");
    await editarItem(bloco, "Pix →");
    fireEvent.change(valorDe(bloco, "Conta de destino"), { target: { value: "" } });
    fireEvent.click(salvarDe(bloco));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        "/api/v1/financeiro/catalogo/formas_de_pagamento",
        { name: "Pix", account_id: null, id: FORMA_PIX },
      ),
    );
  });

  it("depois de salvar, Comissão e Recorrências saem do modo edição", async () => {
    await montar();
    const comissao = await secao("Comissão");
    await editarItem(comissao, "Ana Souza · 30%");
    fireEvent.click(salvarDe(comissao));
    expect(
      await within(comissao).findByRole("button", { name: "Adicionar regra" }),
    ).toBeInTheDocument();

    const recorrencias = await secao("Todo mês");
    await editarItem(recorrencias, "Aluguel ·");
    fireEvent.click(salvarDe(recorrencias));
    expect(
      await within(recorrencias).findByRole("button", { name: "Adicionar" }),
    ).toBeInTheDocument();
    expect(apiClient.patch).toHaveBeenCalledTimes(2);
  });

  it("a validação da edição é a da criação: nome de 1 letra não salva", async () => {
    await montar();
    const bloco = await secao("Contas");
    await editarItem(bloco, "Caixa principal");

    fireEvent.change(valorDe(bloco, "Nome da conta"), { target: { value: "X" } });
    const botao = salvarDe(bloco);
    expect(botao).toBeDisabled();
    fireEvent.click(botao);
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("sem papel manager não há Editar — nem Desativar (controle)", async () => {
    await montar(false);
    const bloco = await secao("Contas");
    await linha(bloco, "Caixa principal");
    expect(within(bloco).queryByRole("button", { name: "Editar" })).toBeNull();
    expect(within(bloco).queryByRole("button", { name: "Desativar" })).toBeNull();
    expect(within(bloco).queryByRole("button", { name: "Salvar" })).toBeNull();
  });
});
