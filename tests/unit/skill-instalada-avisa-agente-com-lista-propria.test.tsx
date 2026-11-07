/**
 * O AVISO DE INSTALAR SKILL NÃO MENTE SOBRE QUEM A RECEBE (frente F3, 9107).
 *
 * "Instalada — já vale para os agentes desta organização" era verdade enquanto
 * toda skill entrava em todo agente. Com skills por agente, ela fica falsa para
 * o agente que escolheu as próprias: a skill nova NÃO chega a ele, e o dono só
 * descobriria no atendimento. O aviso passa a nomear esses agentes. Sem nenhum
 * agente com lista própria, o texto é o de antes (controle).
 */
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { SkillsState } from "@/hooks/ai/useSkills";

const cena = vi.hoisted(() => ({
  estado: null as unknown as SkillsState,
  toast: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: cena.toast, error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
// Mesmo harness de `spec-versao-nova-catalogo.test.tsx`; a instalação aqui
// "dá certo" na hora, para o teste ler o aviso que ela dispara.
vi.mock("@/hooks/ai/useSkills", () => {
  const mutacao = () => ({
    isPending: false,
    mutate: (_arg: unknown, opts?: { onSuccess?: (r: unknown) => void }) =>
      opts?.onSuccess?.({ data: { name: "x" } }),
  });
  return {
    useSkills: () => ({ data: cena.estado }),
    useInstallSkill: mutacao,
    useUninstallSkill: mutacao,
    useImportSkill: mutacao,
    useSkill: () => ({ data: undefined, isLoading: false }),
    useSalvarSkill: () => ({ mutate: vi.fn(), isPending: false }),
    useSkillVersions: () => ({ data: [], isLoading: false }),
    useRestaurarSkill: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { SkillsClient, agentesSemASkill } from "@/app/app/ai/skills/_client";

const TEXTO_ANTIGO = "instalada — já vale para os agentes desta organização.";

function estado(agentes: SkillsState["agentes_com_lista_propria"]): SkillsState {
  return {
    installed: [],
    catalog: [
      { name: "agendamento", description: "Marca horário." },
      { name: "visita", description: "Agenda visita ao imóvel." },
    ],
    agentes_com_lista_propria: agentes,
  };
}

function instalar(nome: string) {
  render(<SkillsClient initialState={cena.estado} />);
  const item = screen.getByText(nome).closest("li");
  if (!item) throw new Error(`skill ${nome} não está no catálogo da tela`);
  const botao = [...item.querySelectorAll("button")].find((b) => /instalar/i.test(b.textContent ?? ""));
  if (!botao) throw new Error("botão Instalar não achado");
  fireEvent.click(botao);
  return String(cena.toast.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  cena.toast.mockClear();
});

describe("aviso ao instalar skill", () => {
  it("nenhum agente com lista própria → o texto de antes (controle)", () => {
    cena.estado = estado([]);
    expect(instalar("agendamento")).toBe(`Skill "agendamento" ${TEXTO_ANTIGO}`);
  });

  it("agente com lista própria que não tem a skill é nomeado, e a frase 'vale para todos' some", () => {
    cena.estado = estado([{ id: "a-lia", name: "Lia", skill_names: ["visita"] }]);
    const aviso = instalar("agendamento");
    expect(aviso).toContain("Lia");
    expect(aviso).not.toContain(TEXTO_ANTIGO);
  });

  it("agente cuja lista já tem a skill não é citado", () => {
    cena.estado = estado([{ id: "a-lia", name: "Lia", skill_names: ["visita"] }]);
    const aviso = instalar("visita");
    expect(aviso).not.toContain("Lia");
    expect(aviso).toBe(`Skill "visita" ${TEXTO_ANTIGO}`);
  });
});

describe("agentesSemASkill", () => {
  it("devolve só quem tem lista própria SEM a skill", () => {
    expect(
      agentesSemASkill("agendamento", [
        { id: "1", name: "Lia", skill_names: ["visita"] },
        { id: "2", name: "Nina", skill_names: ["agendamento"] },
        { id: "3", name: "Bia", skill_names: [] },
      ]),
    ).toEqual(["Lia", "Bia"]);
  });
});
