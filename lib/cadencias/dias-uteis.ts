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
import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";

const FERIADOS = new Set(HOLIDAYS_BR_ISO);

function isoDia(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function eDiaUtil(d: Date): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !FERIADOS.has(isoDia(d));
}

/** Soma dias no calendário do fuso, preservando a hora local. Sem fuso, mantém o contrato UTC. */
export function avancarDiasUteis(de: Date, dias: number, fuso = "UTC"): Date {
  let restam = Math.max(0, Math.trunc(dias));
  if (restam === 0) return new Date(de.getTime());
  const parede = partesNoFuso(de, fuso);
  // UTC aqui representa só o CALENDÁRIO local: somar 24h ao instante real
  // mudaria a hora de parede nas viradas de horário de verão.
  const cursor = new Date(Date.UTC(parede.ano, parede.mes - 1, parede.dia));
  while (restam > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (eDiaUtil(cursor)) restam--;
  }
  const resultado = instanteDe({
    ...parede,
    ano: cursor.getUTCFullYear(),
    mes: cursor.getUTCMonth() + 1,
    dia: cursor.getUTCDate(),
  }, fuso);
  return new Date(resultado.getTime() + de.getUTCMilliseconds());
}

/** `de` já é dia útil? Usado pra decidir se um passo pode rodar hoje. */
export function eDiaUtilBR(de: Date): boolean {
  return eDiaUtil(de);
}
