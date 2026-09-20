import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import {
  creationChatInputSchema,
  creationDraftSchema,
  parseCreationReply,
} from "@/lib/ai/agents/creation-chat";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("@/app/app/ai/agents/new/_chat-action", () => ({ prepareAgentConversation: prepare }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/app/app/ai/agents/[id]/_components/AgentForm", () => ({
  initialAgentCreationState: () => ({
    name: "",
    description: "",
    system_prompt: "Padrão",
    model: "modelo-escolhido",
    max_steps: 17,
    tool_ids: ["crm_get_contact"],
  }),
  AgentForm: ({
    creationState: state,
    onCreationStateChange: change,
  }: {
    creationState: Record<string, unknown>;
    onCreationStateChange: (v: unknown) => void;
  }) => (
    <div>
      <label>
        Nome manual
        <input
          value={String(state.name)}
          onChange={(e) => change({ ...state, name: e.target.value })}
        />
      </label>
      <output data-testid="editor-values">{JSON.stringify(state)}</output>
    </div>
  ),
}));
import { ConversationalAgentCreator } from "@/app/app/ai/agents/new/_components/ConversationalAgentCreator";

const proposal = {
  name: "Recepção",
  description: "Atender interessados",
  system_prompt: "Peça o nome, entenda a necessidade e encaminhe descontos a uma pessoa.",
  suggested_tool_ids: ["crm_search_contacts"],
};
const open = () => render(<ConversationalAgentCreator credentials={[]} channelSessions={[]} />);
const send = () => {
  fireEvent.change(screen.getByLabelText("Conte sua ideia"), {
    target: { value: "Quero atender os interessados" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Começar$/ }));
};

beforeEach(() => {
  prepare.mockReset();
  prepare.mockResolvedValue({
    ok: true,
    message: "Preparei uma proposta para revisar.",
    draft: proposal,
  });
});

describe("proposta conversacional", () => {
  it("preenche uma ideia editável sem enviar ou ativar capacidades", () => {
    open();
    expect(screen.getByRole("button", { name: "Começar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Responder clientes" }));
    expect(screen.getByLabelText("Conte sua ideia")).toHaveValue(
      "Quero responder dúvidas sobre meus serviços e chamar minha equipe quando precisar.",
    );
    expect(screen.getByLabelText("Conte sua ideia")).toHaveFocus();
    expect(prepare).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Começar" })).toBeEnabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configurar manualmente" }));
    expect(JSON.parse(screen.getByTestId("editor-values").textContent!).tool_ids).toEqual([
      "crm_get_contact",
    ]);
  });
  it("recusa campos operacionais e capacidades inventadas ou exclusivas de humanos", () => {
    expect(creationDraftSchema.safeParse({ ...proposal, model: "outro" }).success).toBe(false);
    expect(creationDraftSchema.safeParse({ suggested_tool_ids: ["inventada"] }).success).toBe(
      false,
    );
    expect(
      creationDraftSchema.safeParse({
        suggested_tool_ids: [TOOL_CATALOG.find((tool) => tool.apenasHumano)!.name],
      }).success,
    ).toBe(false);
    expect(
      creationChatInputSchema.safeParse({
        draft: {},
        messages: [{ role: "assistant", content: "oi" }],
      }).success,
    ).toBe(false);
    expect(
      creationChatInputSchema.safeParse({
        draft: {},
        messages: [{ role: "user", content: "a".repeat(3001) }],
      }).success,
    ).toBe(false);
  });
  it("mantém campos anteriores em respostas parciais e não aceita publicação na resposta", () => {
    expect(
      parseCreationReply('{"message":"Ajustei o tom","draft":{"description":"Direto"}}', proposal)
        .draft.system_prompt,
    ).toBe(proposal.system_prompt);
    expect(() => parseCreationReply('{"message":"ok","draft":{"published":true}}', {})).toThrow();
  });
  it("começa pela conversa e permite abrir e voltar do editor sem perder ajustes", async () => {
    open();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Seu próximo agente começa com uma ideia.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Configurar manualmente" }));
    fireEvent.change(screen.getByLabelText("Nome manual"), { target: { value: "Meu agente" } });
    fireEvent.click(screen.getByRole("button", { name: "Voltar à conversa" }));
    fireEvent.click(screen.getByRole("button", { name: "Configurar manualmente" }));
    expect(screen.getByLabelText("Nome manual")).toHaveValue("Meu agente");
    fireEvent.click(screen.getByRole("button", { name: "Voltar à conversa" }));
    send();
    await waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(prepare.mock.calls[0]![0].draft.name).toBe("Meu agente");
  });
  it("sugere sem ativar capacidades e mantém modelo e limites ao aplicar texto", async () => {
    open();
    send();
    await screen.findByRole("button", { name: "Revisar rascunho" });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Revisar rascunho" }));
    const state = JSON.parse(screen.getByTestId("editor-values").textContent!);
    expect(state).toMatchObject({
      name: "Recepção",
      model: "modelo-escolhido",
      max_steps: 17,
      tool_ids: ["crm_get_contact"],
    });
  });
  it("leva ao editor somente a sugestão marcada explicitamente", async () => {
    open();
    send();
    await screen.findByRole("button", { name: "Revisar rascunho" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Revisar rascunho" }));
    expect(JSON.parse(screen.getByTestId("editor-values").textContent!).tool_ids).toEqual([
      "crm_get_contact",
      "crm_search_contacts",
    ]);
  });
  it("mantém mensagem na falha e permite nova tentativa sem duplicar turno", async () => {
    prepare.mockRejectedValueOnce(new Error("offline"));
    open();
    send();
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Conte sua ideia")).toHaveValue("Quero atender os interessados");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("button", { name: "Revisar rascunho" });
    expect(prepare.mock.calls[1]![0].messages).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("bloqueia envios concorrentes e só apresenta proposta após resposta", async () => {
    let finish!: (value: unknown) => void;
    prepare.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    open();
    send();
    expect(screen.getByRole("button", { name: "Preparando…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Revisar rascunho" })).toBeNull();
    finish({ ok: true, message: "Pronto para revisar", draft: proposal });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revisar rascunho" })).toBeEnabled(),
    );
  });
});
