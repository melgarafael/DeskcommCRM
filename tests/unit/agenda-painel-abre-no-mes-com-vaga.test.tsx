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
function Agenda({ hoje, publicou = true, erro = false }: { hoje: string; publicou?: boolean; erro?: boolean }) {
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
      erroAoCarregar={erro}
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

/**
 * TROCAR DE TIPO REFAZ A ABERTURA.
 *
 * 30/10/2026, sexta, a partir de ~16h em São Paulo: o mesmo "nenhum dia
 * disponível" do incidente de setembro, em 9 specs da e2e-parte (2) de todos os
 * PRs (run 41113234129) — com a guarda acima verde. A tela abre no PRIMEIRO
 * tipo ("Atendimento", sem jornada) e só depois a pessoa escolhe o seu. O
 * painel continua montado na troca (ver o efeito da duração), e a decisão de
 * abertura, tomada UMA vez, já tinha sido gasta com a resposta do primeiro
 * tipo: "sem jornada, não procura no mês seguinte". A resposta do tipo
 * escolhido — jornada publicada, outubro esgotado — chegava e não decidia mais
 * nada. A rota respondia certo; o painel ficava num mês morto.
 */
describe("trocar de tipo refaz a decisão de abertura", () => {
  function AgendaComTroca({ hoje }: { hoje: string }) {
    const [tipo, setTipo] = React.useState("Atendimento");
    const ancora = ancoraLocalDoDia(hoje);
    const [mesDoPainel, setMesDoPainel] = React.useState(() => startOfMonth(ancora));
    const onMesVisivel = React.useCallback((mes: Date) => {
      const proximo = startOfMonth(mes);
      setMesDoPainel((atual) => (atual.getTime() === proximo.getTime() ? atual : proximo));
    }, []);
    const agora = new Date();
    const { de, ate } = janelaDoMesVisivel(mesDoPainel, agora);
    // Só o tipo do seed tem jornada — como na organização do e2e.
    const publicou = tipo === "Consulta E2E";
    return (
      <>
        <button data-testid="escolher-tipo-do-seed" onClick={() => setTipo("Consulta E2E")} />
        <PainelDeMarcacao
          ancora={ancora}
          agora={agora}
          tipo={tipo}
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

  const casos: Array<[string, string, string]> = [
    // O dia do incidente: sexta 30/10, 16h45 em São Paulo — o 17:30 já não
    // cabe nos 60 minutos de aviso, e amanhã é sábado. (Às 16h30 o 17:30 ainda
    // cabe e outubro tem vaga: é o "de manhã" deste caso, e está certo.)
    ["2026-10-30T19:45:00Z", "2026-10-30", "2026-11-02"],
    // Sábado 31/10: o mês já acabou de manhã.
    ["2026-10-31T12:00:00Z", "2026-10-31", "2026-11-02"],
  ];

  it.each(casos)("relógio em %s (dia %s) → do tipo sem jornada ao do seed, acende %s", (instante, hoje, primeiro) => {
    congelar(instante);
    render(<AgendaComTroca hoje={hoje} />);
    expect(screen.getByTestId("sem-jornada-publicada")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("escolher-tipo-do-seed"));
    });

    expect(
      acesos(),
      "a troca de tipo não refez a abertura — o painel ficou no mês esgotado",
    ).toContain(primeiro);
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

/**
 * O MÊS ACABA COM A TELA ABERTA (#3774).
 *
 * ─── O defeito ───────────────────────────────────────────────────────────
 *
 * Na sexta 30/10/2026, às 16:28 em São Paulo, o painel ainda enxergava 17:00 e
 * 17:30 em outubro e por isso ficou nele. Vinte minutos depois os dois caíram
 * dentro do aviso mínimo de 60 min, outubro ficou sem um único dia clicável — e
 * a decisão de abertura, tomada uma vez, não era revista: a tela ficou 20 s
 * parada em "outubro de 2026" no trace do e2e (job 124255171221), com o mês
 * seguinte atrás de uma seta e nenhum dia para clicar.
 *
 * A pergunta da abertura era "existe vaga NESTE mês?", feita sobre os dados já
 * carregados. Enquanto sobrava um horário publicado — mesmo já vencido — a
 * resposta era "sim", e nada mais era perguntado.
 *
 * ─── Por que este harness é diferente do de cima ─────────────────────────
 *
 * A consulta de verdade é um RETRATO do instante da abertura: `agoraDaAbertura`
 * em `app/app/agenda/_client.tsx:356` só é recalculado quando o painel reabre ou
 * o tipo muda, e é ele que entra na chave do React Query. O relógio que o
 * painel recebe, esse é de AGORA (`agora={new Date()}`, linha 925). É a
 * diferença entre os dois que produz o defeito — e é o que `Agenda` (acima) não
 * modela, porque lá o "servidor" recalcula a resposta a cada render.
 */
function AgendaComConsultaCongelada({ hoje }: { hoje: string }) {
  const ancora = ancoraLocalDoDia(hoje);
  const [mesDoPainel, setMesDoPainel] = React.useState(() => startOfMonth(ancora));
  // Como no `_client`: o relógio da CONSULTA congela na abertura do painel.
  const agoraDaConsulta = React.useMemo(() => new Date(), []);
  // O cliente redesenha por qualquer motivo (refetch, clique, estado): o que se
  // mede é o que o painel faz no render seguinte, com o mesmo retrato.
  const [redesenhou, redesenhar] = React.useReducer((n: number) => n + 1, 0);
  const onMesVisivel = React.useCallback((mes: Date) => {
    const proximo = startOfMonth(mes);
    setMesDoPainel((atual) => (atual.getTime() === proximo.getTime() ? atual : proximo));
  }, []);
  const horariosPorDia = React.useMemo(() => {
    const { de, ate } = janelaDoMesVisivel(mesDoPainel, agoraDaConsulta);
    return horariosDoSeed(agoraDaConsulta, de, ate);
  }, [mesDoPainel, agoraDaConsulta]);
  return (
    <>
      <button data-testid="o-cliente-redesenha" onClick={redesenhar}>
        {redesenhou}
      </button>
      <PainelDeMarcacao
        ancora={ancora}
        agora={new Date()}
        responsavel={{ id: "p1", nome: "Ana", trilha: 1 }}
        fuso="America/Sao_Paulo"
        horariosPorDia={horariosPorDia}
        publicouHorarios
        mesCarregado={mesDoPainel}
        onMesVisivel={onMesVisivel}
        permiteEncaixe
        onConfirmar={vi.fn(async () => undefined)}
      />
    </>
  );
}

describe("o mês esgota com a tela aberta e a abertura se revê", () => {
  it("sexta 30/10: consulta das 16:28, relógio às 20:00 — outubro acabou e o painel abre em novembro", () => {
    congelar("2026-10-30T19:28:00Z"); // 16:28 BRT
    render(<AgendaComConsultaCongelada hoje="2026-10-30" />);

    // 16:28: o 17:30 de hoje ainda dava — outubro tem vaga, e a tela fica nele.
    expect(acesos()).toEqual(["2026-10-30"]);

    act(() => {
      vi.setSystemTime(new Date("2026-10-30T23:00:00Z")); // 20:00 BRT
    });
    act(() => {
      fireEvent.click(screen.getByTestId("o-cliente-redesenha"));
    });

    expect(
      acesos(),
      "o painel ficou em outubro com um horário que já passou — o mês acabou e a decisão não foi revista",
    ).not.toContain("2026-10-30");
    expect(acesos()).toContain("2026-11-02");
    expect(acesos().every((k) => k.startsWith("2026-11"))).toBe(true);
    expect(screen.queryByTestId("motivo-do-bloqueio")).toBeNull();
  });

  it("de manhã o mês de hoje ainda tem vaga: o painel abre nele e não salta", () => {
    congelar("2026-10-30T12:00:00Z"); // 09:00 BRT
    render(<AgendaComConsultaCongelada hoje="2026-10-30" />);

    expect(acesos()).toContain("2026-10-30");
    expect(acesos().every((k) => k.startsWith("2026-10"))).toBe(true);
  });

  it("quem foi para o mês seguinte à mão continua nele quando o mês de hoje esgota", () => {
    congelar("2026-10-30T19:28:00Z");
    render(<AgendaComConsultaCongelada hoje="2026-10-30" />);
    act(() => {
      fireEvent.click(screen.getByTestId("mes-seguinte"));
    });
    expect(acesos().every((k) => k.startsWith("2026-11"))).toBe(true);

    act(() => {
      vi.setSystemTime(new Date("2026-10-30T23:00:00Z"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("o-cliente-redesenha"));
    });

    // Novembro segue em tela, com vaga, e ninguém trouxe a pessoa de volta.
    expect(acesos()).toContain("2026-11-02");
    expect(acesos().every((k) => k.startsWith("2026-11"))).toBe(true);
  });
});

/**
 * SÓ A RESPOSTA QUE DECIDE GASTA A DECISÃO (#3777, @paulolimajr77).
 *
 * A troca de tipo (acima) reabre a decisão por CHAVE de tipo. Mas no MESMO tipo
 * a consulta também é refeita — a duração entra na chave dela, e uma falha pode
 * passar —, e a primeira resposta pode não decidir nada: sem jornada, ou com
 * erro. Se ela gastasse a decisão, a resposta seguinte, com jornada e o mês
 * esgotado, deixaria o painel num mês morto.
 */
describe("só a resposta que decide gasta a decisão de abertura", () => {
  it("no mesmo tipo, sem jornada e depois com jornada, no último dia útil à tarde, vai ao mês seguinte", () => {
    // Sexta 30/10/2026, 17h em São Paulo: outubro não tem mais horário.
    congelar("2026-10-30T20:00:00Z");
    const { rerender } = render(<Agenda hoje="2026-10-30" publicou={false} />);
    expect(screen.getByTestId("sem-jornada-publicada")).toBeInTheDocument();

    // A consulta do mesmo tipo é refeita e agora responde com jornada.
    rerender(<Agenda hoje="2026-10-30" publicou />);

    expect(
      acesos(),
      "o painel ficou em outubro: a resposta sem jornada gastou a decisão de abertura",
    ).toContain("2026-11-02");
    expect(screen.queryByTestId("motivo-do-bloqueio")).toBeNull();
  });

  it("com a decisão pendente (erro), quem vai e volta à mão pelas setas fica onde voltou", () => {
    congelar("2026-10-30T20:00:00Z");
    const { rerender } = render(<Agenda hoje="2026-10-30" erro />);

    act(() => {
      fireEvent.click(screen.getByTestId("mes-seguinte"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("mes-anterior"));
    });

    // A consulta volta a responder, com outubro esgotado: a volta à mão vale.
    rerender(<Agenda hoje="2026-10-30" />);

    expect(acesos(), "a resposta atrasada ricocheteou a pessoa para novembro").toEqual([]);
    expect(screen.getByTestId("dia-2026-10-30")).toHaveAttribute("data-encaixe", "true");
  });
});
