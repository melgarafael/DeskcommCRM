/**
 * Avança um horário em N dias úteis, preservando a HORA (não só a data).
 *
 * Diferente de `lib/lgpd/sla.ts#computeDueAt` (que normaliza pra meia-noite UTC
 * porque um prazo de LGPD é "até o FIM do dia N"): aqui o passo "espera" da
 * cadência precisa do instante exato — um lead inscrito às 14h que espera 2 dias
 * úteis deve valer a partir das 14h do 2º dia útil seguinte, não da meia-noite.
 * A janela de envio (`configuracao.janela`) é quem decide se aquele instante
 * está dentro do horário de disparo — isso é responsabilidade do worker, não
 * desta função.
 */
import { HOLIDAYS_BR_ISO } from "../lgpd/holidays-br";

const FERIADOS = new Set(HOLIDAYS_BR_ISO);

function isoDia(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function eDiaUtil(d: Date): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !FERIADOS.has(isoDia(d));
}

/** Soma `dias` dias úteis a `de`, mantendo hora/minuto/segundo. */
export function avancarDiasUteis(de: Date, dias: number): Date {
  let cursor = new Date(de.getTime());
  let restam = Math.max(0, Math.trunc(dias));
  while (restam > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (eDiaUtil(cursor)) restam--;
  }
  return cursor;
}

/** `de` já é dia útil? Usado pra decidir se um passo pode rodar hoje. */
export function eDiaUtilBR(de: Date): boolean {
  return eDiaUtil(de);
}
