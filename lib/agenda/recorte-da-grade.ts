import { addDays, startOfDay, startOfMonth, startOfWeek } from "date-fns";

import type { VisaoDaAgenda } from "@/components/agenda/tipos";

/**
 * O PERÍODO QUE A GRADE DESENHA — e, por ser a mesma função, o que ela BUSCA.
 *
 * ═══ O defeito ══════════════════════════════════════════════════════════════
 *
 * A visão Mês desenha SEIS semanas a partir do domingo que abre o mês — os
 * últimos dias do mês anterior na primeira linha, os primeiros do seguinte nas
 * últimas. A busca de `_client.tsx`, porém, pedia só `[dia 1, dia 1 do mês
 * seguinte)`. Os dias do mês vizinho eram DESENHADOS e nunca BUSCADOS: a célula
 * de 30/09 na grade de outubro aparecia vazia com um compromisso marcado nela.
 *
 * Achado pelo CI em 2026-09-24: `agenda-ocupacao-do-google-na-grade` marca na
 * quarta da semana seguinte (30/09) e abre a visão Mês com a âncora em 01/10.
 * Na véspera a âncora era 30/09, o mês era setembro, e o dia estava na busca.
 *
 * Desenho e busca moravam em dois arquivos com duas contas; agora os dois leem
 * daqui, e divergir de novo exige mudar esta função.
 */

/** Seis linhas sempre, mesmo quando o mês cabe em cinco — ver `VisaoDeMes`. */
export const SEMANAS_NA_VISAO_DE_MES = 6;

/** O domingo da primeira linha da visão Mês. */
export function primeiroDiaDaVisaoDeMes(ancora: Date): Date {
  return startOfWeek(startOfMonth(ancora), { weekStartsOn: 0 });
}

/** `[de, ate)` em hora local do navegador — o fim é exclusivo. */
export function recorteDaGrade(visao: VisaoDaAgenda, ancora: Date): { de: Date; ate: Date } {
  if (visao === "mes") {
    const de = primeiroDiaDaVisaoDeMes(ancora);
    return { de, ate: addDays(de, SEMANAS_NA_VISAO_DE_MES * 7) };
  }
  const de = visao === "semana" ? startOfWeek(ancora, { weekStartsOn: 0 }) : startOfDay(ancora);
  return { de, ate: addDays(de, visao === "semana" ? 7 : 1) };
}
