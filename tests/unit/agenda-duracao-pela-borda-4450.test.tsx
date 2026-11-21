/**
 * PUXAR A BORDA DO CARD MUDA O TEMPO DA CONSULTA (#4450, a segunda porta).
 *
 * A #4507 deu ao PATCH a duração e ao painel o campo; na GRADE, o card só
 * sabia mudar de lugar — quem atendeu 50 minutos num bloco de 30 seguia sem
 * jeito de puxar a borda, que é o gesto que a issue descreve ("como no
 * Google").
 *
 * Estes casos passam pelo componente montado, com eventos de ponteiro e de
 * teclado de verdade: a régua (15 em 15, alinhada ao relógio, com o fim
 * original sempre disponível), a recusa explicada (passado, ocupado) e quem
 * NÃO ganha a alça. O relógio é injetado, como nas irmãs.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GradeDaAgenda, type InteracaoDaGrade } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";

afterEach(cleanup);

// O jsdom não implementa a captura de ponteiro; o arraste do card a chama ao
// pegar (e o dedo na alça CAI nele, que é o que um dos casos prova).
beforeAll(() => {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
  }
});

const DIA = "2026-08-26";
const AGORA_CEDO = new Date(`${DIA}T08:00:00`);

const PESSOAS: Pessoa[] = [
  { id: "p1", nome: "Ana", trilha: 1 },
  { id: "p2", nome: "Bruno", trilha: 2 },
];

/** Altura de uma hora na grade e a primeira hora desenhada — a régua do ponteiro. */
const PX_POR_HORA = 48;
const PRIMEIRA_HORA = 7;

/** O Y (relativo ao topo do corpo do dia) de uma hora de parede. */
function y(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return ((h * 60 + m - PRIMEIRA_HORA * 60) / 60) * PX_POR_HORA;
}

function compromisso(sobre: Partial<Agendamento> & { id: string; de: string; ate: string }): Agendamento {
  const { de, ate, ...resto } = sobre;
  return {
    titulo: "Consulta",
    responsavelId: "p1",
    comeca: `${DIA}T${de}:00.000`,
    termina: `${DIA}T${ate}:00.000`,
    origem: "ui",
    situacao: "confirmed",
    revision: 3,
    ...resto,
  };
}

function interacao(sobre: Partial<InteracaoDaGrade> = {}): InteracaoDaGrade {
  return {
    horariosPorDia: { [DIA]: [] },
    motivo: null,
    duracaoMin: 30,
    onMarcarEm: vi.fn(),
    onArrastarPara: vi.fn(),
    onMudarDuracao: vi.fn(),
    ...sobre,
  };
}

function montar(o: {
  agendamentos: Agendamento[];
  interacao?: InteracaoDaGrade;
  agora?: Date;
  onAbrir?: (id: string) => void;
  fuso?: string;
  dia?: string;
}) {
  render(
    <GradeDaAgenda
      visao="dia"
      ancora={new Date(`${o.dia ?? DIA}T12:00:00`)}
      agora={o.agora ?? AGORA_CEDO}
      fuso={o.fuso ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
      pessoas={PESSOAS}
      agendamentos={o.agendamentos}
      interacao={o.interacao}
      onAbrirAgendamento={o.onAbrir}
    />,
  );
}

/** Pega a alça de `id` com o mouse na hora `de` e leva até `ate`, sem soltar. */
function puxar(id: string, de: string, ate: string, pointerType = "mouse") {
  const alca = screen.getByTestId(`alca-duracao-${id}`);
  fireEvent.pointerDown(alca, { button: 0, pointerId: 1, pointerType, clientX: 10, clientY: y(de) });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType, clientX: 10, clientY: y(ate) });
}

function soltar(em: string) {
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: y(em) });
}

describe("puxar a borda de baixo (mouse)", () => {
  it("leva o fim para 15:00 e mostra o novo intervalo antes de soltar", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });

    puxar("a1", "14:30", "15:00");
    const previa = screen.getByTestId("fantasma-da-duracao");
    expect(previa).toHaveAttribute("data-valido", "true");
    expect(previa).toHaveTextContent("14:00–15:00 · 60 min");

    soltar("15:00");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 60, razao: "" }));
    expect(screen.queryByTestId("fantasma-da-duracao")).toBeNull();
  });

  it("encaixa de 15 em 15 minutos: 14:50 vira 14:45", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });

    puxar("a1", "14:30", "14:50");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("14:00–14:45 · 45 min");
    soltar("14:50");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 45, razao: "" }));
  });

  it("encaixa no RELÓGIO, não na soma: 09:20–09:52 puxado para baixo para em 10:00", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "09:20", ate: "09:52" })] });

    puxar("a1", "09:52", "10:02");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("09:20–10:00 · 40 min");
    soltar("10:02");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 40, razao: "" }));
  });

  it("o fim ORIGINAL é sempre um ponto de parada: voltar a ele e soltar não muda nada", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "09:20", ate: "09:52" })] });

    puxar("a1", "09:52", "10:30");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y("09:53") });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("09:20–09:52 · 32 min");
    soltar("09:53");
    expect(inter.onMudarDuracao).not.toHaveBeenCalled();
  });

  it("o mais curto é o primeiro quarto de hora depois de início + 15 (09:20 → 09:45)", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "09:20", ate: "10:30" })] });

    puxar("a1", "10:30", "09:00");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("09:20–09:45 · 25 min");
    soltar("09:00");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 25, razao: "" }));
  });

  it("não encurta o que passa do fim da grade: 21:30–22:20 volta a parar em 22:20", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "21:30", ate: "22:20" })] });

    puxar("a1", "22:20", "21:45");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("21:30–21:45 · 15 min");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y("22:20") });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("21:30–22:20 · 50 min");
    soltar("22:20");
    expect(inter.onMudarDuracao).not.toHaveBeenCalled();
  });

  it("pegar a alça pelo MEIO e voltar ao mesmo pixel não muda nada (o gesto conta o deslocamento)", () => {
    // A alça tem 8px e o card é desenhado 2px mais curto: o meio dela fica ~6px
    // acima do fim. Ler a posição ABSOLUTA do ponteiro dava 14:22 e encaixava em
    // 14:15 — uma confirmação de mudança que ninguém pediu.
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    const alca = screen.getByTestId("alca-duracao-a1");
    const meio = y("14:30") - 6;
    fireEvent.pointerDown(alca, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: meio });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y("14:00") });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: meio });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("14:00–14:30 · 30 min");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: meio });
    expect(inter.onMudarDuracao).not.toHaveBeenCalled();
  });

  it("um dedo encostando no meio do arraste do mouse não encerra nem move a prévia", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    puxar("a1", "14:30", "15:00");
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: "touch", clientX: 10, clientY: y("20:00") });
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: "touch", clientX: 10, clientY: y("20:00") });
    expect(inter.onMudarDuracao).not.toHaveBeenCalled();
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("14:00–15:00 · 60 min");
    soltar("15:00");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 60, razao: "" }));
  });

  it("na virada do horário de verão a duração é a do RELÓGIO, não a da parede", () => {
    // Nova York, 14/03/2027: às 02:00 o relógio pula para 03:00. Um compromisso
    // de 01:30 (06:30Z) a 08:30 (12:30Z) dura 6 horas. O fim em 08:45 de parede
    // é 12:45Z: 375 minutos — e não 435, que a diferença de parede daria.
    const inter = interacao({ horariosPorDia: {} });
    montar({
      interacao: inter,
      fuso: "America/New_York",
      dia: "2027-03-14",
      agora: new Date("2027-03-14T05:00:00Z"),
      agendamentos: [
        {
          id: "dst",
          titulo: "Plantão",
          responsavelId: "p1",
          comeca: "2027-03-14T06:30:00.000Z",
          termina: "2027-03-14T12:30:00.000Z",
          origem: "ui",
          situacao: "confirmed",
        },
      ],
    });
    const card = screen.getByTestId("agendamento-dst");
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("01:30–08:45 · 375 min");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "dst", duracaoMin: 375, razao: "" }));
  });

  it("rolar a grade com o botão apertado conta como deslocamento", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    const rolagem = screen.getByTestId("grade-da-agenda").querySelector<HTMLElement>(".overflow-auto")!;
    const alca = screen.getByTestId("alca-duracao-a1");
    fireEvent.pointerDown(alca, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: y("14:30") });
    rolagem.scrollTop = 48; // uma hora de grade
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y("14:30") + 4 });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("14:00–15:30 · 90 min");
  });

  it("um dedo no CARD durante o puxar da borda não começa um segundo gesto", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    puxar("a1", "14:30", "15:00");
    fireEvent.pointerDown(screen.getByTestId("agendamento-a1"), {
      button: 0,
      pointerId: 2,
      pointerType: "touch",
      clientX: 10,
      clientY: y("14:10"),
    });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("14:00–15:00 · 60 min");
    expect(screen.queryByTestId("fantasma-do-arraste")).toBeNull();
    soltar("15:00");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 60 }));
  });

  it("no outono (hora repetida) a borda nunca produz duração negativa", () => {
    // Nova York, 07/11/2027: 01:00–02:00 acontece duas vezes. O compromisso
    // começa na SEGUNDA 01:30 (06:30Z) e vai até 02:30 (07:30Z). Subindo a borda,
    // 01:45 de parede cairia na PRIMEIRA 01:45 (05:45Z), antes do início.
    const inter = interacao({ horariosPorDia: {} });
    montar({
      interacao: inter,
      fuso: "America/New_York",
      dia: "2027-11-07",
      agora: new Date("2027-11-07T04:00:00Z"),
      agendamentos: [
        {
          id: "outono",
          titulo: "Plantão",
          responsavelId: "p1",
          comeca: "2027-11-07T06:30:00.000Z",
          termina: "2027-11-07T07:30:00.000Z",
          origem: "ui",
          situacao: "confirmed",
        },
      ],
    });
    const card = screen.getByTestId("agendamento-outono");
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(card, { key: "ArrowUp", altKey: true, shiftKey: true });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "outono", duracaoMin: 30 }));
  });

  it("o clique que fecha o gesto não abre o compromisso", () => {
    const onAbrir = vi.fn();
    montar({
      interacao: interacao(),
      onAbrir,
      agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })],
    });
    puxar("a1", "14:30", "15:00");
    soltar("15:00");
    fireEvent.click(screen.getByTestId("alca-duracao-a1"));
    expect(onAbrir).not.toHaveBeenCalled();
  });
});

describe("o que a borda recusa — e diz por quê", () => {
  it("encostar no próximo compromisso do MESMO responsável fica vermelho e vai como null", () => {
    const inter = interacao();
    montar({
      interacao: inter,
      agendamentos: [
        compromisso({ id: "maria", de: "14:00", ate: "14:30" }),
        compromisso({ id: "joao", de: "14:30", ate: "15:00" }),
      ],
    });

    puxar("maria", "14:30", "14:45");
    const previa = screen.getByTestId("fantasma-da-duracao");
    expect(previa).toHaveAttribute("data-valido", "false");
    expect(previa).toHaveTextContent("já há um compromisso neste horário");
    soltar("14:45");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({
      id: "maria",
      duracaoMin: null,
      razao: "já há um compromisso neste horário",
    }));
  });

  it("a ocupação do Google do mesmo responsável também conta", () => {
    const inter = interacao();
    montar({
      interacao: inter,
      agendamentos: [
        compromisso({ id: "maria", de: "14:00", ate: "14:30" }),
        compromisso({ id: "g1", de: "14:30", ate: "15:00", origem: "google_sync", titulo: "Ocupado" }),
      ],
    });
    puxar("maria", "14:30", "14:45");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveAttribute("data-valido", "false");
  });

  it("confere a agenda da RESPONSÁVEL mesmo quando o filtro a esconde da grade", () => {
    // Bruno isolado no filtro: o card em que ele é convidado aparece, o da Ana
    // às 14:30 não. A prévia tem de ver a ocupação inteira, não a desenhada.
    const visivel = compromisso({ id: "maria", de: "14:00", ate: "14:30", convidadosDaEquipe: ["p2"] });
    const escondido = compromisso({ id: "joao", de: "14:30", ate: "15:00" });
    const inter = interacao({ ocupacao: [visivel, escondido] });
    montar({ interacao: inter, agendamentos: [visivel] });
    puxar("maria", "14:30", "15:00");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveAttribute("data-valido", "false");
  });

  it("'depois de agora' é o relógio da hora do gesto, não o do último render", () => {
    // A grade foi desenhada às 14:40; o gesto acontece 10 minutos depois, sem
    // novo render. 14:45 já passou.
    const agoraNoRender = new Date(`${DIA}T14:40:00`);
    const inicio = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(inicio);
    try {
      const inter = interacao();
      montar({ interacao: inter, agora: agoraNoRender, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
      relogio.mockReturnValue(inicio + 10 * 60_000);
      puxar("a1", "14:30", "14:45");
      expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("este horário já passou");
    } finally {
      relogio.mockRestore();
    }
  });

  it("compromisso de OUTRO responsável, ou que faltou, não bloqueia", () => {
    const inter = interacao();
    montar({
      interacao: inter,
      agendamentos: [
        compromisso({ id: "maria", de: "14:00", ate: "14:30" }),
        compromisso({ id: "doBruno", de: "14:30", ate: "15:00", responsavelId: "p2" }),
        compromisso({ id: "faltou", de: "14:30", ate: "15:00", situacao: "no_show" }),
      ],
    });
    puxar("maria", "14:30", "15:00");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveAttribute("data-valido", "true");
    soltar("15:00");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "maria", duracaoMin: 60, razao: "" }));
  });

  it("o novo fim tem de ficar depois de agora: 14:15 às 14:40 é recusado, 15:00 passa", () => {
    const inter = interacao();
    montar({
      interacao: inter,
      agora: new Date(`${DIA}T14:40:00`),
      agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })],
    });

    puxar("a1", "14:30", "14:15");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveAttribute("data-valido", "false");
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("este horário já passou");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y("15:00") });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveAttribute("data-valido", "true");
    soltar("15:00");
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 60, razao: "" }));
  });
});

describe("quem ganha a alça", () => {
  it("só o compromisso comum, ainda com futuro, e só quando há quem receba o gesto", () => {
    montar({
      interacao: interacao(),
      agora: new Date(`${DIA}T08:00:00`),
      agendamentos: [
        compromisso({ id: "comum", de: "09:00", ate: "09:30" }),
        compromisso({ id: "servico", de: "10:00", ate: "10:30", duracaoFixa: true }),
        compromisso({ id: "feito", de: "11:00", ate: "11:30", situacao: "completed" }),
        compromisso({ id: "faltou", de: "12:00", ate: "12:30", situacao: "no_show" }),
        compromisso({ id: "google", de: "13:00", ate: "13:30", origem: "google_sync" }),
      ],
    });
    expect(screen.getByTestId("alca-duracao-comum")).toBeInTheDocument();
    for (const id of ["servico", "feito", "faltou", "google"]) {
      expect(screen.queryByTestId(`alca-duracao-${id}`), id).toBeNull();
    }
  });

  it("o dia que já acabou não tem alça (nenhum fim possível fica depois de agora)", () => {
    montar({
      interacao: interacao(),
      agora: new Date("2026-08-27T09:00:00"),
      agendamentos: [compromisso({ id: "ontem", de: "10:00", ate: "10:30" })],
    });
    expect(screen.queryByTestId("alca-duracao-ontem")).toBeNull();
  });

  it("sem `onMudarDuracao` a grade não promete o gesto", () => {
    montar({
      interacao: interacao({ onMudarDuracao: undefined }),
      agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })],
    });
    expect(screen.queryByTestId("alca-duracao-a1")).toBeNull();
  });

  it("dedo na alça continua sendo o arraste de sempre — a borda é só para mouse e caneta", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    puxar("a1", "14:30", "15:00", "touch");
    expect(screen.queryByTestId("fantasma-da-duracao")).toBeNull();
    expect(screen.getByTestId("fantasma-do-arraste")).toBeInTheDocument();
    soltar("15:00");
    expect(inter.onMudarDuracao).not.toHaveBeenCalled();
  });
});

describe("o mesmo gesto pelo teclado", () => {
  it("Alt+Shift+↓ duas vezes leva o fim a 15:00, e Enter entrega pelo mesmo caminho", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    const card = screen.getByTestId("agendamento-a1");

    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true, shiftKey: true });
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("14:00–15:00 · 60 min");
    expect(screen.queryByTestId("fantasma-do-arraste")).toBeNull();

    fireEvent.keyDown(card, { key: "Enter" });
    expect(inter.onMudarDuracao).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", duracaoMin: 60, razao: "" }));
    expect(inter.onArrastarPara).not.toHaveBeenCalled();
  });

  it("Enter numa prévia do teclado que o relógio alcançou entrega a recusa", () => {
    const inicio = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(inicio);
    try {
      const inter = interacao();
      montar({ interacao: inter, agora: new Date(`${DIA}T14:40:00`), agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
      const card = screen.getByTestId("agendamento-a1");
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true, shiftKey: true });
      expect(screen.getByTestId("fantasma-da-duracao")).toHaveTextContent("14:00–14:45 · 45 min");
      relogio.mockReturnValue(inicio + 10 * 60_000);
      fireEvent.keyDown(card, { key: "Enter" });
      expect(inter.onMudarDuracao).toHaveBeenCalledWith(
        expect.objectContaining({ id: "a1", duracaoMin: null, razao: "este horário já passou" }),
      );
    } finally {
      relogio.mockRestore();
    }
  });

  it("o leitor de tela ouve a prévia: intervalo e minutos, ou o motivo", () => {
    montar({ interacao: interacao(), agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    fireEvent.keyDown(screen.getByTestId("agendamento-a1"), { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(screen.getByTestId("anuncio-da-duracao")).toHaveTextContent("14:00–14:45 · 45 min");
  });

  it("Esc desfaz sem entregar nada", () => {
    const inter = interacao();
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    const card = screen.getByTestId("agendamento-a1");
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true, shiftKey: true });
    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByTestId("fantasma-da-duracao")).toBeNull();
    expect(inter.onMudarDuracao).not.toHaveBeenCalled();
  });

  it("Alt+↓ sem Shift continua remarcando, não mexe na duração", () => {
    const inter = interacao({ horariosPorDia: { [DIA]: [{ instante: `${DIA}T15:00:00.000`, rotulo: "15:00" }] } });
    montar({ interacao: inter, agendamentos: [compromisso({ id: "a1", de: "14:00", ate: "14:30" })] });
    fireEvent.keyDown(screen.getByTestId("agendamento-a1"), { key: "ArrowDown", altKey: true });
    expect(screen.getByTestId("fantasma-do-arraste")).toBeInTheDocument();
    expect(screen.queryByTestId("fantasma-da-duracao")).toBeNull();
  });
});
