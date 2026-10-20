import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
/** Resolves only a native database continuation. Payload notes cannot grant authority or prove Google. */
export async function readGoogleContinuation(db: Queryable, job: JobRow) {
  const claim = claimOfJob(job);
  if (!claim) throw new StaleServiceBoundaryError();
  const { rows } = await db.query<{
    receipt: null | { conversation_id: string; channel_session_id: string; outcome: string };
    publication: null | { reservaId: string; revisao: unknown };
  }>(
    `with atual as materialized (
      select public.fn_google_continuation_current($1,$2,$3,$4::timestamptz) as receipt
    ) select atual.receipt,
      (select jsonb_build_object('reservaId',a.id,'revisao',a.revision::text)
       from public.google_publication_continuations c
       join public.calendar_appointments a on a.organization_id=c.organization_id
         and a.contact_id=c.contact_id and a.conversation_id=c.conversation_id and a.id=any(c.appointment_ids)
       where atual.receipt->>'outcome'='synced' and c.organization_id=$1 and c.job_id=$2 and c.contact_id=$5
         and c.conversation_id=(atual.receipt->>'conversation_id')::uuid and c.state='queued'
         and cardinality(c.appointment_ids)=1
         and a.revision::text=c.revisions->a.id::text->>'revision'
         and a.google_local_revision::text=c.revisions->a.id::text->>'google_local_revision') as publication
    from atual`,
    [job.organization_id, job.id, claim.worker_id, claim.acquired_at, job.contact_id],
  );
  const receipt=rows[0]?.receipt;
  if (!receipt) return null;
  const p=rows[0]?.publication, raw=p?.revisao;
  const revision=typeof raw==='number' || typeof raw==='string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
  // Multiple appointments are not collapsed into a false proof of the first.
  const publication=receipt.outcome==='synced' && p && typeof p.reservaId==='string' && p.reservaId &&
    Number.isSafeInteger(revision) && revision>0 ? {reservaId:p.reservaId,revisao:revision} : undefined;
  return {...receipt,...(publication ? {publicacao:publication} : {})};
}

export async function assertGoogleContinuation(db: Queryable, job: JobRow) {
  if (!await readGoogleContinuation(db, job)) throw new StaleServiceBoundaryError();
}
