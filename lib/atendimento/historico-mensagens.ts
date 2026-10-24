/** Predicado comum de leitura. Uma oferta é antecedente, nunca autorização.
 * Legado sem carimbo só entra com recibo aceito e a fronteira do job que enviou;
 * proximidade temporal, metadata livre ou texto parecido não provam vínculo. */
export function mensagemDoAtendimentoSql(message: "m" | "messages", conversation = "c"): string {
  if (conversation !== "c") throw new Error("unsupported_conversation_alias");
  const m = message;
  return `(${m}.organization_id=c.organization_id and ${m}.contact_id=c.contact_id
    and ${m}.conversation_id=c.id and c.is_group=false
    and (${m}.direction='inbound' or (${m}.direction='outbound' and ${m}.status in ('sent','delivered','read')))
    and ((${m}.service_revision=c.service_revision
      and (${m}.demanda_id is not distinct from c.current_demanda_id or ${m}.demanda_id is null))
      or (${m}.service_revision is null and ${m}.direction='outbound'
        and ${m}.sent_at>=c.service_started_at
        and (${m}.demanda_id is null or ${m}.demanda_id=c.current_demanda_id)
        and exists(select 1 from send_ledger sl join job_queue sj
          on sj.organization_id=sl.organization_id and sj.id=sl.job_id and sj.contact_id=sl.contact_id
          where sl.organization_id=c.organization_id and sl.contact_id=c.contact_id
            and sl.crm_message_id=${m}.id and sl.status='accepted'
            and sj.payload->'service_boundary'->>'organization_id'=c.organization_id::text
            and sj.payload->'service_boundary'->>'contact_id'=c.contact_id::text
            and sj.payload->'service_boundary'->>'conversation_id'=c.id::text
            and sj.payload->'service_boundary'->>'service_revision'=c.service_revision::text
            and (sj.payload->'service_boundary'->>'demanda_id' is null
              or sj.payload->'service_boundary'->>'demanda_id'=c.current_demanda_id::text)))))`;
}
