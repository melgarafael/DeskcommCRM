import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

/**
 * CONDIÇÃO POR DATA RELATIVA — "o período de teste terminou?".
 *
 * ─── O que faltava ────────────────────────────────────────────────────────
 *
 * O vocabulário de condição tinha quatro campos — `lead_stage`, `tag`,
 * `steps_taken`, `last_outcome` — e nenhum deles fala de tempo. Um fluxo de
 * "cliente em teste sem retorno" não tinha como perguntar se o teste acabou:
 * disparava por silêncio, que é outra pergunta, e podia cobrar no meio do
 * período de avaliação.
 *
 * ─── A régua ───────────────────────────────────────────────────────────────
 *
 * A comparação é por DIA DE CALENDÁRIO no fuso da ORGANIZAÇÃO, nunca em UTC.
 * Num fuso a oeste de Greenwich a diferença não é teórica: às 22h de Brasília
 * já é o dia seguinte em UTC, então um teste que termina amanhã leria como
 * "terminou" três horas antes da hora — e disparar cedo é justamente o dano
 * que esta condição existe para evitar.
 *
 *  - `passou_ha` N: a data é hoje, ou ficou N dias ou mais no passado.
 *    **N = 0 inclui HOJE** — "o teste termina hoje" conta como terminado, que
 *    é o caso que o dono pediu por escrito.
 *  - `falta_para` N: a data ainda está N dias ou mais no futuro (o toque ANTES
 *    do vencimento).
 *
 * ─── Ausência e lixo NÃO autorizam nada ───────────────────────────────────
 *
 * Campo vazio, chave inexistente, texto que não é data, data impossível
 * ("2026-02-31"): tudo responde `false`, inclusive quando a condição está
 * escrita como negação. É a mesma doutrina de `evaluateCheck` para
 * `last_outcome` nulo — ausência não prova a negativa —, e aqui ela é mais
 * dura por decisão do dono: dado que falta tem de IMPEDIR o envio, nunca
 * autorizá-lo por suposição. Um fluxo cujo campo ninguém preencheu fica quieto.
 */

export const OPS_DE_DATA = ["passou_ha", "falta_para"] as const;
export type OpDeData = (typeof OPS_DE_DATA)[number];

export function ehOpDeData(op: string): op is OpDeData {
  return (OPS_DE_DATA as readonly string[]).includes(op);
}

/** Um dia de calendário, sem hora e sem fuso — a única forma que se compara aqui. */
interface Dia {
  ano: number;
  mes: number;
  dia: number;
}

/** `YYYY-MM-DD` no começo do valor; aceita ISO com hora (`2026-10-15T12:00:00Z`). */
const DATA_RX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * O dia que o valor guardado representa, ou `null` quando ele não é uma data.
 *
 * Valida o dia DE VERDADE (reconstrói e compara), porque `Date.UTC` normaliza
 * em silêncio: `2026-02-31` viraria 3 de março, e uma data impossível passaria
 * a valer como se fosse real.
 */
export function diaDoValor(valor: unknown): Dia | null {
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return { ano: valor.getUTCFullYear(), mes: valor.getUTCMonth() + 1, dia: valor.getUTCDate() };
  }
  if (typeof valor !== "string") return null;
  const m = DATA_RX.exec(valor.trim());
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const reconstruido = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    reconstruido.getUTCFullYear() !== ano ||
    reconstruido.getUTCMonth() + 1 !== mes ||
    reconstruido.getUTCDate() !== dia
  ) {
    return null;
  }
  return { ano, mes, dia };
}

/** O dia de calendário de `agora` no fuso pedido. Fuso inválido cai no padrão — nunca lança. */
export function diaNoFuso(agora: Date, fuso: string | null | undefined): Dia {
  const emVigor = fuso && fusoValido(fuso) ? fuso : FUSO_PADRAO;
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: emVigor,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const ler = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? NaN);
  return { ano: ler("year"), mes: ler("month"), dia: ler("day") };
}

/** Dias inteiros de `de` até `para` — âncora UTC nos dois lados, então horário de verão não entra na conta. */
function diasEntre(de: Dia, para: Dia): number {
  const a = Date.UTC(de.ano, de.mes - 1, de.dia);
  const b = Date.UTC(para.ano, para.mes - 1, para.dia);
  return Math.round((b - a) / 86_400_000);
}

/**
 * A condição por data, avaliada. **Nunca devolve `true` sem data legível** —
 * ver a seção de ausência no cabeçalho.
 */
export function avaliarDataRelativa(entrada: {
  valor: unknown;
  op: OpDeData;
  dias: unknown;
  agora: Date;
  fuso: string | null | undefined;
}): boolean {
  const dia = diaDoValor(entrada.valor);
  if (!dia) return false;

  const dias = typeof entrada.dias === "number" ? entrada.dias : Number(entrada.dias);
  if (!Number.isFinite(dias) || dias < 0) return false;

  // Positivo = a data está no futuro; negativo = já passou.
  const distancia = diasEntre(diaNoFuso(entrada.agora, entrada.fuso), dia);

  // `>= 0` com `dias = 0` é o que faz "termina hoje" contar como terminado.
  if (entrada.op === "passou_ha") return -distancia >= dias;
  return distancia >= dias;
}
