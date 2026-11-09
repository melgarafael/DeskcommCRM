/**
 * O QUADRO POR PROFISSIONAL (#4186) — a conta, sem tela.
 *
 * A agenda de Dia/Semana/Mês põe o tempo na vertical e todo mundo na mesma
 * coluna. Quem distribui atendimento entre vários profissionais (a recepção de
 * uma oficina, de uma clínica com três dentistas) precisa do contrário: UMA
 * LINHA POR PESSOA e o dia correndo na horizontal, para achar num relance
 * quem está livre às 10h.
 *
 * Este módulo só faz geometria: em que coluna cada compromisso começa, quantas
 * colunas ocupa, em que faixa da linha ele cai quando dois se encavalam, e qual
 * horário LIVRE (vindo do motor, nunca calculado aqui) cada célula oferece. O
 * componente `components/agenda/QuadroPorProfissional.tsx` só desenha o que
 * sai daqui — e é por isso que a conta mora fora dele: dá para provar sem DOM.
 *
 * O que ele NÃO decide: se um horário está livre. Isso é do motor
 * (`/api/v1/agenda/horarios-livres`), a mesma régua do painel de marcação e do
 * agente. O quadro só posiciona o que o motor ofereceu.
 */
import { diaLocalISO, partesNoFuso } from "@/lib/agenda/fuso";

/** Um começo de coluna, em minutos do dia no fuso da agenda. */
export interface ColunaDoQuadro {
  minuto: number;
  /** "08:00" — rótulo do cabeçalho. */
  rotulo: string;
  /** Hora cheia: o cabeçalho a destaca, para o olho achar as horas. */
  cheia: boolean;
}

/** Os passos que o quadro aceita. Fora disto a grade fica ilegível ou enorme. */
export const PASSOS_DO_QUADRO = [15, 30, 60] as const;
export type PassoDoQuadro = (typeof PASSOS_DO_QUADRO)[number];

function hhmm(minuto: number): string {
  return `${String(Math.floor(minuto / 60)).padStart(2, "0")}:${String(minuto % 60).padStart(2, "0")}`;
}

/**
 * As colunas do dia, de `primeiraHora` até o FIM de `ultimaHora`.
 *
 * Mesma janela da grade de Dia/Semana (`JANELA_DA_GRADE`), passada por quem
 * chama: o quadro e a grade mostram as mesmas horas, e trocar de visão não faz
 * um compromisso das 7h sumir de uma delas.
 */
export function colunasDoQuadro(
  primeiraHora: number,
  ultimaHora: number,
  passoMin: PassoDoQuadro,
): ColunaDoQuadro[] {
  const colunas: ColunaDoQuadro[] = [];
  for (let m = primeiraHora * 60; m < (ultimaHora + 1) * 60; m += passoMin) {
    colunas.push({ minuto: m, rotulo: hhmm(m), cheia: m % 60 === 0 });
  }
  return colunas;
}

/**
 * O minuto do dia `diaISO` em que o instante cai, no fuso da agenda — preso
 * entre 0 e 1440. Antes do dia vale 0, depois vale 1440: um compromisso que
 * atravessa a meia-noite aparece só com o pedaço deste dia.
 */
export function minutoNoDia(instante: Date, diaISO: string, fuso: string): number {
  const dia = diaLocalISO(instante, fuso);
  if (dia < diaISO) return 0;
  if (dia > diaISO) return 24 * 60;
  const p = partesNoFuso(instante, fuso);
  return p.hora * 60 + p.minuto;
}

/** Algo que ocupa tempo numa linha: um compromisso ou um fechamento da agenda. */
export interface PedacoDoQuadro<T> {
  item: T;
  comeca: string;
  termina: string;
}

/** Um pedaço já posicionado na grade da linha. */
export interface PosicaoNoQuadro<T> {
  item: T;
  /** Índice da primeira coluna (0 = primeira coluna de horário). */
  coluna: number;
  /** Quantas colunas ocupa — no mínimo 1, para nada sumir por ser curto. */
  colunas: number;
  /** Faixa da linha (0 = primeira). Dois compromissos encavalados vão em faixas diferentes. */
  faixa: number;
}

/**
 * Posiciona os pedaços de UMA pessoa num dia.
 *
 * O que fica fora da janela de colunas (um compromisso às 23h com a janela
 * acabando às 21h) não entra — o quadro mostra a janela, como a grade. Um
 * pedaço que só toca a borda é recortado nela.
 *
 * As faixas são o "empilhar" da issue: a oficina põe dois carros com o mesmo
 * consultor às 8h e os dois precisam aparecer. A regra é a de qualquer agenda:
 * cada pedaço vai na primeira faixa onde não encosta em ninguém.
 */
export function posicionarNaLinha<T>(
  pedacos: Array<PedacoDoQuadro<T>>,
  colunas: ColunaDoQuadro[],
  passoMin: number,
  diaISO: string,
  fuso: string,
): { posicoes: Array<PosicaoNoQuadro<T>>; faixas: number } {
  const primeira = colunas[0];
  const ultima = colunas[colunas.length - 1];
  if (!primeira || !ultima) return { posicoes: [], faixas: 1 };
  const inicioDaJanela = primeira.minuto;
  const fimDaJanela = ultima.minuto + passoMin;

  const dentro = pedacos
    .map((p) => {
      const de = Math.max(minutoNoDia(new Date(p.comeca), diaISO, fuso), inicioDaJanela);
      const ate = Math.min(minutoNoDia(new Date(p.termina), diaISO, fuso), fimDaJanela);
      return { p, de, ate };
    })
    .filter(({ de, ate }) => ate > de)
    .sort((a, b) => a.de - b.de || b.ate - a.ate);

  const fimDaFaixa: number[] = [];
  const posicoes: Array<PosicaoNoQuadro<T>> = [];
  for (const { p, de, ate } of dentro) {
    const coluna = Math.floor((de - inicioDaJanela) / passoMin);
    const ultimaColuna = Math.ceil((ate - inicioDaJanela) / passoMin);
    let faixa = fimDaFaixa.findIndex((fim) => fim <= coluna);
    if (faixa === -1) {
      faixa = fimDaFaixa.length;
      fimDaFaixa.push(0);
    }
    fimDaFaixa[faixa] = ultimaColuna;
    posicoes.push({ item: p.item, coluna, colunas: Math.max(ultimaColuna - coluna, 1), faixa });
  }
  return { posicoes, faixas: Math.max(fimDaFaixa.length, 1) };
}

/** O horário livre que o motor ofereceu, como a grade o recebe. */
export interface HorarioLivreDoQuadro {
  instante: string;
  rotulo: string;
}

/**
 * Qual horário livre cada coluna oferece, para UMA pessoa.
 *
 * O motor devolve começos no passo do SERVIÇO (um serviço de 45 min pode
 * oferecer 08:00, 08:45, 09:30…), e o quadro tem colunas no passo dele. Cada
 * coluna oferece o primeiro horário livre que começa dentro dela; sem nenhum, a
 * coluna não é clicável. O rótulo é o do horário, não o da coluna — quem clica
 * na coluna das 08:30 e recebe 08:45 vê 08:45 escrito.
 */
export function livresPorColuna(
  livres: HorarioLivreDoQuadro[],
  colunas: ColunaDoQuadro[],
  passoMin: number,
  diaISO: string,
  fuso: string,
): Array<HorarioLivreDoQuadro | null> {
  const porColuna: Array<HorarioLivreDoQuadro | null> = colunas.map(() => null);
  const primeira = colunas[0];
  if (!primeira) return porColuna;
  for (const livre of livres) {
    const instante = new Date(livre.instante);
    if (diaLocalISO(instante, fuso) !== diaISO) continue;
    const minuto = minutoNoDia(instante, diaISO, fuso);
    const indice = Math.floor((minuto - primeira.minuto) / passoMin);
    if (indice < 0 || indice >= colunas.length) continue;
    const atual = porColuna[indice];
    if (!atual || new Date(atual.instante).getTime() > instante.getTime())
      porColuna[indice] = livre;
  }
  return porColuna;
}
