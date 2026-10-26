import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ptBR } from "date-fns/locale";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PacoteAgendado } from "@/lib/inbox/agendamento-na-conversa";

/**
 * A FAIXA DAS AGENDADAS (#3118) — o que ela mostra e o que o `x` faz.
 *
 * ─── Por que este teste existe separado ────────────────────────────────────
 *
 * O compositor já tem três testes que o montam inteiro, e todos eles mockam a
 * lista de agendadas (a faixa não é o assunto deles). O desenho da faixa fica
 * sem prova nenhuma se ninguém montar o componente com uma conversa que TEM
 * pacote — e o defeito silencioso aqui é caro: um pacote `failed` que não
 * aparece é uma mensagem que ninguém sabe que não saiu.
 *
 * ─── O que NÃO se prende aqui de propósito ─────────────────────────────────
 *
 * A HORA sai formatada no fuso do processo de teste, que não é estável entre
 * máquinas. O caso cobra o FORMATO (`dd/MM HH:mm`), não o valor: prender o
 * valor faria o teste passar só em quem roda em UTC-3.
 */
const get = vi.fn();
const del = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => ptBR }));

import { FaixaDeAgendadas } from "./FaixaDeAgendadas";

function parte(
  position: number,
  body: string | null,
  status: "pending" | "sent" | "failed" | "skipped" = "pending",
): PacoteAgendado["parts"][number] {
  return {
    id: `parte-${position}`,
    position,
    body,
    media_mime: body === null ? "image/jpeg" : null,
    media_size_bytes: null,
    status,
    error_code: null,
    sent_at: null,
  };
}

function pacote(over: Partial<PacoteAgendado> = {}, partes = [parte(0, "Bom dia!")]): PacoteAgendado {
  return {
    id: "p1",
    conversation_id: "c1",
    // Meio-dia UTC: em qualquer fuso razoável continua sendo o mesmo dia, e o
    // caso não vira um teste de virada de data.
    scheduled_for: "2026-11-02T12:30:00.000Z",
    tz: "America/Sao_Paulo",
    status: "scheduled",
    cancel_if_contact_replies: false,
    cancel_reason: null,
    cancelled_at: null,
    last_error: null,
    created_at: "2026-11-01T12:00:00.000Z",
    parts: partes,
    ...over,
  };
}

function montar(pacotes: PacoteAgendado[]) {
  get.mockResolvedValue({ data: pacotes });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FaixaDeAgendadas conversationId="c1" />
    </QueryClientProvider>,
  );
}

describe("FaixaDeAgendadas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    del.mockResolvedValue({ data: pacote() });
  });
  afterEach(() => cleanup());

  it("sem nada agendado, a faixa não ocupa faixa nenhuma", async () => {
    montar([]);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId("faixa-agendadas")).toBeNull();
  });

  it("mostra a hora no formato da tela e o começo do texto", async () => {
    montar([pacote()]);
    const faixa = await screen.findByTestId("faixa-agendadas");
    expect(faixa.textContent).toContain("Bom dia!");
    expect(faixa.textContent).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("pacote com várias partes diz quantas são", async () => {
    montar([pacote({}, [parte(0, "Oi"), parte(1, "Tudo bem?")])]);
    const faixa = await screen.findByTestId("faixa-agendadas");
    expect(faixa.textContent).toContain("2 mensagens seguidas");
  });

  it("pacote só de anexo não mostra texto vazio — mostra que é anexo", async () => {
    montar([pacote({}, [parte(0, null)])]);
    const faixa = await screen.findByTestId("faixa-agendadas");
    expect(faixa.textContent).toContain("(anexo)");
  });

  it("o `x` desmarca pelo DELETE do pacote e some da faixa", async () => {
    montar([pacote()]);
    const botao = await screen.findByRole("button", { name: "Cancelar envio agendado" });
    fireEvent.click(botao);
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/scheduled-messages/p1"));
  });

  it("`sent` e `cancelled` viram história: não aparecem na faixa", async () => {
    montar([pacote({ id: "enviado", status: "sent" }), pacote({ id: "cancelado", status: "cancelled" })]);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId("faixa-agendadas")).toBeNull();
  });

  it("`failed` aparece com o motivo — e SEM botão: não há o que desmarcar", async () => {
    montar([pacote({ status: "failed", last_error: "sessao_fora_de_working" })]);
    const faixa = await screen.findByTestId("faixa-agendadas");
    expect(faixa.textContent).toContain("Não saiu");
    expect(faixa.textContent).toContain("sessao_fora_de_working");
    expect(screen.queryByRole("button", { name: "Cancelar envio agendado" })).toBeNull();
  });

  it("`sending` também não oferece cancelar: o que já saiu não volta", async () => {
    montar([pacote({ status: "sending" })]);
    const faixa = await screen.findByTestId("faixa-agendadas");
    expect(faixa.textContent).toContain("Enviando agora…");
    expect(screen.queryByRole("button", { name: "Cancelar envio agendado" })).toBeNull();
  });

  it("a marca de cancelar-se-o-contato-responder aparece quando está ligada", async () => {
    montar([pacote({ cancel_if_contact_replies: true })]);
    const faixa = await screen.findByTestId("faixa-agendadas");
    expect(faixa.textContent).toContain("Cancela se o contato responder");
  });
});
