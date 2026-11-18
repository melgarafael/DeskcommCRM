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

function Troca({ hoje, temJornada, nomes }: { hoje: string; temJornada: [boolean, boolean]; nomes: [string, string] }) {
  const [i, setI] = React.useState(0);
  const ancora = ancoraLocalDoDia(hoje);
  const [mesDoPainel, setMesDoPainel] = React.useState(() => startOfMonth(ancora));
  const onMesVisivel = React.useCallback((mes: Date) => {
    const proximo = startOfMonth(mes);
    setMesDoPainel((atual) => (atual.getTime() === proximo.getTime() ? atual : proximo));
  }, []);
  const agora = new Date();
  const { de, ate } = janelaDoMesVisivel(mesDoPainel, agora);
  const publicou = temJornada[i];
  return (
    <>
      <button data-testid="trocar" onClick={() => setI(1)} />
      <PainelDeMarcacao
        ancora={ancora}
        agora={agora}
        tipo={nomes[i]}
        tipoId={`tipo-${i}`}
        responsavel={{ id: "p1", nome: "Ana", trilha: 1 }}
        fuso="America/Sao_Paulo"
        horariosPorDia={publicou ? horariosDoSeed(agora, de, ate) : {}}
        publicouHorarios={publicou}
        mesCarregado={mesDoPainel}
        onMesVisivel={onMesVisivel}
        permiteEncaixe
        onConfirmar={vi.fn(async () => undefined)}
      />
    </>
  );
}

describe("trocar de tipo no fim do mês (revisão do conserto de 30/10/2026)", () => {
  it("A1: dois tipos com o MESMO nome (sem jornada -> com jornada) acende novembro", () => {
    congelar("2026-10-30T19:45:00Z");
    render(<Troca hoje="2026-10-30" temJornada={[false, true]} nomes={["Consulta", "Consulta"]} />);
    act(() => { fireEvent.click(screen.getByTestId("trocar")); });
    expect(acesos()).toContain("2026-11-02");
  });

  it("A2: troca de tipo em novembro, volta à mão para outubro: fica em outubro (sem ricochete)", () => {
    congelar("2026-10-30T19:45:00Z");
    render(<Troca hoje="2026-10-30" temJornada={[true, true]} nomes={["A", "B"]} />);
    expect(acesos()).toContain("2026-11-02");
    act(() => { fireEvent.click(screen.getByTestId("trocar")); });
    act(() => { fireEvent.click(screen.getByTestId("mes-anterior")); });
    expect(screen.getByTestId("dia-2026-10-30")).toHaveAttribute("data-encaixe", "true");
    expect(acesos()).toEqual([]);
  });

  it("A3 controle: só um tipo, volta à mão, fica", () => {
    congelar("2026-10-30T19:45:00Z");
    render(<Troca hoje="2026-10-30" temJornada={[true, true]} nomes={["A", "B"]} />);
    act(() => { fireEvent.click(screen.getByTestId("mes-anterior")); });
    expect(screen.getByTestId("dia-2026-10-30")).toHaveAttribute("data-encaixe", "true");
  });

  for (const [inst, hoje, prim] of [
    ["2026-11-30T21:00:00Z", "2026-11-30", "2026-12-01"],
    ["2026-12-31T20:00:00Z", "2026-12-31", "2027-01-01"],
    ["2026-11-01T12:00:00Z", "2026-11-01", "2026-11-02"],
    ["2027-03-31T21:00:00Z", "2027-03-31", "2027-04-01"],
  ] as const) {
    it(`A4 troca sem jornada -> com jornada em ${inst}`, () => {
      congelar(inst);
      render(<Troca hoje={hoje} temJornada={[false, true]} nomes={["X", "Y"]} />);
      act(() => { fireEvent.click(screen.getByTestId("trocar")); });
      expect(acesos()).toContain(prim);
    });
  }
});
