import { z } from "zod";
import { RECORRENCIAS, motivoRegraInvalida, type RegraDeRecorrencia } from "@/lib/agendamento-mensagem/recorrencia";

const dataLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "data_local_invalida");

/** Criação de uma mensagem de texto agendada para um contato. */
export const criarAgendamentoSchema = z
  .object({
    contact_id: z.uuid(),
    channel_session_id: z.uuid(),
    title: z.string().trim().max(120).optional().nullable(),
    body: z.string().trim().min(1, "mensagem_vazia").max(4096),
    recorrencia: z.enum(RECORRENCIAS),
    intervalo_dias: z.number().int().min(1).max(365).optional().nullable(),
    inicio_local: dataLocal,
    termino_local: dataLocal.optional().nullable(),
    tz: z.string().min(1).max(64),
    se_desconectado: z.enum(["esperar", "cancelar"]).default("esperar"),
  })
  .strict();

export type CriarAgendamento = z.infer<typeof criarAgendamentoSchema>;

/** Regra de recorrência a partir do corpo validado. */
export function regraDoCorpo(v: Pick<CriarAgendamento, "recorrencia" | "intervalo_dias" | "inicio_local" | "termino_local" | "tz">): RegraDeRecorrencia {
  return {
    recorrencia: v.recorrencia,
    intervalo_dias: v.intervalo_dias ?? null,
    inicio: v.inicio_local,
    termino: v.termino_local ?? null,
    tz: v.tz,
  };
}

export { motivoRegraInvalida };
