import {sendWithLedger,supabaseSendLedger} from "@/lib/agent-engine/edge/crm/send-ledger";
import { randomUUID } from "node:crypto";
import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { AgendaDeferredError } from "@/lib/agenda/protecao-followup";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { createSupabaseAdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import { logger } from "@/lib/logger";

function ponteSupabase(admin: SupabaseClient): TurnBridgeAdminClient {
  const base = createSupabaseAdminClient(admin);
  return {
    ...base,
    async assertFollowupJob(orgId,jobId,enrollmentId,nodeId,claim){
      if(!claim)throw new StaleServiceBoundaryError();
      const held=await admin.rpc("fn_followup_claim_current",{p_org:orgId,p_job:jobId,p_worker:claim.worker_id,p_acquired_at:claim.acquired_at});
      if(held.error)throw held.error;if(!held.data)throw new StaleServiceBoundaryError();
      const {data,error}=await admin.rpc("fn_followup_job_current",{p_org:orgId,p_job:jobId,p_enrollment:enrollmentId,p_node:nodeId});
      if(error) throw error;
      if(!data) throw new StaleServiceBoundaryError();
    },
    async loadEnrollmentById(orgId, id) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("*")
        .eq("id", id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return data as EnrollmentRow;
    },
  };
}

/** Envia o texto fixo do fluxo neste request — sem cron e sem agent-worker. */
export async function enviarTextoFixoPendente(
  admin: SupabaseClient,
  somenteContactIds?: string[],
): Promise<number> {
  const { data: jobs, error } = await admin
    .from("job_queue")
    .select("id, organization_id, contact_id, payload, attempts, max_attempts")
    .eq("kind", "followup_turn")
    .eq("status", "pending")
    .lte("run_after",new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(error.message);

  const workerId=`inline-followup:${randomUUID()}`;
  async function settle(org:string,id:string,acquiredAt:string,done:boolean,error?:string,deferred?:AgendaDeferredError){
    const {data:held,error:failure}=await admin.rpc("fn_followup_inline_settle",{p_org:org,p_id:id,p_worker:workerId,p_acquired_at:acquiredAt,p_done:done,p_error:error??null,p_retry_at:deferred?.protection.reavaliar_em??null,p_hold:!!deferred&&deferred.protection.motivo!=="leitura_indisponivel"});
    if(failure) throw failure;
    if(!held) throw new StaleServiceBoundaryError();
  }
  let enviados = 0;
  const ponte = ponteSupabase(admin);
  for (const job of jobs ?? []) {
    const payload = (job.payload ?? {}) as FollowupJobRequest["payload"];
    const body = payload.fixed_body;
    const enrollmentId = payload.followup_enrollment_id;
    const nodeId = payload.node_id;
    const contactId = job.contact_id as string | null;
    if (typeof body !== "string" || !body || !enrollmentId || !nodeId || !contactId) continue;
    if (somenteContactIds && !somenteContactIds.includes(contactId)) continue;

    const { data: claimed, error: claimErr } = await admin
      .from("job_queue")
      .update({ status: "running",attempts:Number(job.attempts??0)+1,locked_by:workerId,locked_at:new Date().toISOString() })
      .eq("id", job.id)
      .eq("organization_id",job.organization_id)
      .eq("status", "pending")
      .lte("run_after",new Date().toISOString())
      .select("id,locked_by,locked_at")
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) continue;
    const jobClaim={worker_id:claimed.locked_by as string,acquired_at:claimed.locked_at as string};

    try {
      const { data: enr } = await admin
        .from("followup_enrollments")
        .select("current_node_id,status,revision")
        .eq("id", enrollmentId)
        .eq("organization_id", job.organization_id as string)
        .maybeSingle();
      if (!enr || enr.current_node_id !== nodeId || !["active","waiting_reply"].includes(enr.status)) {
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
        continue;
      }
      const boundary = parseServiceBoundary((job.payload as Record<string, unknown>).service_boundary);
      await assertServiceBoundarySupabase(admin, boundary);
      const conversationId = boundary!.conversation_id;
      // GATE DE ELEGIBILIDADE — este envio inline BYPASSA `executarTurnoDoAgente`
      // (é o atalho "sem cron e sem agent-worker"), então precisa da checagem
      // por conta própria. Mesma regra pura do drain/turno. Canal 'open' → passa.
      // Bloqueio definitivo → o follow-up NÃO sai e o job vira `done`. Erro de
      // leitura → job volta pra `pending` (pode ser transitório) — fail-closed:
      // não envia sem confirmar.
      const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
        organizationId: job.organization_id as string,
        conversationId,
        agora: new Date(),
        ttlMs: ttlDaAutorizacaoMs(process.env),
      });
      if (elegib !== null && !elegib.permite) {
        logger.info("[followup] texto fixo não enviado — conversa não elegível para IA", {
          organization_id: job.organization_id,
          conversation_id: conversationId,
          motivo: elegib.motivo,
        });
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
        continue;
      }

      const proactiveContext={organizationId:job.organization_id as string,contactId,enrollmentId,nodeId,jobId:job.id,jobClaim};
      await assertAgendaEffectSupabase(admin,proactiveContext);
      const resultado=await sendWithLedger(supabaseSendLedger(admin),{tenantId:job.organization_id,leadId:contactId,jobId:job.id,seq:1,body},async(key,messageId)=>sendMessageHandler(
        admin,
        {organization_id:job.organization_id,actor:{type:"webhook_source",id:enrollmentId},serviceBoundary:boundary,proactiveContext,internalMessageId:messageId,requestId:key},
        {conversation_id:conversationId,type:"text",body,metadata:{idempotency_key:key}},
      ));
      if(resultado.kind!=="sent" && resultado.kind!=="already_sent") throw new Error(`message_${resultado.kind}`);
      enviados++;
      await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
        kind: "sent",
      },undefined,job.id,jobClaim);
      await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      logger.warn("[dev.pipeline] envio inline falhou", { error: message });
      await settle(job.organization_id,job.id,jobClaim.acquired_at,err instanceof StaleServiceBoundaryError,message,err instanceof AgendaDeferredError?err:undefined);
    }
  }
  return enviados;
}
