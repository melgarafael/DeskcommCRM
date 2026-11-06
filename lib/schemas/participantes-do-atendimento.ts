import { z } from "zod";

/**
 * Convite para o ATENDIMENTO CONJUNTO (issue #2542) — o corpo de
 * `POST /api/v1/conversations/[id]/participants`.
 *
 * Só o alvo. O vínculo (organização, conversa, quem convidou) NÃO vem do corpo:
 * a organização é a da sessão (cookie validado) e a conversa é o `id` do caminho
 * — os dois de fonte confiável, nunca do que o cliente manda. É a MESMA regra
 * de `transferConversationSchema`, que aceita só o `to_user_id`.
 */
export const convidarParticipanteSchema = z.object({
  user_id: z.string().uuid(),
});

export type ConvidarParticipanteInput = z.infer<typeof convidarParticipanteSchema>;

/**
 * O corpo de `DELETE /api/v1/conversations/[id]/participants` — quem sai.
 *
 * `user_id` igual ao do chamador é o caso "sair da conversa" (permitido a
 * qualquer participante); diferente é o caso "remover um colega" (exige ser o
 * dono ou gestor). Quem separa os dois é a rota.
 */
export const removerParticipanteSchema = z.object({
  user_id: z.string().uuid(),
});

export type RemoverParticipanteInput = z.infer<typeof removerParticipanteSchema>;
