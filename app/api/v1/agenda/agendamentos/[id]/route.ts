import { readServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { meetingDeliverySchema, meetingAuthorizationCurrent } from "@/lib/agenda/google/meet";
import { conflictSchema } from "@/lib/agenda/google/sync-model";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return fail("not_found", "Compromisso indisponível.", 404, { requestId });
  const db = await createClient();
  const org = auth.org.orgId;
  const { data, error } = await db
    .from("calendar_appointments")
    .select(
      "id,title,location_kind,meeting_state,meeting_url,meeting_request_id,meeting_last_error,meeting_delivery,meeting_delivery_job_id,contact_id,conversation_id,starts_at,ends_at,time_zone,status,revision,revision_started_at,outcome_user_id,outcome_source_kind,outcome_message_id,outcome_recorded_at,confirmation_next_at,cancellation_reason,owner_user_id,google_domain_revision:revision::text,google_local_revision::text,google_synced_local_revision::text,google_etag,google_synced_at,google_sync_error,google_conflict",
    )
    .eq("organization_id", org)
    .eq("id", id)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível carregar o compromisso.", 500, { requestId });
  if (!data)
    return fail("not_found", "Este compromisso está indisponível para você.", 404, { requestId });
  // Só depois de provar a entidade pela sessão. Recibo privado não é listável.
  const recovery = await createAdminClient()
    .from("appointment_recovery_receipts")
    .select("result,enrollment_id,invalidated_at,recorded_at")
    .eq("organization_id", org)
    .eq("appointment_id", id)
    .eq("appointment_revision", data.revision)
    .maybeSingle();
  if (recovery.error)
    return fail("internal_error", "Não foi possível carregar o próximo passo.", 500, { requestId });
  const enrollment=recovery.data?.enrollment_id ? await createAdminClient().from("followup_enrollments")
    .select("status,cancel_reason").eq("organization_id",org).eq("id",recovery.data.enrollment_id).maybeSingle() : {data:null,error:null};
  if(enrollment.error) return fail("internal_error","Não foi possível carregar o acompanhamento.",500,{requestId});
  const messages = data.contact_id
    ? await db
        .from("messages")
        .select("id,body,sent_at")
        .eq("organization_id", org)
        .eq("contact_id", data.contact_id)
        .eq("direction", "inbound")
        .not("service_revision", "is", null)
        .gte("created_at", data.revision_started_at)
        .order("sent_at", { ascending: false })
        .limit(20)
    : { data: [], error: null };
  if (messages.error)
    return fail("internal_error", "Não foi possível carregar as mensagens de confirmação.", 500, {
      requestId,
    });
  const delivery = meetingDeliverySchema.safeParse(data.meeting_delivery);
  const deliveryJob = delivery.success && delivery.data.state === "queued" && data.meeting_delivery_job_id
    ? await db.from("job_queue").select("status").eq("organization_id",org).eq("id",data.meeting_delivery_job_id).maybeSingle()
    : {data:null,error:null};
  if (deliveryJob.error) return fail("internal_error","Não foi possível conferir o envio do link.",500,{requestId});
  const deliveryState = delivery.success ? delivery.data.state === "queued" && !["pending","running"].includes(deliveryJob.data?.status ?? "") ? "failed" : delivery.data.state : "none";
  const destinations = data.contact_id && data.owner_user_id === auth.user.id ? await db.from("conversations").select("id,created_at,channel_session_id,contacts(name,phone_number)").eq("organization_id",org).eq("contact_id",data.contact_id).eq("is_group",false).not("status","in","(closed,resolved,archived)").order("created_at",{ascending:false}).limit(20) : {data:[],error:null};
  if (destinations.error) return fail("internal_error","Não foi possível carregar as conversas de destino.",500,{requestId});
  const originalBoundary = delivery.success ? delivery.data.service_boundary ?? null : null;
  let authorizationCurrent = false;
  if (originalBoundary && destinations.data?.some(d => d.id === originalBoundary.conversation_id && delivery.success && d.channel_session_id === delivery.data.channel_session_id)) {
    try { authorizationCurrent = meetingAuthorizationCurrent(originalBoundary, await readServiceBoundarySupabase(createAdminClient(), org, originalBoundary.conversation_id)); }
    catch { return fail("internal_error", "Não foi possível conferir o atendimento do envio.", 500, { requestId }); }
  }
  const meeting = data.location_kind === "google_meet" ? {state:data.meeting_state,url:data.meeting_state === "ready" ? data.meeting_url : null,request_id:data.meeting_request_id,error:data.meeting_last_error,delivery_state:deliveryState,delivery_error:delivery.success ? delivery.data.error ?? null : null,delivery_authorization_current:authorizationCurrent,delivery_conversation_id:delivery.success ? delivery.data.service_boundary?.conversation_id ?? null : null,can_manage:data.owner_user_id === auth.user.id,destinations:(destinations.data ?? []).map(d=>{const contact=Array.isArray(d.contacts)?d.contacts[0]:d.contacts;return {id:d.id,label:`${contact?.name ?? traduzir("Contato", auth.user.idioma)}${contact?.phone_number ? ` — ${contact.phone_number}` : ""} — ${new Date(d.created_at).toLocaleDateString(tagDeIdioma(auth.user.idioma))}`};})} : null;
  const { meeting_delivery_job_id: _deliveryJob, meeting_delivery: _privateDelivery, meeting_request_id: _request, meeting_last_error: _error, meeting_state: _state, meeting_url: _url, google_domain_revision, google_conflict, google_local_revision, google_synced_local_revision, google_etag, google_synced_at, google_sync_error, owner_user_id, ...detail } = data;
  const conflict = conflictSchema.safeParse(google_conflict);
  return ok({ ...detail, meeting, google_sync: { revision: google_domain_revision, local_revision: String(google_local_revision), etag: google_etag, synced_at: google_synced_at, error: google_sync_error,
    pending: BigInt(google_local_revision) > BigInt(google_synced_local_revision), conflict: conflict.success ? conflict.data : null, can_resolve: owner_user_id === auth.user.id }, recovery: recovery.data ? {...recovery.data,enrollment_status:enrollment.data?.status??null,cancel_reason:enrollment.data?.cancel_reason??null} : null, evidence_messages: messages.data }, { requestId });
}
