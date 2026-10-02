/**
 * A GRADE ACEITA — e o que ela recusa, ela EXPLICA.
 *
 * ─── O defeito que estas cercas fecham ───────────────────────────────────
 *
 * A grade era desenho: sete colunas, faixas de hora, cards. Clicar num espaço
 * vazio não fazia nada — e "não fazer nada" numa área que parece uma agenda é o
 * controle decorativo pelo avesso: quem clica conclui que o produto está
 * quebrado e não tem o que reportar além de "não abre".
 *
 * Consertar isso tem um jeito errado que é mais rápido: calcular o horário a
 * partir do pixel clicado e mandar para o POST. A tela passaria a oferecer
 * horário que a disponibilidade publicada não tem, o servidor devolveria 422
 * `agenda_disponibilidade_invalida`, e a agenda discordaria do agente sobre o
 * que está livre. Por isso o primeiro caso aqui não é "clicou, abriu": é
 * **clicou e o instante que saiu foi o PUBLICADO**, não o do bloco.
 *
 * ─── Por que pelo componente ─────────────────────────────────────────────
 *
 * `lib/agenda/grade-interativa.ts` já tem os seus casos, e eles provam a conta.
 * O que só a montagem prova é a LIGAÇÃO: que o bloco desabilitado é o mesmo que
 * a conta apagou, que a razão exibida é a que a conta derivou, e que o caminho
 * por teclado alimenta a MESMA proposta que o arraste alimentaria. Foi
 * exatamente uma ligação faltando — quatro props nunca passadas — que deixou os
 * botões de `HistoricoDaAgenda` cinzas em toda organização por semanas.
 *
 * O relógio é injetado: `AGORA` é constante e todo instante deriva dele. Esta
 * base já pagou o preço de invariante que passa de manhã e reprova de
 * madrugada.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GradeDaAgenda, type InteracaoDaGrade } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";

afterEach(cleanup);

/** Quarta-feira, 08:00 da manhã — antes das faixas usadas nos casos. */
const AGORA = new Date("2026-08-26T08:00:00");
const DIA = "2026-08-26";

const PESSOAS: Pessoa[] = [{ id: "p1", nome: "Ana", trilha: 1 }];

function publicado(hhmm: string) {
  return { instante: `${DIA}T${hhmm}:00.000`, rotulo: hhmm };
}

function interacao(sobre: Partial<InteracaoDaGrade> = {}): InteracaoDaGrade {
  return {
    horariosPorDia: { [DIA]: [publicado("09:20"), publicado("14:00")] },
    motivo: null,
    duracaoMin: 30,
    onMarcarEm: vi.fn(),
    ...sobre,
  };
}

function montar(sobre: { interacao?: InteracaoDaGrade; agendamentos?: Agendamento[] } = {}) {
  render(
    <GradeDaAgenda
      visao="dia"
      ancora={new Date(`${DIA}T12:00:00`)}
      agora={AGORA}
      fuso={Intl.DateTimeFormat().resolvedOptions().timeZone}
      pessoas={PESSOAS}
      agendamentos={sobre.agendamentos ?? []}
      interacao={sobre.interacao}
    />,
  );
}

describe("clicar num bloco vazio", () => {
  it("marca no horário PUBLICADO, e não no minuto do bloco", () => {
    // O bloco das 09:00 desenha meia hora; o horário publicado dentro dele
    // começa 09:20. Mandar "09:00" seria a tela inventando um instante que a
    // regra não deu — e é o 422 que o painel de marcação já pagou.
    const inter = interacao();
    montar({ interacao: inter });

    fireEvent.click(screen.getByTestId(`bloco-${DIA}-09:00`));

    expect(inter.onMarcarEm).toHaveBeenCalledTimes(1);
    expect(inter.onMarcarEm).toHaveBeenCalledWith(`${DIA}T09:20:00.000`);
  });

  it("o bloco livre anuncia o horário que vai marcar", () => {
    montar({ interacao: interacao() });
    expect(screen.getByTestId(`bloco-${DIA}-09:00`)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Marcar às 09:20"),
    );
  });

  it("bloco sem horário publicado NÃO é clicável", () => {
    const inter = interacao();
    montar({ interacao: inter });

    const morto = screen.getByTestId(`bloco-${DIA}-11:00`);
    expect(morto).toBeDisabled();
    fireEvent.click(morto);
    expect(inter.onMarcarEm).not.toHaveBeenCalled();
  });

  it("sem `interacao`, a grade segue só de leitura — nenhum bloco nasce", () => {
    // A vitrine monta esta mesma grade sem rota nenhuma por trás. Uma grade que
    // exigisse disponibilidade para renderizar deixaria de ser julgável lá.
    montar({});
    expect(screen.queryByTestId(`bloco-${DIA}-09:00`)).toBeNull();
  });
});

describe("compromisso cancelado não tranca o horário que ele liberou", () => {
  const cancelado: Agendamento = {
    id: "c1",
    titulo: "Consulta",
    responsavelId: "p1",
    comeca: `${DIA}T14:00:00`,
    termina: `${DIA}T14:30:00`,
    origem: "ui",
    situacao: "cancelled",
  };

  it("o card cancelado não recebe o ponteiro — o bloco embaixo dele recebe", () => {
    // ⚠️ ACHADO PELA SPEC EM TELA, com `locator.click` esperando 150 segundos: o
    // card é `absolute` e cobre a camada de blocos vazios, então o clique no
    // horário livre morria nele. E o horário ESTÁ livre — cancelar devolve a
    // vaga (`cancelled` está em `SITUACOES_QUE_LIBERAM`) e a rota volta a
    // oferecê-la. Numa clínica com uma semana de cancelamentos, todo horário
    // reaberto ficaria inalcançável pela grade.
    montar({
      interacao: interacao({ horariosPorDia: { [DIA]: [publicado("14:00")] } }),
      agendamentos: [cancelado],
    });
    expect(screen.getByTestId("agendamento-c1").className).toContain("pointer-events-none");
  });

  it("mas ele continua VISÍVEL — é a memória de que houve algo ali", () => {
    montar({
      interacao: interacao({ horariosPorDia: { [DIA]: [publicado("14:00")] } }),
      agendamentos: [cancelado],
    });
    expect(screen.getByTestId("agendamento-c1")).toBeInTheDocument();
  });

  // ⚠️ ESCOPO DECLARADO: este caso NÃO prova a sobreposição — jsdom não faz hit
  // testing, e `fireEvent.click` no bloco chegaria nele mesmo com o card por
  // cima. Quem prova a sobreposição é a spec em tela (`agenda-grade-interativa`),
  // com ponteiro de verdade. O que este caso guarda é que o bloco continua
  // OFERECENDO a vaga de um horário cancelado, que é a outra metade do defeito.
  it("e o bloco daquele horário segue oferecendo a vaga", () => {
    const inter = interacao({ horariosPorDia: { [DIA]: [publicado("14:00")] } });
    montar({ interacao: inter, agendamentos: [cancelado] });

    fireEvent.click(screen.getByTestId(`bloco-${DIA}-14:00`));
    expect(inter.onMarcarEm).toHaveBeenCalledWith(`${DIA}T14:00:00.000`);
  });
});

describe("o bloco recusado DIZ por quê — a razão sai da mesma conta que o apaga", () => {
  it("sem jornada publicada, a frase manda configurar em vez de constatar", () => {
    montar({ interacao: interacao({ horariosPorDia: {}, motivo: "sem-jornada" }) });
    expect(screen.getByTestId(`bloco-${DIA}-09:00`)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("você ainda não publicou seus horários"),
    );
  });

  it("consulta quebrada não vira 'sem vaga'", () => {
    // Os dois chegam como a mesma lista vazia. Dizer "não há vaga" quando a
    // rota falhou manda a pessoa procurar horário onde a resposta nem chegou.
    montar({ interacao: interacao({ horariosPorDia: {}, motivo: "erro" }) });
    expect(screen.getByTestId(`bloco-${DIA}-09:00`)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("não consegui carregar os horários"),
    );
  });

  it("horário tomado por um compromisso diz isso, e não 'fora dos horários'", () => {
    const compromisso: Agendamento = {
      id: "a1",
      titulo: "Consulta",
      responsavelId: "p1",
      comeca: `${DIA}T11:00:00`,
      termina: `${DIA}T11:30:00`,
      origem: "ui",
      situacao: "confirmed",
    };
    montar({ interacao: interacao(), agendamentos: [compromisso] });
    expect(screen.getByTestId(`bloco-${DIA}-11:00`)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("já há um compromisso neste horário"),
    );
  });

  it("horário que já passou diz isso — antes de qualquer outra razão", () => {
    // `AGORA` é 08:00; o bloco das 07:00 já foi. Dizer "fora dos horários" para
    // o passado manda configurar uma jornada que não resolveria nada.
    montar({ interacao: interacao() });
    expect(screen.getByTestId(`bloco-${DIA}-07:00`)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("já passou"),
    );
  });
});

describe("a geometria é a régua da grade, e o teste mede contra ela", () => {
  it("o bloco das 09:00 começa a duas horas do topo e ocupa meia hora", () => {
    // 48px por hora, janela a partir das 07:00: 09:00 está a (9-7)*48 = 96px, e
    // meia hora são 24px. Se a régua mudar, este caso é quem avisa — a olho,
    // 96px e 104px são indistinguíveis.
    montar({ interacao: interacao() });
    const bloco = screen.getByTestId(`bloco-${DIA}-09:00`);
    expect(bloco.style.top).toBe("96px");
    expect(bloco.style.height).toBe("24px");
  });
});

describe("remarcar pelo TECLADO — o mesmo mecanismo do arraste", () => {
  const compromisso: Agendamento = {
    id: "a1",
    titulo: "Consulta",
    responsavelId: "p1",
    comeca: `${DIA}T14:00:00`,
    termina: `${DIA}T14:30:00`,
    origem: "ui",
    situacao: "confirmed",
  };

  it("Alt+seta salta para a próxima VAGA, não meia hora adiante", () => {
    // ⚠️ Este caso nasceu vermelho por um defeito de verdade: a seta somava meia
    // hora à proposta corrente e reencaixava, e a proposta corrente já está
    // encaixada — de 14:00, somar 30 empata entre 14:00 e 15:00, o empate
    // resolve para o mais cedo, e o card não saía de 14:00 por mais que se
    // apertasse. O fantasma aparecia válido, no lugar de sempre.
    //
    // A seta agora pula de vaga em vaga: de 14:00, a próxima publicada é 15:00.
    const inter = interacao({
      horariosPorDia: { [DIA]: [publicado("09:20"), publicado("14:00"), publicado("15:00")] },
      onArrastarPara: vi.fn(),
    });
    montar({ interacao: inter, agendamentos: [compromisso] });

    fireEvent.keyDown(screen.getByTestId("agendamento-a1"), { key: "ArrowDown", altKey: true });

    const fantasma = screen.getByTestId("fantasma-do-arraste");
    expect(fantasma).toHaveAttribute("data-valido", "true");
    expect(fantasma).toHaveAttribute("data-instante", `${DIA}T15:00:00.000`);
  });

  it("Enter consuma a proposta pelo MESMO caminho que o arraste usaria", () => {
    const onArrastarPara = vi.fn();
    const inter = interacao({
      horariosPorDia: { [DIA]: [publicado("14:00"), publicado("15:00")] },
      onArrastarPara,
    });
    montar({ interacao: inter, agendamentos: [compromisso] });

    const card = screen.getByTestId("agendamento-a1");
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(card, { key: "Enter" });

    expect(onArrastarPara).toHaveBeenCalledWith({
      id: "a1",
      instante: `${DIA}T15:00:00.000`,
      razao: expect.any(String),
    });
  });

  it("proposta fora da disponibilidade vai como `null` — quem recebe RECUSA", () => {
    // O que NÃO pode acontecer: aproximar para o publicado mais perto e
    // remarcar assim mesmo. O destino inválido chega como `null`, com a razão.
    const onArrastarPara = vi.fn();
    const inter = interacao({
      horariosPorDia: { [DIA]: [publicado("14:00")] },
      onArrastarPara,
    });
    montar({ interacao: inter, agendamentos: [compromisso] });

    const card = screen.getByTestId("agendamento-a1");
    // Sem vaga adiante a seta ainda anda, de meia em meia hora — é o que diz
    // "não há para onde ir" em vez de a tecla ficar muda. Quatro passos levam a
    // 16:00, longe dos 30 minutos de tolerância da única vaga do dia.
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    expect(screen.getByTestId("fantasma-do-arraste")).toHaveAttribute("data-valido", "false");

    fireEvent.keyDown(card, { key: "Enter" });
    expect(onArrastarPara).toHaveBeenCalledWith({
      id: "a1",
      instante: null,
      razao: "fora dos horários que você publicou",
    });
  });

  it("Escape desfaz a proposta sem consumar nada", () => {
    const onArrastarPara = vi.fn();
    const inter = interacao({
      horariosPorDia: { [DIA]: [publicado("14:00"), publicado("15:00")] },
      onArrastarPara,
    });
    montar({ interacao: inter, agendamentos: [compromisso] });

    const card = screen.getByTestId("agendamento-a1");
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    expect(screen.getByTestId("fantasma-do-arraste")).toBeInTheDocument();

    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByTestId("fantasma-do-arraste")).toBeNull();
    expect(onArrastarPara).not.toHaveBeenCalled();
  });

  it("card sem `onArrastarPara` não anuncia que se arrasta", () => {
    // Prometer o gesto e não executá-lo é o controle decorativo de novo: o
    // cursor `grab` é a única pista de que o card se move.
    montar({ interacao: interacao(), agendamentos: [compromisso] });
    expect(screen.getByTestId("agendamento-a1")).toHaveAttribute("data-arrastavel", "false");
  });
});
