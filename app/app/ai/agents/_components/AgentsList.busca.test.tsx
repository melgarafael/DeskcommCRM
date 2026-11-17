/**
 * A BUSCA DA LISTA DE AGENTES IGNORA ACENTO (#4165).
 *
 * O filtro era `a.name.toLowerCase().includes(query.trim().toLowerCase())`:
 * ignora caixa e não ignora acento, então quem digita `pos-venda` — o gesto de
 * quem digita rápido — fica com a lista vazia e conclui que o agente não existe.
 *
 * A régua é a de sempre (`termoSemAcento`, `lib/inbox/termo-de-busca.ts`) e vale
 * para OS DOIS lados: normalizar só o termo deixaria `"São João".includes("sao
 * joao")` falso, que é o erro clássico deste defeito.
 *
 * Prova de componente, com o termo da issue. Não houve digitação em navegador.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRow } from "@/hooks/ai/useAgent";

const estado = vi.hoisted(() => ({ agentes: [] as AgentRow[] }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
// O menu de ações é outro assunto (e chama server actions); a busca da lista não passa por ele.
vi.mock("./AgentRowMenu", () => ({ AgentRowMenu: () => null }));
vi.mock("@/hooks/ai/useAgents", () => ({
  useAgentsList: () => ({ data: estado.agentes, isLoading: false }),
}));

import { AgentsList } from "./AgentsList";

function agente(id: string, name: string): AgentRow {
  return {
    id,
    organization_id: "00000000-0000-4000-8000-000000000002",
    name,
    description: null,
    model: "anthropic/claude-sonnet-4-6",
    system_prompt: "",
    is_active: true,
    is_default: false,
    config: {},
    guardrails: null,
    active_kb_version_id: null,
    published_version_id: null,
    archived_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function montar(agentes: AgentRow[]) {
  estado.agentes = agentes;
  render(<AgentsList initialData={agentes} canWrite={false} />);
  return screen.getByRole("textbox", { name: "Buscar agentes" });
}

function digitar(campo: HTMLElement, termo: string) {
  fireEvent.change(campo, { target: { value: termo } });
}

afterEach(cleanup);

describe('Agentes: "pos-venda" acha o agente "Pós-venda"', () => {
  const LISTA = [
    agente("a1", "Atendimento Pós-venda"),
    // Hífen e espaço não são a mesma coisa: a régua normaliza ACENTO, não
    // pontuação. Este segundo agente existe para o caso em maiúsculas sem
    // hífen, que é como muita gente escreve o nome por aí.
    agente("a2", "Pós Venda"),
    agente("a3", "Suporte técnico"),
  ];

  it("sem acento e em maiúsculas, o agente acentuado continua na lista", () => {
    const campo = montar(LISTA);

    digitar(campo, "pos-venda");
    expect(screen.getByText("Atendimento Pós-venda")).toBeTruthy();
    expect(screen.queryByText("Suporte técnico")).toBeNull();

    digitar(campo, "PÓS VENDA");
    expect(screen.getByText("Pós Venda")).toBeTruthy();
    expect(screen.queryByText("Atendimento Pós-venda")).toBeNull();
  });

  it("termo que não existe continua devolvendo a lista vazia", () => {
    const campo = montar(LISTA);
    digitar(campo, "financeiro");
    expect(screen.queryByText("Atendimento Pós-venda")).toBeNull();
    expect(screen.getByText("Nenhum agente corresponde aos filtros atuais.")).toBeTruthy();
  });
});
