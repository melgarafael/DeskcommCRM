/**
 * PUXAR A BORDA PEDE CONFIRMAÇÃO, E A ESCRITA É SÓ A DURAÇÃO (#4450).
 *
 * A grade entrega "60 minutos para a1"; quem decide o que acontece com isso é
 * a `AgendaInterativa`, e é aqui que mora o que o usuário sente:
 *
 * - a confirmação vem ANTES da escrita, e o card não finge que já mudou;
 * - a frase não promete que ninguém fica sabendo — com o Google ligado, o
 *   convidado recebe a atualização do Google;
 * - o PATCH leva `duration_minutes` e a `revision` do card, e NÃO leva
 *   `starts_at`: mudar o tempo não é remarcar;
 * - recusa do servidor devolve o card e diz o motivo; a revisão que não bate
 *   (alguém mudou antes) mostra o horário que vale agora em vez de sobrescrever.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ptBR } from "date-fns/locale";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaInterativa } from "@/components/agenda/AgendaInterativa";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";
import { ApiError } from "@/lib/api/types";

/**
 * O PATCH, registrado à mão em vez de `vi.fn`: o espião do vitest observa a
 * promessa devolvida e, quando ela é rejeitada, a observação dele vira rejeição
 * não tratada — o caso de recusa reprovaria pela ferramenta, não pela tela.
 */
const chamadas: unknown[] = [];
let resposta: () => Promise<unknown> = () => Promise.resolve({ data: { id: "a1" } });
function mutateAsync(entrada: unknown) {
  chamadas.push(entrada);
  return resposta();
}

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({
    data: { slots: [], fuso_da_regra: "UTC", publicou_horarios: true },
    isError: false,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/agenda/useHorariosLivresPorPessoa", () => ({
  useHorariosLivresPorPessoa: () => ({}),
}));
vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (chave: string) => chave,
}));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useLocaleDeData: () => ptBR,
}));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync }),
}));

beforeEach(() => {
  chamadas.length = 0;
  resposta = () => Promise.resolve({ data: { id: "a1" } });
});
afterEach(cleanup);

const DIA = "2026-08-26";
const FUSO = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PESSOAS: Pessoa[] = [{ id: "p1", nome: "Ana", trilha: 1 }];

function y(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return ((h * 60 + m - 7 * 60) / 60) * 48;
}

function maria(ate = "14:30"): Agendamento {
  return {
    id: "a1",
    revision: 3,
    titulo: "Consulta da Maria",
    responsavelId: "p1",
    comeca: `${DIA}T14:00:00.000`,
    termina: `${DIA}T${ate}:00.000`,
    origem: "ui",
    situacao: "confirmed",
  };
}

function elemento(agendamentos: Agendamento[], agora = new Date(`${DIA}T08:00:00`)) {
  return (
    <AgendaInterativa
      visao="dia"
      ancora={new Date(`${DIA}T12:00:00`)}
      agora={agora}
      fuso={FUSO}
      pessoas={PESSOAS}
      agendamentos={agendamentos}
      recorte={{ de: `${DIA}T00:00:00Z`, ate: `${DIA}T23:59:59Z` }}
      tipos={[{ id: "t1", nome: "Consulta", duracaoMin: 30 }]}
      tipo={{ id: "t1", duracaoMin: 30 }}
      onEscolherTipo={vi.fn()}
      onMarcarEm={vi.fn()}
    />
  );
}

function puxarAte(hhmm: string) {
  const alca = screen.getByTestId("alca-duracao-a1");
  fireEvent.pointerDown(alca, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: y("14:30") });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: y(hhmm) });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: y(hhmm) });
}

const rotuloDoCard = () => screen.getByTestId("agendamento-a1").getAttribute("aria-label") ?? "";

describe("confirmar a nova duração", () => {
  it("pergunta antes, com o intervalo novo e o aviso do Google, sem redesenhar o card", () => {
    render(elemento([maria()]));
    puxarAte("15:00");

    const barra = screen.getByTestId("confirmar-duracao");
    expect(barra).toHaveTextContent("Consulta da Maria");
    expect(barra).toHaveTextContent("14:00–15:00 (60 min)");
    expect(barra).toHaveTextContent(
      "Se a agenda estiver ligada ao Google Agenda, quem foi convidado pode receber um e-mail de atualização do Google.",
    );
    expect(rotuloDoCard()).toContain("14:00 às 14:30");
    expect(chamadas).toHaveLength(0);
  });

  it("confirmar manda SÓ a duração e a revisão — sem `starts_at` — e o card cresce", async () => {
    render(elemento([maria()]));
    puxarAte("15:00");

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    expect(chamadas).toEqual([{ id: "a1", revision: 3, duration_minutes: 60 }]);
    expect(chamadas[0]).not.toHaveProperty("starts_at");
    expect(screen.queryByTestId("confirmar-duracao")).toBeNull();
    expect(rotuloDoCard()).toContain("14:00 às 15:00");
  });

  it("Cancelar fecha a pergunta e não escreve nada", () => {
    render(elemento([maria()]));
    puxarAte("15:00");
    fireEvent.click(screen.getByTestId("cancelar-duracao"));
    expect(screen.queryByTestId("confirmar-duracao")).toBeNull();
    expect(chamadas).toHaveLength(0);
  });

  it("destino recusado pela grade não pergunta nem escreve — diz o motivo", () => {
    const joao: Agendamento = { ...maria(), id: "j1", titulo: "João", comeca: `${DIA}T14:30:00.000`, termina: `${DIA}T15:00:00.000` };
    render(elemento([maria(), joao]));
    puxarAte("14:45");
    expect(screen.queryByTestId("confirmar-duracao")).toBeNull();
    expect(screen.getByTestId("duracao-recusada")).toHaveTextContent(
      "A duração de Consulta da Maria não foi alterada — já há um compromisso neste horário.",
    );
    expect(chamadas).toHaveLength(0);
  });

  it("servidor recusou: o card volta e a frase traz o motivo do servidor", async () => {
    const recusa = new ApiError(
      422,
      "agenda_horario_indisponivel",
      undefined,
      "req",
      "Este horário já está ocupado na agenda de quem atende.",
    );
    resposta = () => Promise.reject(recusa);
    render(elemento([maria()]));
    puxarAte("15:00");
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    expect(rotuloDoCard()).toContain("14:00 às 14:30");
    expect(screen.getByTestId("duracao-recusada")).toHaveTextContent(
      "A duração de Consulta da Maria não foi alterada — Este horário já está ocupado na agenda de quem atende.",
    );
  });

  it("alguém mudou antes (409): não sobrescreve, e só diz o horário novo quando ele chega", async () => {
    const conflito = new ApiError(409, "conflict", undefined, "req", "O compromisso mudou.");
    resposta = () => Promise.reject(conflito);
    const { rerender } = render(elemento([maria()]));
    puxarAte("15:00");
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    // A lista ainda é a nossa: dizer "agora vai de 14:00 a 14:30" seria repetir
    // o horário velho como se fosse o novo.
    expect(screen.getByTestId("duracao-recusada")).toHaveTextContent("Confira o horário atual dele");
    expect(screen.getByTestId("duracao-recusada")).not.toHaveTextContent("14:30");
    // A lista recarregada traz o que o colega gravou: 14:00–14:45.
    rerender(elemento([{ ...maria("14:45"), revision: 4 }]));
    const aviso = screen.getByTestId("duracao-recusada");
    expect(aviso).toHaveTextContent("foi alterado por outra pessoa");
    expect(aviso).toHaveTextContent("agora vai de 14:00 a 14:45");
    expect(rotuloDoCard()).toContain("14:00 às 14:45");
  });

  it("outro 409 (autoridade externa) não vira 'alguém mudou': mostra o motivo do servidor", async () => {
    const externa = new ApiError(409, "agenda_autoridade_externa", undefined, "req", "Este compromisso é do Amigo.");
    resposta = () => Promise.reject(externa);
    render(elemento([maria()]));
    puxarAte("15:00");
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    expect(screen.getByTestId("duracao-recusada")).toHaveTextContent(
      "A duração de Consulta da Maria não foi alterada — Este compromisso é do Amigo.",
    );
  });

  it("a lista recarregou antes do clique (colega gravou): não manda nada e mostra o horário dele", async () => {
    const { rerender } = render(elemento([maria()]));
    puxarAte("15:00");
    rerender(elemento([{ ...maria("14:45"), revision: 4 }]));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    expect(chamadas).toHaveLength(0);
    expect(screen.getByTestId("duracao-recusada")).toHaveTextContent("agora vai de 14:00 a 14:45");
  });

  it("prévia do TECLADO aberta enquanto um colega muda o início: Enter não pergunta nem escreve", () => {
    const { rerender } = render(elemento([maria()]));
    const card = screen.getByTestId("agendamento-a1");
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true, shiftKey: true });
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true, shiftKey: true });
    // O colega passou o início para 14:15 (rev 4); a prévia de 60 min continua aberta.
    rerender(
      elemento([{ ...maria("14:45"), comeca: `${DIA}T14:15:00.000`, revision: 4 }]),
    );
    fireEvent.keyDown(screen.getByTestId("agendamento-a1"), { key: "Enter" });
    expect(screen.queryByTestId("confirmar-duracao")).toBeNull();
    expect(chamadas).toHaveLength(0);
    expect(screen.getByTestId("duracao-recusada")).toHaveTextContent("agora vai de 14:15 a 14:45");
  });

  it("dois cards: confirmar o segundo não desfaz o otimismo do primeiro, e a falha diz de quem é", async () => {
    const joao: Agendamento = {
      ...maria(),
      id: "j1",
      titulo: "Consulta do João",
      comeca: `${DIA}T16:00:00.000`,
      termina: `${DIA}T16:30:00.000`,
    };
    let rejeitarA: (e: unknown) => void = () => {};
    resposta = () => new Promise((_, rej) => (rejeitarA = rej));
    render(elemento([maria(), joao]));
    puxarAte("15:00");
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    resposta = () => new Promise(() => {});
    const alcaB = screen.getByTestId("alca-duracao-j1");
    fireEvent.pointerDown(alcaB, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: y("16:30") });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y("17:00") });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: y("17:00") });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    expect(rotuloDoCard()).toContain("14:00 às 15:00");
    await act(async () => {
      rejeitarA(new ApiError(422, "agenda_horario_indisponivel", undefined, "req", "Ocupado."));
    });
    expect(rotuloDoCard()).toContain("14:00 às 14:30");
    expect(screen.getByTestId("agendamento-j1").getAttribute("aria-label")).toContain("16:00 às 17:00");
    expect(screen.getByTestId("duracao-recusada")).toHaveTextContent(
      "A duração de Consulta da Maria não foi alterada — Ocupado.",
    );
  });

  it("a pergunta ficou aberta até o fim escolhido passar: recusa sem escrever", async () => {
    const inicio = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(inicio);
    try {
      render(elemento([maria()], new Date(`${DIA}T14:40:00`)));
      puxarAte("14:45");
      relogio.mockReturnValue(inicio + 10 * 60_000);
      await act(async () => {
        fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
      });
      expect(chamadas).toHaveLength(0);
      expect(screen.getByTestId("duracao-recusada")).toHaveTextContent(
        "A duração de Consulta da Maria não foi alterada — este horário já passou.",
      );
    } finally {
      relogio.mockRestore();
    }
  });

  it("depois de gravar, uma versão MAIS NOVA na lista vence o nosso otimismo", async () => {
    const { rerender } = render(elemento([maria()]));
    puxarAte("15:00");
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirmar-duracao-botao"));
    });
    expect(rotuloDoCard()).toContain("14:00 às 15:00");
    // Gravamos (rev 4) e um colega gravou de novo (rev 5) antes da nossa releitura.
    rerender(elemento([{ ...maria("15:15"), revision: 5 }]));
    expect(rotuloDoCard()).toContain("14:00 às 15:15");
  });
});
