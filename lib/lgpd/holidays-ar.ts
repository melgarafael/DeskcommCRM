/**
 * Feriados nacionais da Argentina — CALCULADOS, não listados à mão.
 * Usados pelo cálculo do prazo da Ley N.º 25.326 para saltar dias não úteis.
 *
 * Mesma doutrina de `./holidays-pt.ts` e `./holidays-br.ts` (#2346/#2413): os
 * fixos são a mesma data em todo ano, e os móveis saem da Páscoa
 * (Meeus/Jones/Butcher, em `./pascoa`).
 *
 * ─── Por que só os INAMOVIBLES entram (revisão por IA, 03/11/2026) ─────────
 *
 * A Ley 27.399 separa os feriados argentinos em três grupos, e só o primeiro
 * entra nesta lista:
 *
 *   • INAMOVIBLES (entram): sempre na mesma data, sem decisão do Poder
 *     Executivo. É o conjunto abaixo — nove fixos mais os três que saem da
 *     Páscoa (Carnaval, segunda e terça, e Sexta-feira Santa).
 *   • TRASLADABLES (NÃO entram): 17 de agosto (San Martín), 12 de outubro
 *     (Diversidad Cultural) e 20 de novembro (Soberanía Nacional) só são
 *     feriado na data observada depois de uma regra de dia da semana (Art.
 *     6.º da Ley 27.399: terça/quarta volta à segunda anterior, quinta/sexta
 *     avança à segunda seguinte) — e, desde o Decreto 614/2025, quando a data
 *     cai sábado ou domingo, quem decide segunda ou a sexta anterior é a
 *     Jefatura de Gabinete de Ministros, por resolução, caso a caso. Não é
 *     uma fórmula fechada: entrar aqui faria o prazo pular um dia que a
 *     resolução daquele ano ainda não decidiu.
 *   • DIAS TURÍSTICOS (NÃO entram): até três pontes por ano, fixadas por
 *     decreto com até 50 dias de antecedência (Art. 7.º) — o mesmo motivo
 *     pelo qual `holidays-pt.ts` deixa de fora a Terça-feira de Carnaval
 *     portuguesa (facultativa, decidida ano a ano).
 *
 * Fontes: Ley N.º 25.326 (HCDN, InfoLEG); Ley N.º 27.399 e Decreto 923/2017
 * (regra de traslado); Decreto 614/2025 (traslado de fim de semana, por
 * resolução da Autoridad de Aplicación). Revisão feita por IA, por delegação
 * do dono do produto (mesmo critério do doc 88 para Portugal) — NÃO é
 * parecer jurídico, e não houve advogado na Argentina.
 */

import { diaEmTornoDaPascoa } from "./pascoa";

/** Primeiro ano coberto pelo calendário gerado. */
export const PRIMEIRO_ANO_COBERTO = 2000;

/**
 * Último ano coberto. O teste `perfil-argentina` exige que ele alcance o ano
 * atual + 2; quando a data chegar perto, o vermelho é o pedido de estender.
 */
export const ULTIMO_ANO_COBERTO = 2100;

/** Feriados fixos — mesma data em todo ano (`MM-DD`), os INAMOVIBLES da Ley 27.399. */
const FIXED_DATES = [
  "01-01", // Año Nuevo
  "03-24", // Día Nacional de la Memoria por la Verdad y la Justicia
  "04-02", // Día del Veterano y de los Caídos en la Guerra de Malvinas
  "05-01", // Día del Trabajador
  "05-25", // Día de la Revolución de Mayo
  "06-20", // Paso a la Inmortalidad del General Manuel Belgrano (Día de la Bandera)
  "07-09", // Día de la Independencia
  "12-08", // Inmaculada Concepción de María
  "12-25", // Navidad
];

/**
 * Os feriados de um ano: os nove fixos, a segunda e a terça de Carnaval
 * (Páscoa − 48 e − 47) e a Sexta-feira Santa / Viernes Santo (Páscoa − 2) —
 * os três inamovibles que saem da Páscoa. Doze por ano, todo ano.
 */
export function feriadosDaArgentinaDoAno(ano: number): string[] {
  return [
    ...FIXED_DATES.map((md) => `${ano}-${md}`),
    diaEmTornoDaPascoa(ano, -48), // Lunes de Carnaval
    diaEmTornoDaPascoa(ano, -47), // Martes de Carnaval
    diaEmTornoDaPascoa(ano, -2), // Viernes Santo
  ];
}

export const HOLIDAYS_AR_ISO: string[] = (() => {
  const lista: string[] = [];
  for (let ano = PRIMEIRO_ANO_COBERTO; ano <= ULTIMO_ANO_COBERTO; ano++) {
    lista.push(...feriadosDaArgentinaDoAno(ano));
  }
  return lista;
})();

const _holidaySet = new Set(HOLIDAYS_AR_ISO);

/**
 * Returns true if the given date falls on an Argentine national holiday
 * (inamovible only — ver cabeçalho). Comparison is done in the
 * America/Argentina/Buenos_Aires timezone.
 */
export function isHolidayAR(date: Date): boolean {
  const isoDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return _holidaySet.has(isoDate);
}
