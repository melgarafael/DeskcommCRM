/**
 * O EDITOR DA JORNADA PROMETIA A SEMANA E GRAVAVA SÓ A LINHA EM QUE SE ESTAVA.
 *
 * ─── O defeito, medido na issue #2312 ──────────────────────────────────────
 *
 * Na primeira instalação a pessoa abriu o editor (botão só de ícone, Equipe ›
 * Atendimento, coluna Horário), digitou o horário e salvou: ficou gravado
 * `windows` só com `dow: 1`. A grade da Agenda continuou oferecendo horário só
 * às segundas, sem nenhum aviso — quem preencheu achava que tinha publicado a
 * semana inteira. Repetir as faixas dia a dia na mão é a alternativa que a
 * própria issue aponta como "onde eu erri".
 *
 * ─── O que este arquivo guarda ─────────────────────────────────────────────
 *
 * A REGRA do botão "copiar estes horários para os outros dias úteis" e a regra
 * do resumo mostrado depois de salvar. São puras de propósito: a tela só as
 * aciona, e é aqui que se prova o comportamento sem montar o diálogo inteiro.
 *
 * Duas decisões que o teste abaixo precisa fixar, porque cada uma delas pode
 * ser "consertada" para longe do que a issue pediu:
 *
 *   1. O dia-modelo é o PRIMEIRO dia com janela na tela (a ordem em que a
 *      pessoa digitou), e os demais dias úteis PASSAM A TER as mesmas faixas.
 *      Substituir, e não somar, é o que o rótulo promete: "copiar estes
 *      horários para os outros dias úteis" quer dizer que os dias-alvo ficam
 *      IGUAIS ao dia-modelo. Somar deixaria a segunda copiada por cima de uma
 *      terça já preenchida e a semana continuaria heterogênea.
 *      Tudo acontece no RASCUNHO: nada é gravado antes de "Salvar", e
 *      "Cancelar" desfaz — o risco de substituir some junto com o diálogo.
 *
 *   2. Sábado e domingo NÃO são dias úteis e ficam intocados. O botão não
 *      promete o fim de semana; quem publica sábado publica à mão.
 *
 * O resumo do segundo teste lê o que FOI GRAVADO (o retorno da gravação), nunca
 * o que está no formulário — a diferença é exatamente o defeito: o formulário
 * dizia uma semana, o banco guardava um dia.
 */
import { describe, expect, it } from "vitest";

import {
  copiarParaDiasUteis,
  podeCopiarParaDiasUteis,
  resumoDaJornada,
} from "@/lib/agenda/editor-de-jornada";
import type { ScheduleWindow } from "@/lib/schemas/routing";

/** Sem provider de idioma `t` devolve a chave — português é a chave. */
const t = (texto: string) => texto;

const MANHA: ScheduleWindow = { dow: 1, start: "08:00", end: "11:30" };
const TARDE: ScheduleWindow = { dow: 1, start: "14:00", end: "18:00" };

function faixasDe(windows: ScheduleWindow[], dow: number) {
  return windows
    .filter((w) => w.dow === dow)
    .map((w) => `${w.start}–${w.end}`)
    .sort();
}

describe("copiarParaDiasUteis", () => {
  it("com horários na 2ª, leva as mesmas faixas para ter, qua, qui e sex", () => {
    const copiado = copiarParaDiasUteis([MANHA, TARDE]);

    for (const dow of [2, 3, 4, 5]) {
      expect(faixasDe(copiado, dow)).toEqual(["08:00–11:30", "14:00–18:00"]);
    }
    expect(faixasDe(copiado, 1)).toEqual(["08:00–11:30", "14:00–18:00"]);
  });

  it("sábado e domingo ficam como estavam — o botão só promete dias úteis", () => {
    const sabado: ScheduleWindow = { dow: 6, start: "09:00", end: "12:00" };
    const copiado = copiarParaDiasUteis([MANHA, sabado]);

    expect(faixasDe(copiado, 6)).toEqual(["09:00–12:00"]);
    expect(faixasDe(copiado, 0)).toEqual([]);
  });

  it("substitui o dia-alvo que já tinha horário diferente — é o que o rótulo promete", () => {
    const tercaOutra: ScheduleWindow = { dow: 2, start: "22:00", end: "23:30" };
    const copiado = copiarParaDiasUteis([MANHA, tercaOutra]);

    expect(faixasDe(copiado, 2)).toEqual(["08:00–11:30"]);
    expect(faixasDe(copiado, 2)).not.toContain("22:00–23:30");
  });

  it("sem nenhuma janela não inventa nada", () => {
    expect(copiarParaDiasUteis([])).toEqual([]);
  });

  it("sem nenhuma janela o botão fica desligado — não há o que copiar", () => {
    // Ligado aqui seria um clique que não faz nada, e o comentário da tela
    // promete o contrário ("desligado quando não há o que copiar").
    expect(podeCopiarParaDiasUteis([])).toBe(false);
    expect(podeCopiarParaDiasUteis([MANHA])).toBe(true);
  });

  it("não passa do limite de 50 janelas que a rota aceita", () => {
    const muitas: ScheduleWindow[] = Array.from({ length: 11 }, (_, i) => ({
      dow: 1,
      start: `0${i % 10}:00`,
      end: `0${i % 10}:30`,
    }));
    expect(podeCopiarParaDiasUteis(muitas)).toBe(false);

    const naConta: ScheduleWindow[] = muitas.slice(0, 10);
    expect(podeCopiarParaDiasUteis(naConta)).toBe(true);
  });
});

describe("resumoDaJornada", () => {
  it("mostra exatamente os dias e horários que foram gravados", () => {
    const gravados: ScheduleWindow[] = [1, 2, 3, 4, 5].map((dow) => ({
      dow,
      start: "08:00",
      end: "11:30",
    }));
    expect(resumoDaJornada(gravados, t)).toEqual(["Seg–Sex 08:00–11:30"]);
  });

  it("agrupa as faixas iguais e separa as diferentes, sem perder dia", () => {
    const gravados: ScheduleWindow[] = [
      { dow: 1, start: "08:00", end: "11:30" },
      { dow: 5, start: "08:00", end: "11:30" },
      { dow: 1, start: "14:00", end: "18:00" },
      { dow: 3, start: "14:00", end: "18:00" },
    ];
    expect(resumoDaJornada(gravados, t)).toEqual([
      "Seg, Sex 08:00–11:30",
      "Seg, Qua 14:00–18:00",
    ]);
  });

  it("dia que não é seguidinho vira lista, e nunca some do resumo", () => {
    const gravados: ScheduleWindow[] = [
      { dow: 1, start: "08:00", end: "12:00" },
      { dow: 4, start: "08:00", end: "12:00" },
    ];
    expect(resumoDaJornada(gravados, t)).toEqual(["Seg, Qui 08:00–12:00"]);
  });

  it("nada gravado diz que nada foi publicado", () => {
    expect(resumoDaJornada([], t)).toEqual(["Não publicado"]);
  });
});
