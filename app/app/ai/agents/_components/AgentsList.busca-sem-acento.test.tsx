import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AgentsList } from "./AgentsList";

/**
 * A BUSCA DA LISTA DE AGENTES IGNORA ACENTO (#4165).
 *
 * O agente se chama "Atendimento Pós-venda" no banco. A busca da tela comparava
 * `name.toLowerCase().includes(termo.toLowerCase())` — dobrava a CAIXA e nada
 * mais. Quem digitava `pos-venda` (como se escreve no dia a dia, sem acento)
 * recebia "Nenhum agente corresponde aos filtros atuais" com o agente ali, na
 * lista inteira sem filtro.
 *
 * A régua é a do repo, não uma nova: `termoSemAcento` (`lib/inbox/termo-de-busca`),
 * a mesma da busca do Inbox e do Encaminhar.
 */

const AGENTES = vi.hoisted(() => [
  {
    id: "a-1",
    organization_id: "org-1",
    name: "Atendimento Pós-venda",
    description: null,
    model: "anthropic/claude-sonnet-4-6",
    system_prompt: "",
    is_active: true,
    is_default: false,
    config: {},
    guardrails: null,
    active_kb_version_id: null,
    published_version_id: "v-1",
    paused_at: null,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "a-2",
    organization_id: "org-1",
    name: "Triagem",
    description: null,
    model: "anthropic/claude-sonnet-4-6",
    system_prompt: "",
    is_active: true,
    is_default: false,
    config: {},
    guardrails: null,
    active_kb_version_id: null,
    published_version_id: "v-2",
    paused_at: null,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
]);

vi.mock("@/hooks/ai/useAgents", () => ({
  useAgentsList: () => ({ data: AGENTES, isLoading: false }),
}));

// O cartão traz menu, badges e link: aqui interessa só QUAL agente passou pelo
// filtro, então o dublê imprime o nome que a lista recebeu.
vi.mock("./AgentCard", () => ({
  AgentCard: ({ agent }: { agent: { name: string } }) => (
    <span data-testid="cartao-do-agente">{agent.name}</span>
  ),
}));

function montar() {
  render(<AgentsList initialData={AGENTES as never} canWrite={false} />);
}

describe("busca da lista de agentes", () => {
  it("acha o agente acentuado digitando sem acento (#4165)", async () => {
    const user = userEvent.setup();
    montar();

    await user.type(screen.getByLabelText("Buscar agentes"), "pos-venda");

    expect(screen.getByText("Atendimento Pós-venda")).toBeTruthy();
    expect(screen.queryByText("Triagem")).toBeNull();
  });

  it("controle negativo: termo que não casa continua não achando", async () => {
    const user = userEvent.setup();
    montar();

    await user.type(screen.getByLabelText("Buscar agentes"), "zzz");

    expect(screen.queryByText("Atendimento Pós-venda")).toBeNull();
    expect(screen.queryByText("Triagem")).toBeNull();
    expect(screen.getByText("Nenhum agente corresponde aos filtros atuais.")).toBeTruthy();
  });
});
