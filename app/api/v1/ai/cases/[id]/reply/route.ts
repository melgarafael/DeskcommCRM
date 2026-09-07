import { withServiceBoundary } from "@/lib/atendimento/fronteira-server";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { registrarRespostaDeCasoObsoleto } from "@/lib/atendimento/aviso-caso-obsoleto";
import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/cases/:id/reply — a ação do humano sobre um caso aberto
 * (spec 15 §7/§9, Wave 5). Três ações: `resolved` (fecha e repassa ao lead),
 * `need_lead_info` (pede algo ao lead e reabre a re-entrada do agente) e
 * `escalate` (fecha o caso e aciona o handoff humano de verdade).
 *
 * As transições do repositório (`lib/agent-engine/agent/human-cases.ts`) e
 * `enqueueJob`/`performHumanHandoff` rodam sobre `pg.Pool` (mundo do engine),
 * não supabase-js — reusa o singleton lazy `getRequestPool()` criado na Onda
 * 5.1 (mesmo pool do draft-reply). A leitura do caso (404/estado/ids) roda no
 * MESMO pool para não divergir do que as transições veem.
 *
 * ids (conversation_id/contact_id) resolvidos AQUI a partir do caso — nunca do
 * body. O único estado de entrada aceito é `awaiting_human`: qualquer outro
 * (terminal OU aguardando o lead) devolve 409 `invalid_state`, espelhando a
 * precondição das próprias funções de transição (não pisar em estado errado).
 *
 * Transição e efeito andam juntos: `resolved`/`need_lead_info` fecham transição +
 * enqueue no mesmo commit, e `escalate` roda o handoff (idempotente) antes de
 * fechar o caso. As duas escolhas existem pelo mesmo motivo — nenhuma falha no
 * meio pode deixar um caso fora de `awaiting_human` sem o efeito prometido,
 * porque esse estado não tem caminho de volta pela API (viraria 409 eterno).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import {
  resolveCaseFromHuman,
  markAwaitingLead,
  escalateCase,
  buildCaseSummary,
} from "@/lib/agent-engine/agent/human-cases";
import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    action: z.enum(["resolved", "need_lead_info", "escalate"]),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();

const NEW_STATUS: Record<z.infer<typeof bodySchema>["action"], string> = {
  resolved: "resolved",
  need_lead_info: "awaiting_lead",
  escalate: "escalated",
};

interface CaseRow {
  context_snapshot: Record<string, unknown> | null;
  status: string;
  title: string;
  summary: string;
  blocker: string;
  conversation_id: string;
  contact_id: string | null;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;
  const { id: caseId } = await params;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return fail("invalid_request", t("Body inválido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return fail("validation_failed", t("Body inválido."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { action, body } = parsed.data;

  let pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("unavailable", t("Resposta ao caso indisponível (config)."), 503, { requestId });
  }

  const { rows } = await pool.query<CaseRow>(
    `select ac.status, ac.title, ac.summary, ac.blocker, ac.conversation_id, ac.context_snapshot, conv.contact_id
       from agent_cases ac
       join conversations conv
         on conv.id = ac.conversation_id and conv.organization_id = ac.organization_id
      where ac.organization_id = $1 and ac.id = $2`,
    [org.orgId, caseId],
  );
  const caseRow = rows[0];
  if (caseRow === undefined) {
    return fail("not_found", t("Caso não encontrado."), 404, { requestId });
  }
  if (caseRow.status !== "awaiting_human") {
    return fail(
      "invalid_state",
      t("O caso não está aguardando resposta do atendente (awaiting_human)."),
      409,
      { requestId },
    );
  }
  if (caseRow.contact_id === null) {
    return fail("unprocessable_entity", t("Conversa do caso sem contato associado."), 422, {
      requestId,
    });
  }
  const { conversation_id: conversationId, contact_id: contactId } = caseRow;

  if (action === "escalate") {
    const boundary = parseServiceBoundary(caseRow.context_snapshot?.service_boundary);
    try {
      if (boundary && (boundary.organization_id !== org.orgId || boundary.contact_id !== contactId || boundary.conversation_id !== conversationId)) throw new StaleServiceBoundaryError();
      await withServiceBoundary(pool, boundary, async () => {
    const aviso = await avisarLeadDoCrm(createAdminClient(), {
      organizationId: org.orgId,
      conversationId,
      contactId,
      reason: body,
      serviceBoundary: boundary!,
    });

    // O handoff roda ANTES de fechar o caso, e nesta ordem de propósito: ele é
    // idempotente (re-executar é no-op) e recebe um pg.Pool próprio, então não
    // entra na transação abaixo. Se ele falhar, o caso continua `awaiting_human`
    // e a retentativa se cura sozinha; na ordem inversa sobraria um caso
    // `escalated` que nunca chegou a humano nenhum — e sem volta pela API.
    await performHumanHandoff(
      pool,
      { tenantId: org.orgId, leadId: contactId, conversationId },
      {
        reason: body,
        conversationSummary: buildCaseSummary(caseRow),
        avisoAoLead: aviso,
        log: createLogger(),
      },
    );
      });
    } catch (error) {
      if (!(error instanceof StaleServiceBoundaryError)) throw error;
      // A resposta humana fica registrada, mas não altera o atendimento novo.
      const registered = await registrarRespostaDeCasoObsoleto(pool, org.orgId, caseId, user.id, body);
      if (!registered) return fail("invalid_state", "Este caso já foi respondido por outra pessoa.", 409, { requestId });
      await audit({ action: "ai.case_replied", actorUserId: user.id, organizationId: org.orgId,
        resourceType: "agent_case", resourceId: caseId, requestId, metadata: { case_action: action, service_stale: true } });
      return ok({ status: "resolved", delivery: "service_stale" }, { requestId });
    }
    const escalated = await escalateCase(pool, org.orgId, caseId, user.id, body);
    if (!escalated) {
      // Corrida perdida entre a leitura e o update. O handoff já aconteceu (e é
      // idempotente), então não mentimos dizendo que escalamos: devolvemos o
      // conflito para a UI reler o caso.
      return fail("invalid_state", t("Este caso já foi respondido por outra pessoa."), 409, {
        requestId,
      });
    }
  } else {
    // Transição e enqueue no MESMO commit (mesmo princípio do completeJob do
    // engine): sem isso, um enqueue que falhasse depois da transição deixaria o
    // caso fora de `awaiting_human` e sem job — o lead nunca seria avisado e a
    // API passaria a responder 409, sem caminho de recuperação.
    const client = await pool.connect();
    let transitioned: boolean;
    try {
      await client.query("begin");
      transitioned =
        action === "resolved"
          ? await resolveCaseFromHuman(client, org.orgId, caseId, user.id, body)
          : await markAwaitingLead(client, org.orgId, caseId, user.id, body);
      if (transitioned) {
        await enqueueJob(client, org.orgId, {
          kind: "case_reply_turn",
          leadId: contactId,
          payload: { case_id: caseId, action, body },
        });
        await client.query("commit");
      } else {
        await client.query("rollback");
      }
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    if (!transitioned) {
      return fail("invalid_state", t("Este caso já foi respondido por outra pessoa."), 409, {
        requestId,
      });
    }
  }

  await audit({
    action: "ai.case_replied",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "agent_case",
    resourceId: caseId,
    requestId,
    metadata: { case_action: action },
  });

  return ok({ status: NEW_STATUS[action] }, { requestId });
}
