/**
 * O mês da meta, no calendário de QUEM LÊ a tela (issue #3025, fatia 1).
 *
 * ─── Por que não `new Date().toISOString()` ─────────────────────────────────
 * A meta é mensal e o mês é o do operador, não um instante UTC. Às 22h de 31 de
 * agosto em São Paulo (01h de 1º de setembro em UTC), `toISOString()` diria
 * "setembro" para quem ainda está em agosto — e a tela mostraria a meta do mês
 * que ainda não começou, com realizado zerado, como se a empresa não tivesse
 * vendido nada.
 *
 * ─── O fuso vai EXPLÍCITO na janela, e a rota lê o mês do TEXTO ─────────────
 * `janelaDoMes("2026-09")` devolve `2026-09-01T00:00:00-03:00` (o offset de
 * quem chamou) — e a rota tira o mês dos 7 primeiros caracteres DESSA string,
 * não do instante convertido para UTC. É o que faz o mês pedido ser o mês
 * local também do lado do servidor.
 */

function doisDigitos(n: number): string {
  return String(n).padStart(2, "0");
}

/** O fuso local como `±HH:MM`, no mesmo minuto em que a data acontece. */
function deslocamentoLocal(d: Date): string {
  // `getTimezoneOffset()` devolve minutos ATRÁS de UTC (São Paulo = 180); o
  // sinal que entra na string é o oposto, como no ISO.
  const minutos = -d.getTimezoneOffset();
  const sinal = minutos >= 0 ? "+" : "-";
  const absoluto = Math.abs(minutos);
  return `${sinal}${doisDigitos(Math.floor(absoluto / 60))}:${doisDigitos(absoluto % 60)}`;
}

/** O mês corrente de quem está olhando a tela, como `YYYY-MM`. */
export function mesLocal(agora: Date = new Date()): string {
  return `${agora.getFullYear()}-${doisDigitos(agora.getMonth() + 1)}`;
}

/** Meia-noite LOCAL do dia 1º do mês pedido, com o fuso explícito. */
function primeiroDiaLocal(ano: number, mesZero: number): string {
  // O dia 1º do mês seguinte é expresso como `mesZero + 1` e o construtor
  // normaliza a virada de ano (dezembro → janeiro do ano seguinte).
  const d = new Date(ano, mesZero, 1, 0, 0, 0, 0);
  return (
    `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}` +
    `T00:00:00${deslocamentoLocal(d)}`
  );
}

/**
 * A janela do mês `YYYY-MM`: de `[1º dia 00:00 local, 1º dia do mês seguinte)`.
 * O limite de cima é EXCLUSIVO (`<`), como o resto do produto compara janelas.
 */
export function janelaDoMes(mes: string): { from: string; to: string } {
  const [anoTexto, mesTexto] = mes.split("-");
  const ano = Number(anoTexto);
  const mesZero = Number(mesTexto) - 1;
  if (!Number.isInteger(ano) || !Number.isInteger(mesZero) || mesZero < 0 || mesZero > 11) {
    throw new Error(`mês inválido: ${mes}`);
  }
  return { from: primeiroDiaLocal(ano, mesZero), to: primeiroDiaLocal(ano, mesZero + 1) };
}

/** `2026-09-01` → `09/2026`, para o rótulo do painel. */
export function mesLegivel(periodo: string | null): string | null {
  if (!periodo || periodo.length < 7) return null;
  return `${periodo.slice(5, 7)}/${periodo.slice(0, 4)}`;
}
