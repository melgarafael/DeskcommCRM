/**
 * Feriados nacionais de Portugal — CALCULADOS, não listados à mão.
 * Usados pelo cálculo do prazo do RGPD para saltar dias não úteis.
 *
 * São os feriados obrigatórios do Código do Trabalho (art. 234.º). Quatro deles
 * — Corpo de Deus, 5 de Outubro, 1 de Novembro e 1 de Dezembro — foram
 * suspensos pela Lei n.º 23/2012 a partir de 2013 e repostos pela Lei n.º
 * 8/2016. Aqui moram os dez fixos e os dois móveis que podem cair em dia útil
 * (Sexta-feira Santa e Corpo de Deus); o Domingo de Páscoa também é
 * obrigatório, mas cai sempre a domingo, que o prazo já salta.
 *
 * A Terça-feira de Carnaval NÃO entra: é feriado facultativo (art. 235.º),
 * decidido ano a ano. Listá-la faria o prazo pular um dia útil a mais.
 *
 * ─── Por que o cálculo substituiu a tabela (#2346) ───────────────────────────
 *
 * Os móveis saíam de uma lista à mão para 2026–2030: depois de 2030 o prazo
 * seria contado SEM os feriados portugueses, e ninguém seria avisado. A Páscoa
 * e os móveis que dependem dela agora são calculados (Meeus/Jones/Butcher), e a
 * cobertura é uma CONSTANTE vigiada por teste: `ULTIMO_ANO_COBERTO` tem de
 * alcançar o ano atual + 2, senão o teste de cobertura reprova.
 *
 * O conjunto é o MESMO da tabela antiga — dez fixos + Sexta-feira Santa
 * (Páscoa − 2) e Corpo de Deus (Páscoa + 60) —, e o teste reproduz os cinco
 * anos que estavam listados, para o cálculo não trocar a régua em silêncio.
 */

import { diaEmTornoDaPascoa } from "./pascoa";

/** Primeiro ano coberto pelo calendário gerado. */
export const PRIMEIRO_ANO_COBERTO = 2000;

/**
 * Último ano coberto. O teste `perfil-portugal` exige que ele alcance o ano
 * atual + 2; quando a data chegar perto, o vermelho é o pedido de estender.
 */
export const ULTIMO_ANO_COBERTO = 2100;

/** Feriados fixos — mesma data em todo ano (`MM-DD`). */
const FIXED_DATES = [
  "01-01", // Ano Novo
  "04-25", // Dia da Liberdade (25 de Abril)
  "05-01", // Dia do Trabalhador
  "06-10", // Dia de Portugal, de Camões e das Comunidades Portuguesas
  "08-15", // Assunção de Nossa Senhora
  "10-05", // Implantação da República
  "11-01", // Dia de Todos os Santos
  "12-01", // Restauração da Independência
  "12-08", // Imaculada Conceição
  "12-25", // Natal
];

/**
 * Os doze feriados obrigatórios de um ano: os dez fixos, a Sexta-feira Santa
 * (Páscoa − 2) e o Corpo de Deus (Páscoa + 60). A Páscoa vem do módulo comum
 * (`./pascoa`), o mesmo que o Brasil usa.
 *
 * ⚠️ A lista pode repetir uma data: quando o Corpo de Deus cai em 10 de junho
 * (Dia de Portugal), os dois feriados são o MESMO dia — 2004, 2066, 2077 e
 * 2088, por exemplo. Quem consome usa `Set`, então a repetição não muda a
 * contagem de dias úteis.
 */
export function feriadosDePortugalDoAno(ano: number): string[] {
  return [
    ...FIXED_DATES.map((md) => `${ano}-${md}`),
    diaEmTornoDaPascoa(ano, -2), // Sexta-feira Santa
    diaEmTornoDaPascoa(ano, 60), // Corpo de Deus
  ];
}

export const HOLIDAYS_PT_ISO: string[] = (() => {
  const lista: string[] = [];
  for (let ano = PRIMEIRO_ANO_COBERTO; ano <= ULTIMO_ANO_COBERTO; ano++) {
    lista.push(...feriadosDePortugalDoAno(ano));
  }
  return lista;
})();

const _holidaySet = new Set(HOLIDAYS_PT_ISO);

/**
 * Returns true if the given date falls on a Portuguese national holiday.
 * Comparison is done in the Europe/Lisbon timezone.
 */
export function isHolidayPT(date: Date): boolean {
  // Format: YYYY-MM-DD in Lisbon timezone
  const isoDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return _holidaySet.has(isoDate);
}
