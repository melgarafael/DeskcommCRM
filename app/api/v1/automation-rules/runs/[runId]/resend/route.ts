import { resultadosParaRecibo } from "@/lib/automation/resultado-para-recibo";
import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/automation-rules/runs/[runId]/resend — reexecuta SÓ as ações
 * `call_webhook` da regra do run, contra o evento original (`event_log` do
 * run.event_id). Se o evento foi apagado (FK on delete set null zera
 * event_id) → 409 `event_gone`. Grava um run NOVO com o resultado.
 *
 * Mesma ENTREGA, não uma nova (#1529): o id da entrega é recalculado com a
 * posição da ação na lista inteira da regra e com a própria lista — igual ao do
 * disparo original enquanto as ações não mudarem; mudaram, sai um id novo, e
 * nunca o de outra ação que o receptor já processou —, o
 * número da tentativa continua de onde os runs anteriores do mesmo par
 * (regra, evento) pararam, e cada resultado do run novo aponta para o run
 * clicado em `detail.resent_from_run_id` (jsonb que já existe; sem migration).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildContext } from "@/lib/automation/engine";
import {
  executeCallWebhook,
  idDaEntrega,
  tentativasRegistradas,
} from "@/lib/automation/actions/call-webhook";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ runId: string }>;
}

interface RuleAction {
  type: string;
  config?: Record<string, unknown>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { runId } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();

  const { data: run, error: runErr } = await supabase
    .from("automation_rule_runs")
    .select("id, rule_id, event_id")
    .eq("id", runId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (runErr) return fail("internal_error", runErr.message, 500, { requestId });
  if (!run) return fail("not_found", t("Run não encontrado."), 404, { requestId });

  if (!run.event_id) {
    return fail("event_gone", t("O evento original deste run foi removido."), 409, { requestId });
  }

  const { data: rule, error: ruleErr } = await supabase
    .from("automation_rules")
    .select("id, name, actions")
    .eq("id", run.rule_id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (ruleErr) return fail("internal_error", ruleErr.message, 500, { requestId });
  if (!rule) return fail("not_found", t("Regra do run não encontrada."), 404, { requestId });

  const { data: eventRow, error: eventErr } = await supabase
    .from("event_log")
    .select("*")
    .eq("id", run.event_id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (eventErr) return fail("internal_error", eventErr.message, 500, { requestId });
  if (!eventRow) {
    return fail("event_gone", t("O evento original deste run foi removido."), 409, { requestId });
  }

  const typedEvent = eventRow as unknown as EventRow;
  const context = await buildContext(supabase, typedEvent);

  // O índice é tirado ANTES do filtro: é a posição na lista inteira que compõe
  // o id da entrega, e a da lista filtrada daria outro id para a mesma ação.
  const acoesDaRegra = (rule.actions ?? []) as RuleAction[];
  const callWebhookActions = acoesDaRegra
    .map((action, indice) => ({ action, indice }))
    .filter(({ action }) => action.type === "call_webhook");

  // ─── REENVIAR NADA NÃO É SUCESSO ──────────────────────────────────────────
  //
  // `failed === 0` é VERDADEIRO para lista vazia, e sem esta guarda uma regra
  // que perdeu as ações de webhook (o operador removeu a ação no editor, e o
  // botão "Reenviar" segue renderizado no run antigo) gravava uma linha
  // `status: "success"` com `actions_result: []`. A tela então mostra o toast
  // verde e o badge "Sucesso" com corpo vazio: o operador é informado de um
  // reenvio que não aconteceu.
  //
  // É exatamente a classe de defeito que este PR existe para fechar — a
  // automação dizer que deu certo quando não deu —, e ela reapareceria pela
  // porta nova. 409 e não 200 porque o estado do MUNDO mudou desde o run
  // original: a regra não tem mais o que reenviar, e isso é informação, não
  // erro do chamador.
  if (callWebhookActions.length === 0) {
    return fail(
      "no_actions_to_resend",
      t("Esta automação não tem mais nenhuma ação de webhook — não há o que reenviar."),
      409,
      { requestId },
    );
  }

  // Todos os runs do par (regra, evento), não só o clicado: dois Reenviar
  // seguidos a partir do mesmo run original não podem repetir o Attempt.
  // Dois cliques SIMULTÂNEOS ainda podem — leitura e escrita sem trava —, e
  // isso é aceitável: Attempt é informativo, a chave do receptor é o Delivery.
  const { data: runsDoPar, error: runsErr } = await supabase
    .from("automation_rule_runs")
    .select("actions_result")
    .eq("organization_id", activeOrg.orgId)
    .eq("rule_id", rule.id)
    .eq("event_id", typedEvent.id);
  if (runsErr) return fail("internal_error", runsErr.message, 500, { requestId });

  // Admin real no ctx: o executor decifra config.secret_enc via RPC
  // fn_decrypt_oauth (grant só service_role) — client de sessão falharia e o
  // outbound sairia sem assinatura silenciosamente.
  const adminForActions = createAdminClient();
  const results: ActionResultDetail[] = [];
  for (const { action, indice } of callWebhookActions) {
    const actionCtx: ActionCtx = {
      admin: adminForActions,
      organizationId: activeOrg.orgId,
      ruleId: rule.id,
      ruleName: (rule.name as string) ?? "Automação",
      event: typedEvent,
      context,
      requestId,
      actionIndex: indice,
      ruleActions: acoesDaRegra,
    };
    const entrega = idDaEntrega(typedEvent.id, rule.id, indice, acoesDaRegra);
    const resultado = await executeCallWebhook(actionCtx, action.config ?? {}, {
      primeiraTentativa: tentativasRegistradas(runsDoPar ?? [], entrega) + 1,
    });
    results.push({ ...resultado, detail: { ...resultado.detail, resent_from_run_id: runId } });
  }

  const failed = results.filter((r) => r.status === "failed").length;
  const status = failed === 0 ? "success" : failed === results.length ? "failed" : "partial";

  // RLS: automation_rule_runs é select-only p/ authenticated (escrita é do
  // service_role, como no engine). Org vem do authz — nunca do body.
  const admin = createAdminClient();
  const { data: newRun, error: insErr } = await admin
    .from("automation_rule_runs")
    .insert({
      organization_id: activeOrg.orgId,
      rule_id: rule.id,
      event_id: typedEvent.id,
      status,
      actions_result: resultadosParaRecibo(results),
    })
    .select("*")
    .single();
  if (insErr || !newRun) {
    return fail("internal_error", insErr?.message ?? "run_insert_failed", 500, { requestId });
  }

  void audit({
    action: "automation.run_resent",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule_run",
    resourceId: newRun.id,
    requestId,
    metadata: { original_run_id: runId, rule_id: rule.id },
  });

  return ok(newRun, { requestId, status: 201 });
}
