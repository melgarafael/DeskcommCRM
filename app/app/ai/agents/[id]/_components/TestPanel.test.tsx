import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ApiError } from "@/lib/api/types";
import { TIMEOUT_MS_DO_ENSAIO, urlEnsaioDoAgente } from "@/lib/ai/agents/rota-de-ensaio";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

const post = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: { post, get: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { TestPanel } from "@/app/app/ai/agents/[id]/_components/TestPanel";

const AGENT_ID = "08b5e8a0-5977-4366-ad85-9845b192d3bf";
const VERSION_ID = "2c1838f5-c851-4a19-8e16-09c862ed21dd";

const agent: AgentRow = {
  id: AGENT_ID,
  organization_id: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "Assistente Sigilium",
  description: null,
  model: "claude-haiku-4-5",
  system_prompt: "oi",
  is_active: true,
  is_default: true,
  config: {},
  guardrails: {},
  active_kb_version_id: null,
  published_version_id: null,
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: "2026-09-13T00:00:00.000Z",
};

const draft: AgentVersionRow = {
  id: VERSION_ID,
  organization_id: agent.organization_id,
  agent_id: AGENT_ID,
  version_number: 1,
  system_prompt: "oi",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  credential_id: "3bf5adaf-0b01-4f27-abdd-a577ef12da05",
  tool_ids: [],
  trigger_config: null,
  channel_session_id: null,
  max_steps: 8,
  token_budget: 4000,
  cost_budget_cents: 100,
  history_message_window: 20,
  history_token_window: 4000,
  handoff_keywords: [],
  handoff_tool_enabled: true,
  cases_enabled: false,
  operator_enabled: false,
  operator_model: null,
  operator_tool_ids: [],
  pipeline_ids: [],
  knowledge_source_ids: [],
  split_messages: false,
  split_max_chars: 400,
  followup: { enabled: false, flow_pointer_ids: [] },
  status: "draft",
  published_at: null,
  superseded_at: null,
  created_at: "2026-09-14T00:00:00.000Z",
  created_by: null,
};

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TestPanel agent={agent} draft={draft} published={null} />
    </QueryClientProvider>,
  );
}

describe("TestPanel — um clique, um POST em /dry-run", () => {
  beforeEach(() => {
    post.mockReset();
    toastError.mockReset();
  });

  it("um clique gera um POST no segmento dry-run", async () => {
    post.mockResolvedValueOnce({ data: { run_id: "run-1", status: "ok", stub: true } });
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi, quanto custa?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toBe(urlEnsaioDoAgente(AGENT_ID, VERSION_ID));
    expect(post.mock.calls[0]?.[0]).toContain("/dry-run");
    expect(post.mock.calls[0]?.[0]).not.toContain("/test");
    expect(post.mock.calls[0]?.[2]).toEqual({ timeoutMs: TIMEOUT_MS_DO_ENSAIO });
    expect(TIMEOUT_MS_DO_ENSAIO).toBe(120_000);
  });

  it("clique duplo durante pending não gera outro POST", async () => {
    let liberar: (value: { data: { run_id: string; status: string } }) => void = () => undefined;
    post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          liberar = resolve;
        }),
    );
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi" },
    });
    const botao = screen.getByRole("button", { name: "Executar teste" });
    fireEvent.click(botao);
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(post).toHaveBeenCalledTimes(1);
    expect(botao).toBeDisabled();
    liberar({ data: { run_id: "run-1", status: "ok" } });
    await waitFor(() => expect(botao).toBeEnabled());
  });

  it("404 HTML não aparece no toast", async () => {
    post.mockRejectedValueOnce(
      new ApiError(
        404,
        "not_found",
        { content_kind: "html", body_length: 120 },
        "req-1",
        "Não foi possível completar a solicitação (HTTP 404).",
      ),
    );
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const texto = String(toastError.mock.calls[0]?.[0] ?? "");
    expect(texto).toBe("Não foi possível executar o teste (HTTP 404).");
    expect(texto).not.toContain("<!DOCTYPE");
    expect(JSON.stringify(toastError.mock.calls)).not.toMatch(/sk-|cookie/i);
  });

  it("TimeoutError mostra a mensagem específica, não Erro inesperado", async () => {
    post.mockRejectedValueOnce(
      new DOMException("A requisição não respondeu em 120000ms.", "TimeoutError"),
    );
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const texto = String(toastError.mock.calls[0]?.[0] ?? "");
    expect(texto).toBe(
      "O teste demorou mais que o esperado. Verifique a aba Execuções antes de tentar novamente.",
    );
    expect(texto).not.toBe("Erro inesperado.");
    expect(texto.toLowerCase()).not.toMatch(/retry|automatic/);
    expect(texto).not.toContain("<!DOCTYPE");
    expect(texto).not.toMatch(/sk-|cookie|ANTHROPIC|Bearer /i);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("timeout gera um POST; resposta tardia não inicia segunda mutação", async () => {
    let rejeitar: (reason: unknown) => void = () => undefined;
    let resolver: (value: unknown) => void = () => undefined;
    post.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolver = resolve;
          rejeitar = reject;
        }),
    );
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
    expect(post).toHaveBeenCalledTimes(1);
    rejeitar(new DOMException("A requisição não respondeu em 120000ms.", "TimeoutError"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "O teste demorou mais que o esperado. Verifique a aba Execuções antes de tentar novamente.",
      ),
    );
    resolver({ data: { run_id: "tarde", status: "ok" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Executar teste" })).toBeEnabled());
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Teste executado.")).not.toBeInTheDocument();
  });

  it("mostra a resposta gerada e o bloqueio operacional, sem pedir novo clique", async () => {
    post.mockResolvedValueOnce({
      data: {
        run_id: "b697a6dc-639e-403a-aca4-1d8cf31e57c0",
        status: "blocked",
        generated_response: "Olá, posso ajudar com o pedido.",
        delivery_status: "blocked",
        delivery_impediments: [
          { code: "outside_window", message: "Fora da janela de envio 7h–22h" },
        ],
        notice: "Resposta gerada, mas não seria enviada agora.",
        tokens_in: 15707,
        tokens_out: 613,
        cost_cents: 1.8772,
        latency_ms: 4120,
      },
    });
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi, quanto custa?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
    await waitFor(() => expect(screen.getByTestId("ensaio-envio-bloqueado")).toBeInTheDocument());
    expect(screen.getByText("Resposta gerada — envio bloqueado")).toBeInTheDocument();
    expect(screen.getByText("Resposta gerada, mas não seria enviada agora.")).toBeInTheDocument();
    expect(screen.getByText("Fora da janela de envio 7h–22h")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma mensagem foi enviada.")).toBeInTheDocument();
    expect(screen.getByText("Olá, posso ajudar com o pedido.")).toBeInTheDocument();
    expect(
      screen.getByText(`${(15707).toLocaleString()} / ${(613).toLocaleString()}`),
    ).toBeInTheDocument();
    expect(screen.getByText(/1[,.]8772/)).toBeInTheDocument();
    expect(screen.queryByText("tentar novamente")).not.toBeInTheDocument();
    expect(screen.queryByText(/clique novamente/i)).not.toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("bloqueio de segurança não mostra o conteúdo inseguro", async () => {
    post.mockResolvedValueOnce({
      data: {
        run_id: "run-sec",
        status: "blocked",
        generated_response: null,
        delivery_status: "withheld",
        security_impediments: [
          { code: "internal_vocabulary_leak", message: "A resposta usaria palavras internas" },
        ],
      },
    });
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
    await waitFor(() => expect(screen.getByTestId("ensaio-resposta-retida")).toBeInTheDocument());
    expect(screen.getAllByText("Resposta retida").length).toBeGreaterThan(0);
    expect(screen.getByText("A resposta usaria palavras internas")).toBeInTheDocument();
    expect(screen.queryByText("crm_list_leads")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ensaio-envio-bloqueado")).not.toBeInTheDocument();
  });

  it("mostra que o checkpoint não foi gerado na execução isolada", async () => {
    post.mockResolvedValueOnce({
      data: {
        run_id: "run-iso",
        status: "ok",
        generated_response: "O Sigilium é um CRM.",
        delivery_status: "allowed",
        checkpoint_generated: false,
        checkpoint_notice: "Checkpoint não gerado: ensaio isolado.",
        llm_purposes: ["stage_classifier", "jailbreak_detect", "promise_semantic", "agent_preview"],
        tools_offered: ["request_human_handoff", "send_message"],
        tools_called: ["send_message"],
        steps_count: 1,
        tokens_in: 4750,
        tokens_out: 191,
        cost_cents: 0.5605,
      },
    });
    montar();
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "o que é o Sigilium?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
    await waitFor(() =>
      expect(screen.getByText("Checkpoint não gerado: ensaio isolado.")).toBeInTheDocument(),
    );
    expect(screen.getByText("O Sigilium é um CRM.")).toBeInTheDocument();
    expect(screen.getByText("stage_classifier, jailbreak_detect, promise_semantic, agent_preview")).toBeInTheDocument();
    expect(screen.getByText("request_human_handoff, send_message")).toBeInTheDocument();
    expect(screen.getByText(`${(4750).toLocaleString()} / ${(191).toLocaleString()}`)).toBeInTheDocument();
    expect(screen.getByText(/0[,.]5605/)).toBeInTheDocument();
    expect(screen.queryByText(/1[,.]3674/)).not.toBeInTheDocument();
  });
});
