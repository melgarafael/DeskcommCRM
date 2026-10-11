/**
 * O ENSAIO DO ONBOARDING NÃO CHAMA ERRO QUANDO O TURNO DEU CERTO (#2686).
 *
 * A rota `/api/v1/ai/agents/[id]/versions/[vid]/test` devolve `status: "ok"`
 * no payload quando há candidato e nenhuma mídia pendente (o vocabulário de
 * `llm_calls`), enquanto grava `completed` na linha de `ai_agent_runs`. A tela
 * de "Veja ele atender" comparava só com `"completed"` e tratava qualquer
 * outro valor como falha: com resposta gerada na mão, a pessoa via "Ele não
 * conseguiu responder" e o motivo `o ensaio terminou como "ok"` — e ia
 * procurar credencial sem saldo onde não faltou nada.
 *
 * Os três casos abaixo são a régua decidida na issue: `ok` e `completed` são
 * SUCESSO na tela; qualquer outro valor (`failed`, `blocked`) continua erro.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TestarClient } from "@/app/onboarding/testar/_client";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/app/actions/onboarding/marcarTeste", () => ({
  marcarTesteFeito: vi.fn(),
  pularTeste: vi.fn(),
}));

const RESPOSTA = "Oi! Atendemos das 8h às 18h e o preço do plano é R$ 199.";

function ensaiarCom(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    })),
  );
  render(<TestarClient nome="Ana" agenteId="ag-1" versaoId="ver-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Mandar mensagem" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensaio do onboarding: o que conta como sucesso", () => {
  it('status "ok" (o que a rota devolve com candidato): mostra a resposta, sem erro', async () => {
    ensaiarCom({ data: { status: "ok", final_text: RESPOSTA } });

    expect(await screen.findByText(RESPOSTA)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it('status "completed": continua sendo sucesso', async () => {
    ensaiarCom({ data: { status: "completed", final_text: RESPOSTA } });

    expect(await screen.findByText(RESPOSTA)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it('status "failed": continua sendo erro, com o motivo à vista', async () => {
    ensaiarCom({
      data: {
        status: "failed",
        final_text: "",
        error_code: "preview_failed",
        error_message: "chave da empresa de IA sem saldo",
      },
    });

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("Ele não conseguiu responder");
    expect(alerta.textContent).toContain("chave da empresa de IA sem saldo");
    expect(screen.queryByText(RESPOSTA)).toBeNull();
  });
});
