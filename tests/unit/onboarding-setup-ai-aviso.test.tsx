/**
 * A tela do passo "Configurar IA" quando o agente é criado mas NÃO publicado.
 *
 * O contrato da action mudou (`publish_error`), e contrato que só existe no
 * servidor não é informação: antes, um erro de banco ao listar os canais fazia
 * a tela ficar exatamente igual — mesmo botão, mesma ausência de aviso — e a
 * pessoa seguia achando que tinha um atendente pronto. Este teste guarda o que
 * ela VÊ: a explicação, a causa técnica (é o dono da VPS quem vai consertar) e
 * uma saída para não ficar presa no passo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { CreateAgentResult } from "@/app/actions/onboarding/createDefaultAgent";

const createDefaultAgentMock = vi.fn<() => Promise<CreateAgentResult>>();
vi.mock("@/app/actions/onboarding/createDefaultAgent", () => ({
  createDefaultAgent: () => createDefaultAgentMock(),
  skipAi: vi.fn(),
}));

const toastWarning = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { warning: (m: string) => toastWarning(m), error: (m: string) => toastError(m), success: vi.fn() },
}));

import { SetupAiForm } from "@/app/onboarding/setup-ai/_form";

/**
 * As listas de "o que ele já sabe" e "o que nunca faz" vêm do servidor, das
 * mesmas fontes que o runtime usa. Aqui são fixas de propósito: o que está sob
 * teste é o que a tela diz quando a publicação falha, não o catálogo.
 */
function montar() {
  return (
    <SetupAiForm
      capacidades={["Ver os clientes", "Mover o negócio no funil"]}
      conferencias={["Insistir com quem pediu para parar"]}
    />
  );
}

/**
 * `findByRole` e não `getByRole`: enquanto a transição está pendente o botão se
 * chama "Criando...", e o aviso pode aparecer num commit ANTES de o pendente
 * cair. Buscar pelo rótulo final é o que espera o formulário estar clicável de
 * novo — sem isso a 2ª submissão falha só em máquina carregada.
 */
async function enviar() {
  fireEvent.click(await screen.findByRole("button", { name: /criar e continuar/i }));
}

afterEach(() => {
  cleanup();
  createDefaultAgentMock.mockReset();
  toastWarning.mockReset();
  toastError.mockReset();
});

describe("setup de IA: o que a tela diz quando o agente fica rascunho", () => {
  it("mostra o aviso, a causa e uma saída — em vez de nada", async () => {
    createDefaultAgentMock.mockResolvedValue({
      ok: true,
      agent_id: "agente-1",
      publish_error: "channel_sessions_list_failed: permission denied for table channel_sessions",
    });

    render(montar());
    await enviar();

    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent(/rascunho/i);
    // A causa técnica aparece: quem instalou numa VPS é quem pode consertar.
    expect(aviso).toHaveTextContent(/permission denied for table channel_sessions/);
    // E há como sair do passo sem fingir que publicou.
    expect(screen.getByRole("button", { name: /continuar sem publicar/i })).toBeInTheDocument();
    expect(toastWarning).toHaveBeenCalled();
  });

  it("caminho normal não inventa alarme", async () => {
    // O sucesso completo redireciona no servidor; a resposta que chega aqui sem
    // `publish_error` é a do agente publicado.
    createDefaultAgentMock.mockResolvedValue({ ok: true, agent_id: "agente-1" });

    render(montar());
    await enviar();

    await waitFor(() => expect(createDefaultAgentMock).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  /**
   * A SEGUNDA causa. O agente pode ficar rascunho por dois motivos bem
   * diferentes: não se sabe qual número ele atenderia (canal), ou não se sabe
   * qual modelo ele usaria (o provedor escolhido na instalação ainda não tem
   * catálogo aqui). A tela afirmava sempre o primeiro — e mandar a pessoa
   * conferir o WhatsApp quando o WhatsApp está certo é pior do que não dizer
   * nada: ela mexe no que funciona e o rascunho continua rascunho.
   */
  it("causa 'modelo': não acusa o WhatsApp, e diz o caminho real", async () => {
    createDefaultAgentMock.mockResolvedValue({
      ok: true,
      agent_id: "agente-1",
      publish_blocked_by: "modelo",
      provider: "openrouter",
    });

    render(montar());
    await enviar();

    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent(/rascunho/i);
    // A causa certa, nomeando o provedor que a pessoa escolheu no instalador.
    expect(aviso).toHaveTextContent(/openrouter/i);
    // E NUNCA a causa errada: o número de WhatsApp não tem nada a ver com isto.
    expect(aviso).not.toHaveTextContent(/números de WhatsApp/i);
    expect(screen.getByRole("button", { name: /continuar sem publicar/i })).toBeInTheDocument();
    expect(toastWarning).toHaveBeenCalled();
  });

  it("uma retentativa que dá certo apaga o aviso anterior", async () => {
    createDefaultAgentMock.mockResolvedValueOnce({
      ok: true,
      agent_id: "agente-1",
      publish_error: "channel_sessions_list_failed: connection refused",
    });
    render(montar());
    await enviar();
    await screen.findByRole("alert");

    createDefaultAgentMock.mockResolvedValueOnce({ ok: true, agent_id: "agente-1" });
    await enviar();

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
