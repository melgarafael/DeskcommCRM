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
  membros: [] as TeamMember[],
  resposta: { ok: true } as { ok: boolean; error?: string },
  erro: vi.fn(),
}));

vi.mock("@/hooks/team/useTeamMembers", () => ({
  useTeamMembers: () => ({ data: { data: h.membros }, isLoading: false }),
}));
vi.mock("@/app/actions/settings/definirMetaMensal", () => ({
  definirMetaMensal: vi.fn(async () => h.resposta),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: h.erro, success: vi.fn() } }));

const { FormularioDaMeta } = await import("@/app/app/settings/metas/_form");

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

function formulario(locale: "pt-BR" | "es") {
  return render(
    createElement(IdiomaProvider, {
      locale,
      children: <FormularioDaMeta mes="2026-11" metas={[]} moeda="BRL" />,
    }),
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  h.membros = [membro(ATIVA, "Ana Ativa", null), membro(REVOGADO, "Rui Revogado", "2026-11-01T12:00:00.000Z")];
  h.resposta = { ok: true };
  h.erro.mockReset();
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
});
