/**
 * CONFIGURAÇÕES › METAS: QUEM TEVE O ACESSO REVOGADO NÃO É OFERECIDO (#4986).
 *
 * Achado na prova pela tela do #4820: o seletor "De quem é a meta" listava uma
 * pessoa com o vínculo revogado, sem marca nenhuma. Salvar para ela é recusado
 * pelo servidor — e está certo, a meta do vendedor é de quem AINDA está na
 * empresa —, mas a tela dizia "o mês e o alvo precisam estar preenchidos", com
 * os dois preenchidos.
 *
 *   1. o seletor oferece só quem tem `revoked_at` nulo — a mesma régua da action;
 *   2. a recusa de vendedor fora da equipe tem frase própria, nos dois idiomas.
 */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { TeamMember } from "@/hooks/team/useTeamMembers";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const h = vi.hoisted(() => ({
  // O resultado do hook é o MESMO objeto entre renders, como no react-query:
  // só uma lista recarregada traz objeto novo.
  equipe: { data: { data: [] as TeamMember[] } },
  resposta: { ok: true } as { ok: boolean; error?: string },
  erro: vi.fn(),
  refetch: vi.fn(async () => undefined),
  definir: vi.fn(),
}));

vi.mock("@/hooks/team/useTeamMembers", () => ({
  useTeamMembers: () => ({ data: h.equipe.data, isLoading: false, refetch: h.refetch }),
}));
vi.mock("@/app/actions/settings/definirMetaMensal", () => ({
  definirMetaMensal: vi.fn(async (entrada: unknown) => {
    h.definir(entrada);
    return h.resposta;
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: h.erro, success: vi.fn() } }));

const { FormularioDaMeta } = await import("@/app/app/settings/metas/_form");

const METAS: readonly [] = [];
const ATIVA = "11111111-1111-4111-8111-111111111111";
const REVOGADO = "22222222-2222-4222-8222-222222222222";

function membro(user_id: string, full_name: string, revoked_at: string | null): TeamMember {
  return {
    user_id,
    full_name,
    role: "agent",
    email: null,
    invited_at: null,
    accepted_at: "2026-10-01T12:00:00.000Z",
    revoked_at,
    created_at: "2026-10-01T12:00:00.000Z",
    last_sign_in_at: null,
  };
}

function arvore(locale: "pt-BR" | "es") {
  return createElement(IdiomaProvider, {
    locale,
    children: <FormularioDaMeta mes="2026-11" metas={METAS} moeda="BRL" />,
  });
}

function formulario(locale: "pt-BR" | "es") {
  return render(arvore(locale));
}

async function escolher(nome: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "De quem é a meta" }));
  fireEvent.click(await screen.findByRole("option", { name: nome }));
}

function preencherAlvo(valor: string) {
  const alvo = document.getElementById("alvo") as HTMLInputElement;
  fireEvent.change(alvo, { target: { value: valor } });
  return alvo;
}

function recarregar(membros: TeamMember[]) {
  h.equipe = { data: { data: membros } };
}

const FRASE = "Essa pessoa não faz mais parte da equipe. Escolha outra pessoa ou a empresa.";

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  recarregar([membro(ATIVA, "Ana Ativa", null), membro(REVOGADO, "Rui Revogado", "2026-11-01T12:00:00.000Z")]);
  h.resposta = { ok: true };
  h.erro.mockReset();
  h.refetch.mockClear();
  h.definir.mockClear();
});

afterEach(cleanup);

describe("Metas › De quem é a meta", () => {
  it("o seletor oferece a empresa e quem está na equipe, não quem teve o acesso revogado", async () => {
    formulario("pt-BR");
    fireEvent.click(screen.getByRole("combobox", { name: "De quem é a meta" }));
    expect(await screen.findByRole("option", { name: "Empresa (todos)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ana Ativa" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Rui Revogado" })).toBeNull();
  });

  it.each([
    ["pt-BR", "Essa pessoa não faz mais parte da equipe. Escolha outra pessoa ou a empresa."],
    ["es", "Esta persona ya no forma parte del equipo. Elige a otra persona o la empresa."],
  ] as const)("em %s, a recusa de vendedor fora da equipe diz isso, não 'confira os campos'", async (locale, frase) => {
    h.resposta = { ok: false, error: "vendedor_fora_da_equipe" };
    formulario(locale);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    fireEvent.change(alvo, { target: { value: "10" } });
    fireEvent.submit(alvo.closest("form")!);
    await waitFor(() => expect(h.erro).toHaveBeenCalledWith(frase));
  });

  it("a pessoa escolhida é revogada com a tela aberta: some do seletor e salvar trava até escolher de novo", async () => {
    const tela = formulario("pt-BR");
    await escolher("Ana Ativa");
    preencherAlvo("10");
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeEnabled();

    recarregar([membro(ATIVA, "Ana Ativa", "2026-11-19T12:00:00.000Z")]);
    tela.rerender(arvore("pt-BR"));
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(FRASE);

    // Trocar o dono recarrega o alvo gravado daquela combinação (vazio aqui).
    await escolher("Empresa (todos)");
    preencherAlvo("10");
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("o servidor recusa a pessoa escolhida: ela some do seletor, a lista recarrega e salvar trava", async () => {
    h.resposta = { ok: false, error: "vendedor_fora_da_equipe" };
    const tela = formulario("pt-BR");
    await escolher("Ana Ativa");
    const alvo = preencherAlvo("10");
    fireEvent.submit(alvo.closest("form")!);
    await waitFor(() => expect(h.erro).toHaveBeenCalledWith(FRASE));
    expect(h.definir).toHaveBeenCalledWith(expect.objectContaining({ vendedor_id: ATIVA }));
    expect(h.refetch).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Salvar meta" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(FRASE);

    fireEvent.click(screen.getByRole("combobox", { name: "De quem é a meta" }));
    expect(await screen.findByRole("option", { name: "Empresa (todos)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Ana Ativa" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // A lista recarregada é quem manda: o acesso de volta devolve a pessoa e o salvar.
    recarregar([membro(ATIVA, "Ana Ativa", null)]);
    tela.rerender(arvore("pt-BR"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeEnabled();
  });
});
