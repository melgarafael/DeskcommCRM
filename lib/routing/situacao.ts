/**
 * A situação de um atendente para RECEBER conversa agora — a frase que a tela
 * de Distribuição e o bloco "Distribuir atendimento" mostram ao lado do nome.
 *
 * É a MESMA conta do roteador (`isAttendantEligible`), desdobrada para dizer o
 * PORQUÊ: "não recebe" sozinho mandava o dono da empresa procurar a causa em
 * três telas (Equipe, Atendimento, Conexões). A ordem dos motivos é a ordem em
 * que alguém resolve: primeiro ligar a pessoa, depois o horário, depois a carga.
 */
import type { AvailabilitySchedule } from "@/lib/schemas/routing";

import { isWithinSchedule } from "./eligibility";

export type SituacaoDoAtendente = "pode_receber" | "indisponivel" | "fora_do_horario" | "lotado";

export interface FatosDoAtendente {
  isAvailable: boolean;
  /** `null` = sem cadastro de disponibilidade (nunca configurado) — conta como indisponível, como no roteador. */
  capacity: number | null;
  currentLoad: number;
  schedule?: Pick<AvailabilitySchedule, "timezone" | "windows"> | null;
}

export function situacaoDoAtendente(
  fatos: FatosDoAtendente,
  agora: Date,
  /** O teto extra do bloco do fluxo (`limite_por_atendente`), quando houver. */
  limiteExtra?: number,
): SituacaoDoAtendente {
  if (!fatos.isAvailable || fatos.capacity === null) return "indisponivel";
  if (!isWithinSchedule(fatos.schedule ?? null, agora)) return "fora_do_horario";
  const teto = limiteExtra === undefined ? fatos.capacity : Math.min(fatos.capacity, limiteExtra);
  if (fatos.currentLoad >= teto) return "lotado";
  return "pode_receber";
}

/** O que a tela escreve para cada situação. */
export const ROTULO_DA_SITUACAO: Record<SituacaoDoAtendente, string> = {
  pode_receber: "Pode receber",
  indisponivel: "Indisponível",
  fora_do_horario: "Fora do horário",
  lotado: "No limite de conversas",
};
