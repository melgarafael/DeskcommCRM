/**
 * ABRIR UM DIA PELA TELA — a metade da capacidade que não tinha por onde entrar.
 *
 * `calendar_availability_exceptions.is_unavailable` sempre teve os dois
 * sentidos; a rota sempre aceitou os dois (ela audita `agenda.dia_bloqueado`
 * OU `agenda.dia_aberto`); o motor de horários livres sempre respeitou o
 * segundo — em `janelasDoDia`, uma exceção ABERTA substitui a jornada do dia —;
 * e a lista desta tela sempre soube rotulá-lo ("aberto excepcionalmente").
 *
 * Só o formulário não: ele mandava `is_unavailable: true` e `0..1440`, fixos no
 * código. Capacidade viva no banco, na rota, no motor e na listagem, sem porta
 * na interface (invariante 6 do Sistema Vivo).
 *
 * Quem paga é quem NÃO trabalha em jornada semanal fixa. Medido numa clínica
 * com atendimento em dias irregulares, cada dia numa unidade diferente: a
 * jornada fica vazia de propósito (todo dia nasce fechado) e cada data de
 * atendimento é uma exceção aberta com faixa de horário. Essa agenda não tinha
 * como ser montada pela tela — só escrevendo no banco à mão.
 *
 * As três asserções, e por que cada uma existe:
 *
 *   1. FECHAR continua fechando o dia inteiro. É o caminho que já existia, e a
 *      regressão mais cara seria um dia de férias virar meio dia.
 *   2. ABRIR manda `is_unavailable: false` COM a faixa escolhida. Sem a faixa,
 *      abrir o dia inteiro ofereceria horário de madrugada.
 *   3. Faixa invertida não chega a sair. O CHECK do banco (`end_minute >
 *      start_minute`) devolveria 422; barrar no botão troca o erro por um
 *      botão que não deixa errar.
 *   4. FECHAR SÓ ALGUMAS HORAS manda `is_unavailable: true` COM a faixa. Antes,
 *      tirar uma hora do meio do dia exigia ABRIR as duas metades (a exceção
 *      aberta substitui a jornada) — o motor sempre soube fechar um pedaço
 *      (`tests/unit/agenda-horarios-livres.test.ts`, "indisponível NO MEIO do
 *      dia"), só a tela não deixava.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn((..._a: unknown[]) => Promise.resolve({ data: {} }));
/** O que a tela já tem cadastrado — o lote confere duplicata contra isto. */
let jaCadastrado: unknown[] = [];
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: () => Promise.resolve({ data: jaCadastrado }),
    post: (...a: unknown[]) => post(...a),
    delete: () => Promise.resolve({}),
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { DiasBloqueados } from "./DiasBloqueados";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DiasBloqueados podeEditar />
    </QueryClientProvider>,
  );
}

/** O corpo do único POST que saiu. */
function corpoEnviado(): Record<string, unknown> {
  expect(post).toHaveBeenCalledTimes(1);
  return post.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("Dias fora da rotina — fechar e abrir", () => {
  beforeEach(() => {
    post.mockClear();
    jaCadastrado = [];
  });

  it("fechar continua mandando o dia INTEIRO", async () => {
    const u = userEvent.setup();
    montar();

    await u.type(screen.getByLabelText("Dia"), "2026-10-01");
    await u.click(screen.getByRole("button", { name: "Fechar este dia" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(corpoEnviado()).toMatchObject({
      exception_date: "2026-10-01",
      is_unavailable: true,
      start_minute: 0,
      end_minute: 1440,
    });
  });

  it("abrir manda is_unavailable false COM a faixa escolhida", async () => {
    const u = userEvent.setup();
    montar();

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "abrir");
    await u.type(screen.getByLabelText("Dia"), "2026-10-01");
    await u.clear(screen.getByLabelText("Das"));
    await u.type(screen.getByLabelText("Das"), "14:00");
    await u.clear(screen.getByLabelText("Até"));
    await u.type(screen.getByLabelText("Até"), "18:00");
    await u.click(screen.getByRole("button", { name: "Abrir este dia" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(corpoEnviado()).toMatchObject({
      exception_date: "2026-10-01",
      is_unavailable: false,
      start_minute: 840,
      end_minute: 1080,
    });
  });

  it("faixa invertida não chega a sair", async () => {
    const u = userEvent.setup();
    montar();

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "abrir");
    await u.type(screen.getByLabelText("Dia"), "2026-10-01");
    await u.clear(screen.getByLabelText("Das"));
    await u.type(screen.getByLabelText("Das"), "18:00");
    await u.clear(screen.getByLabelText("Até"));
    await u.type(screen.getByLabelText("Até"), "14:00");

    expect(screen.getByRole("button", { name: "Abrir este dia" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("repete semanalmente até a data limite, um POST por dia", async () => {
    const u = userEvent.setup();
    montar();

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "abrir");
    await u.type(screen.getByLabelText("Dia"), "2026-10-01");
    await u.clear(screen.getByLabelText("Das"));
    await u.type(screen.getByLabelText("Das"), "14:00");
    await u.clear(screen.getByLabelText("Até"));
    await u.type(screen.getByLabelText("Até"), "18:00");
    // 01, 08, 15 e 22 de outubro — quatro quintas.
    await u.type(screen.getByLabelText("Repetir toda semana até (opcional)"), "2026-10-22");
    await u.click(screen.getByRole("button", { name: "Abrir este dia" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(4));
    expect(post.mock.calls.map((c) => (c[1] as { exception_date: string }).exception_date)).toEqual([
      "2026-10-01",
      "2026-10-08",
      "2026-10-15",
      "2026-10-22",
    ]);
    // Um dia é uma linha: a faixa não pode variar ao longo do lote.
    for (const c of post.mock.calls) {
      expect(c[1]).toMatchObject({ is_unavailable: false, start_minute: 840, end_minute: 1080 });
    }
    expect(await screen.findByTestId("resultado-do-lote")).toHaveTextContent("4");
  });

  it("não repete além de um ano, por mais longe que a data peça", async () => {
    const u = userEvent.setup();
    montar();

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "abrir");
    await u.type(screen.getByLabelText("Dia"), "2026-10-01");
    // Dez anos: é o dedo escorregando na data, e sem teto viraria 520 linhas.
    await u.type(screen.getByLabelText("Repetir toda semana até (opcional)"), "2036-10-01");
    await u.click(screen.getByRole("button", { name: "Abrir este dia" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls.length).toBe(53);
  });

  it("pula o que já está cadastrado em vez de duplicar a linha", async () => {
    // A tabela NÃO tem unicidade por data — de propósito, porque um dia pode ter
    // duas faixas (manhã num lugar, tarde noutro). Sem esta conferência, repetir
    // o mesmo período duas vezes dobraria cada linha em silêncio.
    jaCadastrado = [
      {
        id: "ja-existe",
        exception_date: "2026-10-08",
        is_unavailable: false,
        start_minute: 840,
        end_minute: 1080,
        reason: null,
      },
    ];
    const u = userEvent.setup();
    montar();
    await screen.findByText(/08\/10\/2026|10\/8\/2026/);

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "abrir");
    await u.type(screen.getByLabelText("Dia"), "2026-10-01");
    await u.clear(screen.getByLabelText("Das"));
    await u.type(screen.getByLabelText("Das"), "14:00");
    await u.clear(screen.getByLabelText("Até"));
    await u.type(screen.getByLabelText("Até"), "18:00");
    await u.type(screen.getByLabelText("Repetir toda semana até (opcional)"), "2026-10-15");
    await u.click(screen.getByRole("button", { name: "Abrir este dia" }));

    // 01, 08 e 15 eram os alvos; o 08 já existia com a MESMA faixa.
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls.map((c) => (c[1] as { exception_date: string }).exception_date)).toEqual([
      "2026-10-01",
      "2026-10-15",
    ]);
    expect(await screen.findByTestId("resultado-do-lote")).toHaveTextContent("1");
  });
});

describe("Dias fora da rotina — fechar só algumas horas", () => {
  beforeEach(() => {
    post.mockClear();
    jaCadastrado = [];
  });

  it("manda is_unavailable true COM a faixa escolhida, e diz que o resto do dia segue", async () => {
    const u = userEvent.setup();
    montar();

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "fechar-horas");
    expect(screen.getByTestId("explica-fechar-horas")).toHaveTextContent("O resto do dia segue a jornada de sempre.");
    await u.type(screen.getByLabelText("Dia"), "2026-11-03");
    await u.clear(screen.getByLabelText("Das"));
    await u.type(screen.getByLabelText("Das"), "14:00");
    await u.clear(screen.getByLabelText("Até"));
    await u.type(screen.getByLabelText("Até"), "15:30");
    await u.type(screen.getByLabelText("Motivo (opcional)"), "Banco");
    await u.click(screen.getByRole("button", { name: "Fechar estas horas" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(corpoEnviado()).toEqual({
      exception_date: "2026-11-03",
      is_unavailable: true,
      start_minute: 840,
      end_minute: 930,
      reason: "Banco",
    });
  });

  it("faixa invertida também não sai ao fechar horas", async () => {
    const u = userEvent.setup();
    montar();

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "fechar-horas");
    await u.type(screen.getByLabelText("Dia"), "2026-11-03");
    await u.clear(screen.getByLabelText("Das"));
    await u.type(screen.getByLabelText("Das"), "15:00");
    await u.clear(screen.getByLabelText("Até"));
    await u.type(screen.getByLabelText("Até"), "14:00");

    expect(screen.getByRole("button", { name: "Fechar estas horas" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("repete toda semana pulando só a MESMA faixa já FECHADA — a aberta igual não conta", async () => {
    jaCadastrado = [
      // A mesma faixa, mas ABERTA: é outra coisa, não é duplicata.
      { id: "aberta", exception_date: "2026-11-03", is_unavailable: false, start_minute: 720, end_minute: 780, reason: null },
      // A mesma faixa FECHADA: essa sim já existe.
      { id: "fechada", exception_date: "2026-11-10", is_unavailable: true, start_minute: 720, end_minute: 780, reason: null },
    ];
    const u = userEvent.setup();
    montar();
    await screen.findByText(/10\/11\/2026|11\/10\/2026/);

    await u.selectOptions(screen.getByTestId("modo-do-dia"), "fechar-horas");
    await u.type(screen.getByLabelText("Dia"), "2026-11-03");
    await u.clear(screen.getByLabelText("Das"));
    await u.type(screen.getByLabelText("Das"), "12:00");
    await u.clear(screen.getByLabelText("Até"));
    await u.type(screen.getByLabelText("Até"), "13:00");
    await u.type(screen.getByLabelText("Repetir toda semana até (opcional)"), "2026-11-17");
    await u.click(screen.getByRole("button", { name: "Fechar estas horas" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls.map((c) => (c[1] as { exception_date: string }).exception_date)).toEqual([
      "2026-11-03",
      "2026-11-17",
    ]);
    for (const c of post.mock.calls) {
      expect(c[1]).toMatchObject({ is_unavailable: true, start_minute: 720, end_minute: 780 });
    }
  });

  it("a lista diz quando a faixa está FECHADA; o dia inteiro fechado segue sem rótulo", async () => {
    jaCadastrado = [
      { id: "1", exception_date: "2026-11-03", is_unavailable: true, start_minute: 840, end_minute: 900, reason: "Banco" },
      { id: "2", exception_date: "2026-11-04", is_unavailable: true, start_minute: 0, end_minute: 1440, reason: null },
      { id: "3", exception_date: "2026-11-07", is_unavailable: false, start_minute: 840, end_minute: 900, reason: null },
    ];
    montar();

    const itens = await screen.findAllByRole("listitem");
    expect(itens.map((li) => li.textContent?.replace(/^[^·]*· /, "").replace(/Reabrir$/, ""))).toEqual([
      "14:00–15:00 · fechado nessas horas · Banco",
      "o dia todo",
      "14:00–15:00 · aberto excepcionalmente",
    ]);
  });
});
