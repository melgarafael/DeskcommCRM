import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/lgpd/anonymize
 *
 * Irreversible cascade nullify (Spec 05 §LGPD). Only `admin` role within the
 * tenant or platform_admin can execute.
 *
 * Cascade (best-effort sequential — no client-side transaction):
 *   1. contacts: nullify PII, set is_anonymized + anonymized_at, rewrite display_name
 *      — roda UMA vez (repeti-la apagaria a data real do exercício do direito)
 *   2. crm_leads + 3. crm_lead_activities: `lib/lgpd/cascata.ts`, idempotentes,
 *      e a MESMA função que o cron `data-retention` usa para completar sozinho
 *      o que ficou pela metade
 *   4. Storage media deletion deferred to EPIC-08 worker
 *
 * Três desfechos em `action`, e não dois: `anonymized` (primeira execução),
 * `resumed` (já constava anonimizado E havia resíduo, redigido agora) e
 * `already_anonymized` (nada faltava). O do meio existia sem nome, e caía em
 * `already_anonymized` — que é a frase que descreve o DEFEITO (issue #310).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import {
  completarRedacaoDoContato,
  houveRedacao,
  type ClienteDaCascata,
} from "@/lib/lgpd/cascata";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lgpdAnonymizeSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  let input;
  try {
    input = await validateRequest(lgpdAnonymizeSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Fetch contact (RLS scoped).
  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    .select("id, organization_id, is_anonymized, anonymized_at")
    .eq("id", input.contact_id)
    .maybeSingle();
  if (selErr) {
    return fail("internal_error", selErr.message, 500, { requestId });
  }
  if (!existing) {
    // Sem `t()` de propósito: o único consumidor (`useAnonymizeContact`) usa
    // `showApiError`, que já traduz `err.message` no FRONTEND — traduzir aqui
    // também exigiria um `loadAuthUser()` extra, redundante com o que
    // `requireRole` já faz logo abaixo, e chegou a quebrar teste que não
    // esperava essa chamada a mais.
    return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }

  // Permission: admin NA ORG DO CONTATO (pode diferir da org ativa do cookie)
  // OR platform_admin. Org do contato vem de query RLS-scoped (fonte confiável).
  const authz = await requireRole("admin", {
    requestId,
    resource: "contact",
    allowPlatformAdmin: true,
    organizationId: existing.organization_id,
  });
  if (!authz.ok) return authz.response;

  // ─── RETOMADA, NÃO PORTA FECHADA ───────────────────────────────────────
  //
  // Aqui havia um early-return que devolvia 200 `already_anonymized` ANTES dos
  // passos 2 e 3. Se o passo 1 já tivesse rodado numa requisição que caiu no
  // meio (timeout de cliente, contêiner reiniciado), os outros dois nunca mais
  // rodavam — e não havia como retomá-los, porque a MESMA checagem que decidia
  // "já foi anonimizado" decidia "não faço mais nada". O botão da tela dizia
  // "já anonimizado" e não fazia nada, e o contato ficava com títulos de lead e
  // atividades PERMANENTEMENTE não redigidos.
  //
  // Isso é violação direta do direito do titular: a cascata promete remover PII
  // de contacts + crm_leads + crm_lead_activities e entregava um terço.
  // (issue #310)
  //
  // O passo 1 continua rodando uma vez só — repetí-lo reescreveria
  // `anonymized_at` e apagaria a data real do exercício do direito, que é o que
  // responde ao prazo legal.
  // O passo transacional adquire o mutex antes de conferir a retomada e escrever.
  // A leitura acima só resolveu organização/autorização; não decide idempotência.
  const { data: stepData, error: c1Err } = await supabase.rpc("fn_lgpd_anonymize_contact", {
    p_organization_id: existing.organization_id,
    p_contact_id: existing.id,
  });
  if (c1Err) {
    if (c1Err.code === "42501") return fail("forbidden", "Sem permissão para anonimizar este contato.", 403, { requestId });
    if (c1Err.code === "P0002") return fail("not_found", "Contato não encontrado.", 404, { requestId });
    if (c1Err.code === "40001") return fail("state_conflict", "O contato está em atualização. Tente novamente.", 409, { requestId });
    return fail("internal_error", `contacts: ${c1Err.message}`, 500, { requestId });
  }
  const step = z.object({ already_anonymized: z.boolean(), anonymized_at: z.string().nullable() }).safeParse(stepData);
  if (!step.success) return fail("internal_error", "Não foi possível confirmar a anonimização.", 500, { requestId });
  const retomada = step.data.already_anonymized;

  // ── Passos 2 e 3 — a MESMA função que o cron de retenção usa ──────────
  //
  // Estavam escritos aqui dentro, e a regra do corte do título passou a ter
  // duas bocas quando o cron ganhou a varredura. Uma correção que entrasse numa
  // e não na outra produziria títulos redigidos de dois jeitos no mesmo banco.
  const redacao = await completarRedacaoDoContato(supabase as unknown as ClienteDaCascata, {
    id: existing.id,
    organizationId: existing.organization_id,
  });
  for (const falha of redacao.falhas) {
    console.error("[lgpd.anonymize]", falha);
  }

  // Emit + audit.
  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.anonymized",
      p_entity_kind: "contact",
      p_entity_id: existing.id,
      p_payload: {
        contact_id: existing.id,
        actor_user_id: user.id,
        justification: input.justification,
      },
      p_metadata: { request_id: requestId },
      p_organization_id: existing.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lgpd.anonymize] emit_event failed", error.message);
    });

  await audit({
    // Uma retomada auditada como execução original mentiria sobre a data em que
    // o direito foi exercido — e é a auditoria que responde ao titular.
    action: retomada ? "lgpd.anonymize_catchup" : "lgpd.anonymize_executed",
    actorUserId: user.id,
    organizationId: existing.organization_id,
    resourceType: "contact",
    resourceId: existing.id,
    requestId,
    metadata: {
      contact_id: existing.id,
      justification: input.justification,
      // O que foi REALMENTE tocado. Era o literal ["contacts","crm_leads",
      // "crm_lead_activities"] — e numa retomada `contacts` não é tocada, e os
      // passos 2 e 3 são best-effort. A linha `lgpd.anonymize_catchup` afirmava
      // ter redigido as três mesmo tendo redigido nenhuma: sucesso declarado
      // sobre trabalho não feito, a mesma classe que esta cascata já pagou uma
      // vez, quando deixava o arquivo no bucket e auditava que o redigira.
      redacted_tables: [...(retomada ? [] : ["contacts"]), ...redacao.tabelas],
      redacted_lead_ids: redacao.leadsRedigidas,
      redacted_activities: redacao.atividadesRedigidas,
      ...(redacao.falhas.length > 0 ? { failures: redacao.falhas } : {}),
      storage_media_deletion: "deferred_epic_08",
    },
  });

  // `action` nos TRÊS desfechos, e o do meio é novo.
  //
  // Antes, uma retomada que redigiu leads e atividades voltava
  // `already_anonymized` — e o diálogo mostrava "Contato já estava
  // anonimizado.", exatamente a frase que descreve o DEFEITO que esta rota
  // conserta. Quem chama não tinha como saber que houve trabalho.
  const desfecho = !retomada ? "anonymized" : houveRedacao(redacao) ? "resumed" : "already_anonymized";

  return ok(
    {
      contact_id: existing.id,
      anonymized_at: step.data.anonymized_at,
      action: desfecho,
      redacted_lead_ids: redacao.leadsRedigidas,
      redacted_activities: redacao.atividadesRedigidas,
    },
    { requestId },
  );
}
