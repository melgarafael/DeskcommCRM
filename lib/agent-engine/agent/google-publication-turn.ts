import type pg from "pg";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { runAgentTurn, ritualBlocks, type InboundTurnDeps } from "./inbound-turn";

import { claimOfJob } from "../queue/claim";
import { readGoogleContinuation } from "@/lib/agenda/google/continuation-policy";

export function createGooglePublicationTurnHandler(deps: InboundTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }) => {
    const receipt = await readGoogleContinuation(pool, job);
    if (!receipt) return;
    const claim = claimOfJob(job)!;
    // Note is a separate native statement. A busy FK uses the job retry and
    // never rolls back Google acknowledgement or holds calendar inventory.
    const { rows } = await pool.query<{ recorded: boolean }>(
      "select public.fn_google_continuation_activity($1,$2,$3,$4::timestamptz) as recorded",
      [job.organization_id, job.id, claim.worker_id, claim.acquired_at],
    );
    if (!rows[0]?.recorded) return;
    await runAgentTurn(deps, job, pool, ctx, {
      conversationId: receipt.conversation_id, channelSessionId: receipt.channel_session_id,
      ...(receipt.publicacao ? {googlePublicationObservation:receipt.publicacao} : {}),
      buildOpening: ({ previous, leadState, context, notesIndexBlock, projeta }) => [
        "Retomada nativa do pedido de reserva após a publicação Google. Releia os fatos atuais do atendimento.",
        receipt.outcome === "synced"
          ? "A revisão reservada foi publicada. Confirme ao cliente somente os dados comprovados e siga as instruções comerciais vigentes do agente. Não faça outra reserva."
          : "A publicação tem uma falha que depende de intervenção humana. Não confirme publicação. Abra ou reutilize o Caso com a causa factual atual; não peça aprovação para uma demora normal.",
        ...ritualBlocks(previous, leadState, context, notesIndexBlock, projeta),
        "Use send_message para comunicar: os controles habituais de revisão continuam obrigatórios.",
      ].join("\n"),
    });
  };
}
