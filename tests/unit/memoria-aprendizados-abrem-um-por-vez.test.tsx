/**
 * A lista de Aprendizados recolhe: cada aprendizado fecha por padrão e abrir um
 * fecha o outro (#4173).
 *
 * O problema não é de dados, é de ALTURA: cada aprendizado aberto mostra corpo,
 * campo de validade e botão de arquivar, e a tela de 10+ vira uma parede em que
 * nada se acha. A prova aqui é de comportamento, feito na tela de verdade
 * (`OrgMemoryClient`) com os hooks de dados e o toast dublados — o acordeão não
 * pode custar as ações que já existiam na linha (arquivar/reativar, validade).
 *
 * Fora do escopo desta fatia: a mesma recolha nas Etapas do funil (#4083) e
 * busca/filtro na lista.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  arquivar: vi.fn(),
  toast: vi.fn(),
  criar: vi.fn(),
  validade: vi.fn(),
}));

const APRENDIZADOS = [
  {
    id: "a1",
    title: "Não prometer frete grátis",
    body: "Frete grátis só com aprovação do humano.",
    source: "manual" as const,
    status: "active" as const,
    created_at: "2026-11-01T10:00:00Z",
    valid_until: null,
  },
  {
    id: "a2",
    title: "Cardápio muda às sextas",
    body: "Às sextas o cardápio é o executivo.",
    source: "flywheel" as const,
    status: "active" as const,
    created_at: "2026-11-02T10:00:00Z",
    valid_until: null,
  },
  {
    id: "a3",
    title: "Nunca citar concorrente",
    body: "Não citar concorrente pelo nome.",
    source: "agent" as const,
    status: "active" as const,
    created_at: "2026-11-03T10:00:00Z",
    valid_until: null,
  },
];

// Os hooks de dados viram dublês: o caso é de TELA (abrir/fechar e as ações da
// linha), não de rede. O `onSuccess` é chamado à mão para o toast sair como sai
// na tela quando o servidor responde bem.
vi.mock("@/hooks/ai/useOrgMemory", () => ({
  useOrgMemory: () => ({ data: { document: null, versions: [], entries: APRENDIZADOS } }),
  usePublishOrgMemory: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateOrgMemoryEntry: () => ({ mutate: h.criar, isPending: false }),
  useSetOrgMemoryEntryStatus: () => ({
    isPending: false,
    mutate: (input: unknown, opts?: { onSuccess?: () => void }) => {
      h.arquivar(input);
      opts?.onSuccess?.();
    },
  }),
  useSetOrgMemoryEntryValidity: () => ({ mutate: h.validade, isPending: false }),
  useOrgMemoryVersion: () => ({ isLoading: false, data: null }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
vi.mock("@/app/actions/settings/definirLimiteDoPesoDaMemoria", () => ({
  definirLimiteDoPesoDaMemoria: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: h.toast, error: vi.fn(), info: vi.fn() } }));

import { OrgMemoryClient } from "@/app/app/ai/memory/_client";

function montar() {
  render(
    <OrgMemoryClient
      initialState={{ document: null, versions: [], entries: APRENDIZADOS }}
      hoje="2026-11-06"
      limiteDoAviso={4000}
      podeEditarOLimite={false}
    />,
  );
}

/** O cabeçalho de um aprendizado é o botão que abre e fecha a linha. */
function cabecalho(titulo: RegExp) {
  return screen.getByRole("button", { name: titulo });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("Aprendizados recolhidos", () => {
  it("com 3 aprendizados, os três começam fechados e nenhum corpo aparece", () => {
    montar();
    const cabecalhos = [
      cabecalho(/Não prometer frete grátis/),
      cabecalho(/Cardápio muda às sextas/),
      cabecalho(/Nunca citar concorrente/),
    ];
    for (const c of cabecalhos) expect(c.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Frete grátis só com aprovação do humano.")).toBeNull();
    expect(screen.queryByText("Às sextas o cardápio é o executivo.")).toBeNull();
    expect(screen.queryByText("Não citar concorrente pelo nome.")).toBeNull();
  });

  it("abrir o segundo fecha o primeiro — um aberto por vez", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(cabecalho(/Não prometer frete grátis/));
    expect(cabecalho(/Não prometer frete grátis/).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Frete grátis só com aprovação do humano.")).toBeTruthy();

    await user.click(cabecalho(/Cardápio muda às sextas/));
    expect(cabecalho(/Cardápio muda às sextas/).getAttribute("aria-expanded")).toBe("true");
    expect(cabecalho(/Não prometer frete grátis/).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Frete grátis só com aprovação do humano.")).toBeNull();
    expect(screen.getByText("Às sextas o cardápio é o executivo.")).toBeTruthy();
  });

  it("clicar de novo no mesmo fecha (toggle), e o painel sai do DOM", async () => {
    const user = userEvent.setup();
    montar();
    const segundo = cabecalho(/Cardápio muda às sextas/);
    await user.click(segundo);
    const painel = screen.getByText("Às sextas o cardápio é o executivo.").closest("[role='region']");
    expect(painel).not.toBeNull();
    // `aria-controls` aponta para o painel que está na tela — o par do acessível.
    expect(segundo.getAttribute("aria-controls")).toBe(painel?.getAttribute("id"));

    await user.click(cabecalho(/Cardápio muda às sextas/));
    expect(cabecalho(/Cardápio muda às sextas/).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Às sextas o cardápio é o executivo.")).toBeNull();
  });

  it("com a linha aberta, arquivar continua chamando a rota e avisando", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(cabecalho(/Cardápio muda às sextas/));
    await user.click(screen.getByRole("button", { name: /Arquivar/ }));
    expect(h.arquivar).toHaveBeenCalledWith({ id: "a2", status: "archived" });
    expect(h.toast).toHaveBeenCalledWith("Aprendizado arquivado.");
  });

  // Decisão fixada aqui: o aprendizado recém-criado NÃO abre sozinho. Abrir o
  // formulário mexe no mesmo cartão, e a linha continua fechada — quem confirma
  // a criação é o toast, não um painel que se abre sob o cursor.
  it("abrir o formulário de novo aprendizado não abre nenhuma linha", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("button", { name: /Novo aprendizado/ }));
    expect(screen.getByLabelText("Título")).toBeTruthy();
    for (const titulo of [
      /Não prometer frete grátis/,
      /Cardápio muda às sextas/,
      /Nunca citar concorrente/,
    ]) {
      expect(cabecalho(titulo).getAttribute("aria-expanded")).toBe("false");
    }
  });
});
