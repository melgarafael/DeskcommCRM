/**
 * O DRAWER DA EXECUÇÃO DE TESTE MOSTRA A PERGUNTA, A RESPOSTA E AS AÇÕES (#4426).
 *
 * ─── O defeito medido ──────────────────────────────────────────────────────
 *
 * Quem testa uma versão do agente vê nascer uma linha em "Execuções", com
 * tokens, custo e latência — e, ao abrir, o drawer diz "Sem trace disponível.".
 * A pergunta e a resposta só existiam no painel de teste enquanto ele estava
 * aberto; as ações propostas ficavam em `ai_agent_runs.tool_calls` e nenhuma
 * tela as lia, porque a aba pedia a linha a `llm_calls`.
 *
 * ─── Por que este arquivo existe, se a rota já tem teste ───────────────────
 *
 * `tests/unit/execucao-do-teste-guarda-a-pergunta.test.ts` mede a ROTA (o que é
 * gravado e o que é devolvido). Aqui se mede o que a PESSOA vê: o componente
 * real, com a linha que a rota entrega. Sem este caso, "o drawer mostra" era
 * afirmação de leitura de código — e o defeito nasceu justamente entre a rota e
 * a tela.
 *
 * A linha de execução real é o controle positivo do não-vazamento: ela não tem
 * texto nem passos de teste, e o drawer continua dizendo o que dizia.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { RunDetailDrawer } from "@/app/app/ai/agents/[id]/_components/RunDetailDrawer";

const PERGUNTA = "Vocês entregam em Campinas no sábado?";
const RESPOSTA = "Entregamos, sim: até as 18h.";
const PROPOSTA = {
  tool: "save_lead_note",
  arguments: { headline: "Prefere ligação à tarde" },
};

function linhaDeExecucao(porCima: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agent_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    agent_version_id: null,
    conversation_id: null,
    contact_id: null,
    channel_session_id: null,
    inbound_message_id: null,
    outbound_message_id: null,
    status: "completed",
    abort_reason: null,
    error_code: null,
    error_message: null,
    tokens_in: 1234,
    tokens_out: 56,
    cost_cents: 7,
    latency_ms: 1250,
    steps_count: null,
    tool_calls: null,
    is_dry_run: true,
    started_at: "2026-11-12T13:00:00.000Z",
    completed_at: "2026-11-12T13:00:01.250Z",
    created_at: "2026-11-12T13:00:00.000Z",
    input_text: PERGUNTA,
    output_text: RESPOSTA,
    ...porCima,
  };
}

function desenhar(linha: Record<string, unknown>) {
  // O tipo do componente é o do hook; aqui chega o que a ROTA devolve.
  return render(
    <RunDetailDrawer
      run={linha as unknown as Parameters<typeof RunDetailDrawer>[0]["run"]}
      open
      onOpenChange={() => undefined}
    />,
  );
}

/**
 * O MESMO formatador da tela: `RunDetailDrawer.tsx:83` passa os contadores por
 * `toLocaleString()` SEM locale fixo, então o separador de milhar segue o
 * locale do runtime — "1.234" no pt-BR da VPS, "1,234" no en-US do runner do
 * CI. Escrever o literal aqui foi o que fez este arquivo passar local e
 * reprovar em `verify-parte (4)`; a régua passa a ser o formatador do produto
 * (mesmo padrão de `lib/automation/actions/notify-team.test.ts`).
 */
const formatarTokens = (n: number) => n.toLocaleString();

/** A célula (`div`) que desenha o rótulo e o par de contadores. */
const celulaDeTokens = () => screen.getByText("Tokens (in/out)").closest("div");

afterEach(() => {
  cleanup();
});

describe("drawer da execução de teste (#4426)", () => {
  it("mostra a mensagem enviada, a resposta da IA e mantém tokens, custo e latência", () => {
    desenhar(linhaDeExecucao({}));

    expect(screen.getByTestId("execucao-mensagem-do-teste")).toHaveTextContent(PERGUNTA);
    expect(screen.getByTestId("execucao-resposta-da-ia")).toHaveTextContent(RESPOSTA);

    // O que já existia não pode sair da tela por causa do texto novo.
    // (o par de tokens é desenhado em dois nós — texto + " / " + texto)
    // O valor de teste tem de DIFERIR do cru neste runtime: num locale sem
    // agrupamento a asserção viraria identidade e passaria até sem formatação.
    expect(formatarTokens(1234), "o locale do runtime não agrupa 1234 — a régua perderia o poder de discriminar").not.toBe("1234");
    expect(celulaDeTokens()).toHaveTextContent(`${formatarTokens(1234)} / ${formatarTokens(56)}`);
    expect(screen.getByText("US$ 0.0700")).toBeInTheDocument();
    expect(screen.getByText("1.25s")).toBeInTheDocument();
    // E não sobra o vazio de antes.
    expect(screen.queryByText("Sem trace disponível.")).toBeNull();
  });

  it("desenha no trace a ação que o teste propôs", () => {
    desenhar(linhaDeExecucao({ tool_calls: [PROPOSTA] }));

    // O nome da ferramenta propostas aparece como passo do trace, e os
    // argumentos vão em JSON — o formato da prévia ({ tool, arguments }).
    expect(screen.getByText("save_lead_note")).toBeInTheDocument();
    expect(screen.getByText(/#1/)).toBeInTheDocument();
    expect(screen.getByText(/"Prefere ligação à tarde"/)).toBeInTheDocument();
    expect(screen.queryByText("Sem trace disponível.")).toBeNull();
  });

  it("execução real não herda texto nem passos de teste (controle positivo)", () => {
    desenhar(
      linhaDeExecucao({
        is_dry_run: false,
        contact_id: "33333333-3333-4333-8333-333333333333",
        input_text: null,
        output_text: null,
      }),
    );

    expect(screen.queryByTestId("execucao-mensagem-do-teste")).toBeNull();
    expect(screen.queryByTestId("execucao-resposta-da-ia")).toBeNull();
    expect(screen.queryByText(PERGUNTA)).toBeNull();
    expect(screen.queryByText(RESPOSTA)).toBeNull();
    expect(screen.queryByText("save_lead_note")).toBeNull();
    // Sem texto e sem passos, o trace continua dizendo o que dizia.
    expect(screen.getByText("Sem trace disponível.")).toBeInTheDocument();
    // E as métricas continuam na tela.
    expect(formatarTokens(1234), "o locale do runtime não agrupa 1234 — a régua perderia o poder de discriminar").not.toBe("1234");
    expect(celulaDeTokens()).toHaveTextContent(`${formatarTokens(1234)} / ${formatarTokens(56)}`);
  });
});
