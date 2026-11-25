import { z } from "zod";
import {
  RECORRENCIAS,
  motivoRegraInvalida,
  primeiraOcorrencia,
  proximaOcorrenciaDepois,
  type RegraDeRecorrencia,
} from "@/lib/agendamento-mensagem/recorrencia";

/**
 * Edição de uma mensagem de texto agendada: o texto, a série (recorrência, início,
 * término opcional) e o que fazer se o número estiver fora do ar. Contato e número
 * NÃO vêm do corpo: saem da conversa, lida pela sessão.
 *
 * O horário vem como hora de parede (`inicio_local`, `YYYY-MM-DDTHH:mm`) no fuso
 * do navegador (`tz`). O servidor calcula o instante da primeira ocorrência; o
 * cliente nunca manda `scheduled_at`.
 */
const dataLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "data_local_invalida");

export const editarAgendamentoSchema = z
  .object({
    title: z.string().trim().max(120).optional().nullable(),
    body: z.string().trim().min(1, "mensagem_vazia").max(4096),
    recorrencia: z.enum(RECORRENCIAS).default("nenhuma"),
    intervalo_dias: z.number().int().min(1).max(365).optional().nullable(),
    inicio_local: dataLocal,
    termino_local: dataLocal.optional().nullable(),
    tz: z.string().min(1).max(64),
    se_desconectado: z.enum(["esperar", "cancelar"]).default("esperar"),
  })
  .strict();

/** Criação: a edição mais a conversa onde o atendente agendou. */
export const criarAgendamentoSchema = editarAgendamentoSchema.extend({ conversation_id: z.uuid() }).strict();

/** A regra de recorrência a partir do corpo validado. */
export function regraDoCorpo(v: {
  recorrencia: RegraDeRecorrencia["recorrencia"];
  intervalo_dias?: number | null;
  inicio_local: string;
  termino_local?: string | null;
  tz: string;
}): RegraDeRecorrencia {
  return {
    recorrencia: v.recorrencia,
    intervalo_dias: v.intervalo_dias ?? null,
    inicio: v.inicio_local,
    termino: v.termino_local ?? null,
    tz: v.tz,
  };
}

/** Instante da primeira ocorrência, em ISO UTC: é o `scheduled_at` da linha. */
export function primeiraOcorrenciaIso(regra: RegraDeRecorrencia): string {
  return primeiraOcorrencia(regra).toISOString();
}

/** O horário precisa estar no futuro: agendar para o passado seria enviar agora sem ninguém pedir. */
export function horarioNoFuturo(scheduledAt: string, agora: Date = new Date()): boolean {
  return new Date(scheduledAt).getTime() > agora.getTime();
}

/**
 * `scheduled_at` de uma EDIÇÃO. Envio único: o horário escolhido, que precisa estar
 * no futuro. Série: a próxima ocorrência depois de agora. Uma série que já começou
 * tem o início no passado, e recalcular a partir dele recusaria editar até o texto.
 */
export function proximoScheduledAtDaEdicao(
  regra: RegraDeRecorrencia,
  agora: Date = new Date(),
): { ok: true; scheduledAt: string } | { ok: false; motivo: "horario_no_passado" | "serie_sem_proxima_ocorrencia" } {
  if (regra.recorrencia === "nenhuma") {
    const scheduledAt = primeiraOcorrenciaIso(regra);
    return horarioNoFuturo(scheduledAt, agora) ? { ok: true, scheduledAt } : { ok: false, motivo: "horario_no_passado" };
  }
  const proxima = proximaOcorrenciaDepois(regra, agora);
  return proxima ? { ok: true, scheduledAt: proxima.toISOString() } : { ok: false, motivo: "serie_sem_proxima_ocorrencia" };
}

export { motivoRegraInvalida };
