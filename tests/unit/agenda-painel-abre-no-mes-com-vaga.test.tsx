/**
 * O PAINEL NÃO ABRE NUM MÊS QUE ACABOU.
 *
 * ─── O defeito ───────────────────────────────────────────────────────────
 *
 * Em 30/09/2026, a partir de ~16h em São Paulo, o e2e de TODOS os PRs reprovou
 * nos mesmos 16 casos da agenda (runs 36766489220, 36766457318): "nenhum dia
 * disponível no painel". A rota respondia certo — slots a partir de 01/10 —, e
 * o painel abria em SETEMBRO, com todo dia apagado e "Nenhum horário livre em
 * setembro". Não era fuso: o `09:00` de 01/10 chegou como `12:00Z`, certo.
 *
 * É o que a pessoa vê também: no último dia útil do mês, depois do último
 * horário, "Novo agendamento" abre um calendário morto — e o próximo horário
 * livre, amanhã, fica atrás de uma seta que nada aponta. Todo mês.
 *
 * Duas regras, e um quadro:
 *
 * 1. Na ABERTURA, se o mês de hoje não tem mais nenhum horário publicado, o
 *    painel passa sozinho para o mês seguinte. Uma vez só: quem volta à mão
 *    para o mês de hoje (para um encaixe, por exemplo) fica lá.
 * 2. Os dias só acendem com os horários DO MÊS EM TELA. A janela de um mês vai
 *    até `endOfMonth + 1 dia` (`janelaDoMesVisivel`), então os dados de setembro
 *    trazem o dia 1º de outubro — e, no quadro entre trocar o mês e chegar a
 *    consulta nova, o 1º acendia sozinho. Era o quadro que as specs contornavam.
 *
 * O relógio é CONGELADO em fins de mês reais, e o "servidor" do teste usa a
 * mesma `janelaDoMesVisivel` da tela.
 *
 *     npx vitest run tests/unit/agenda-painel-abre-no-mes-com-vaga.test.tsx
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { startOfMonth } from "date-fns";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import type { HorarioLivre } from "@/components/agenda/tipos";
import { janelaDoMesVisivel } from "@/lib/agenda/janela-do-mes-visivel";
import { ancoraLocalDoDia } from "@/lib/agenda/semana-semente";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * A jornada do seed do e2e: seg–sex, 09:00–18:00 em São Paulo, de 30 em 30
 * minutos, 60 minutos de aviso mínimo. São Paulo é UTC-3 o ano todo (sem
 * horário de verão desde 2019), então a hora de parede vira instante somando 3.
 */
function horariosDoSeed(agora: Date, de: Date, ate: Date): Record<string, HorarioLivre[]> {
  const mapa: Record<string, HorarioLivre[]> = {};
  const aviso = agora.getTime() + 60 * 60_000;
  const primeiroDia = new Date(Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), de.getUTCDate() - 1));
  for (let t = primeiroDia.getTime(); t < ate.getTime() + 86_400_000; t += 86_400_000) {
    const dia = new Date(t);
    const semana = dia.getUTCDay();
    if (semana === 0 || semana === 6) continue;
    const chave = dia.toISOString().slice(0, 10);
    for (let min = 9 * 60; min < 18 * 60; min += 30) {
      const inicio = new Date(
        Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate(), 3 + Math.floor(min / 60), min % 60),
      );
      if (inicio.getTime() < aviso || inicio < de || inicio >= ate) continue;
      const rotulo = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
      (mapa[chave] ??= []).push({ instante: inicio.toISOString(), rotulo });
    }
  }
  return mapa;
}

/**
 * A agenda como `app/app/agenda/_client.tsx` a monta: o mês da consulta mora
 * FORA do painel e só muda pelo `onMesVisivel`; a consulta pede a janela desse
 * mês. Aqui a "consulta" responde na hora — o que se mede é a decisão do painel.
 */
function Agenda({ hoje, publicou = true }: { hoje: string; publicou?: boolean }) {
  const ancora = ancoraLocalDoDia(hoje);
  const [mesDoPainel, setMesDoPainel] = React.useState(() => startOfMonth(ancora));
  const onMesVisivel = React.useCallback((mes: Date) => {
    const proximo = startOfMonth(mes);
    setMesDoPainel((atual) => (atual.getTime() === proximo.getTime() ? atual : proximo));
  }, []);
  const agora = new Date();
  const { de, ate } = janelaDoMesVisivel(mesDoPainel, agora);
  return (
    <PainelDeMarcacao
      ancora={ancora}
      agora={agora}
      responsavel={{ id: "p1", nome: "Ana", trilha: 1 }}
      fuso="America/Sao_Paulo"
      horariosPorDia={publicou ? horariosDoSeed(agora, de, ate) : {}}
      publicouHorarios={publicou}
      mesCarregado={mesDoPainel}
      onMesVisivel={onMesVisivel}
      permiteEncaixe
      onConfirmar={vi.fn(async () => undefined)}
    />
  );
}

function congelar(instante: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instante));
}

const acesos = () =>
  Array.from(document.querySelectorAll('[data-testid^="dia-"][data-disponivel="true"]')).map((el) =>
    el.getAttribute("data-testid")!.slice(4),
  );

describe("no fim do mês, depois do último horário, o painel abre no mês seguinte", () => {
  // [instante congelado, dia na organização, primeiro dia com vaga]
  const casos: Array<[string, string, string]> = [
    // O dia do incidente: quarta 30/09, 17h em São Paulo.
    ["2026-09-30T20:00:00Z", "2026-09-30", "2026-10-01"],
    // Sábado 31/10: o mês termina num fim de semana.
    ["2026-10-31T15:00:00Z", "2026-10-31", "2026-11-02"],
    // Virada de ANO: quinta 31/12, 17h.
    ["2026-12-31T20:00:00Z", "2026-12-31", "2027-01-01"],
    // Fevereiro curto: sexta 26/02/2027, 18h — e o mês acaba no domingo 28.
    ["2027-02-26T21:00:00Z", "2027-02-26", "2027-03-01"],
  ];

  it.each(casos)("relógio em %s → abre com %s esgotado e acende %s", (instante, hoje, primeiro) => {
    congelar(instante);
    render(<Agenda hoje={hoje} />);

    expect(
      acesos(),
      "o painel abriu num mês sem vaga — o próximo horário ficou escondido atrás da seta",
    ).toContain(primeiro);
    expect(acesos().every((k) => k.slice(0, 7) === primeiro.slice(0, 7))).toBe(true);
    expect(screen.queryByTestId("motivo-do-bloqueio")).toBeNull();
  });

  it("quem volta à mão para o mês de hoje fica nele (sem ricochete)", () => {
    congelar("2026-09-30T20:00:00Z");
    render(<Agenda hoje="2026-09-30" />);
    expect(acesos()).toContain("2026-10-01");

    act(() => {
      fireEvent.click(screen.getByTestId("mes-anterior"));
    });

    // Setembro, sem vaga — e o encaixe de hoje ao alcance, que é o motivo de voltar.
    expect(screen.getByTestId("dia-2026-09-30")).toBeEnabled();
    expect(acesos()).toEqual([]);
    expect(screen.getByTestId("dia-2026-09-30")).toHaveAttribute("data-encaixe", "true");
  });
});

describe("o que NÃO muda", () => {
  it("de manhã no último dia o mês ainda tem vaga: abre nele", () => {
    congelar("2026-09-30T12:00:00Z");
    render(<Agenda hoje="2026-09-30" />);

    expect(acesos()).toContain("2026-09-30");
    expect(acesos().every((k) => k.startsWith("2026-09"))).toBe(true);
  });

  it("quem nunca publicou jornada não é empurrado de mês: o aviso é o próximo passo", () => {
    congelar("2026-09-30T20:00:00Z");
    render(<Agenda hoje="2026-09-30" publicou={false} />);

    expect(screen.getByTestId("sem-jornada-publicada")).toBeInTheDocument();
    expect(screen.getByTestId("dia-2026-09-30")).toBeInTheDocument();
    expect(screen.queryByTestId("dia-2026-10-31")).toBeNull();
  });

  it("sem saber de que mês são os dados (a consulta não chegou), o painel não decide nada", () => {
    congelar("2026-09-30T20:00:00Z");
    render(
      <PainelDeMarcacao
        ancora={ancoraLocalDoDia("2026-09-30")}
        agora={new Date()}
        responsavel={{ id: "p1", nome: "Ana", trilha: 1 }}
        fuso="America/Sao_Paulo"
        horariosPorDia={{}}
        mesCarregado={null}
        onConfirmar={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.queryByTestId("dia-2026-10-31")).toBeNull();
  });
});

describe("os dias acendem só com os horários do mês em tela", () => {
  it("trocar de mês não acende o dia 1º com a sobra da janela do mês velho", () => {
    congelar("2026-09-29T12:00:00Z");
    const agora = new Date();
    const { de, ate } = janelaDoMesVisivel(startOfMonth(ancoraLocalDoDia("2026-09-29")), agora);
    const setembro = horariosDoSeed(agora, de, ate);
    // A janela de setembro vai até o fim de 01/10 — a sobra existe de verdade.
    expect(setembro["2026-10-01"]?.length).toBeGreaterThan(0);

    render(
      <PainelDeMarcacao
        ancora={ancoraLocalDoDia("2026-09-29")}
        agora={agora}
        responsavel={{ id: "p1", nome: "Ana", trilha: 1 }}
        fuso="America/Sao_Paulo"
        horariosPorDia={setembro}
        mesCarregado={startOfMonth(ancoraLocalDoDia("2026-09-29"))}
        onConfirmar={vi.fn(async () => undefined)}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("mes-seguinte"));
    });

    // Outubro em tela, dados ainda de setembro: nada acende até chegar outubro.
    expect(acesos()).toEqual([]);
  });
});
