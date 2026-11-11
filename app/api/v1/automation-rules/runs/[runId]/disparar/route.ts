import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/automation-rules/runs/[runId]/disparar — dispara o que a
 * automação SEGUROU porque a IA mexeu no modo assistido (doc 301 = B,
 * `lib/automation/parada-no-assistido.ts`). É o botão do aviso na Central.
 *
 * Só as ações paradas daquele run, contra o evento original, pelos MESMOS
 * executores do motor e com a MESMA pré-checagem (`postponeUntil`: janela de
 * envio, limite do dia, agenda). Fora da janela nada sai: 409
 * `dispatch_postponed` com a hora, e o aviso volta a ficar aberto.
 *
 * Disparo único: a trava é o próprio aviso. Quem o vira de aberto para
 * resolvido é quem dispara; o segundo clique (ou o aviso já descartado com
 * "Marcar resolvido") recebe 409 e nada sai duas vezes. Grava um run NOVO com
 * o resultado, cada ação apontando para o run parado em
 * `detail.dispatched_from_run_id`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import "@/lib/automation/actions/register-all";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAction } from "@/lib/automation/actions";
import { buildContext, statusDoRun } from "@/lib/automation/engine";
import { MOTIVO_PARADA_NO_ASSISTIDO, REF_DO_AVISO_DE_PARADA } from "@/lib/automation/parada-no-assistido";
import { falhaDeExecucaoParaRecibo, resultadosParaRecibo } from "@/lib/automation/resultado-para-recibo";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const { runId } = await ctx.params;
  if (!UUID_RX.test(runId)) return fail("invalid_request", t("Run não encontrado."), 400, { requestId });

  const admin = createAdminClient();

  // A TRAVA: virar o aviso de aberto para resolvido. Quem vira, dispara.
  const { data: travados, error: travaErr } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", activeOrg.orgId)
    .eq("kind", "other")
    .eq("ref_kind", REF_DO_AVISO_DE_PARADA)
    .eq("ref_id", runId)
    .in("status", ["open", "ack"])
    .select("id");
  if (travaErr) return fail("internal_error", travaErr.message, 500, { requestId });
  const avisoId = (travados ?? [])[0]?.id as string | undefined;
  if (!avisoId) {
    return fail(
      "state_conflict",
      t("Não há nada parado para disparar neste aviso: ele já foi disparado ou descartado."),
      409,
      { requestId },
    );
  }
  const reabrir = async () => {
    await admin.from("agent_inbox_items").update({ status: "open" }).eq("id", avisoId).eq("organization_id", activeOrg.orgId);
  };

  try {
    const supabase = await createClient();
    const { data: run, error: runErr } = await supabase
      .from("automation_rule_runs")
      .select("id, rule_id, event_id, contact_id, actions_result")
      .eq("id", runId)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    if (!run) {
      await reabrir();
      return fail("not_found", t("Run não encontrado."), 404, { requestId });
    }
    if (!run.event_id) {
      await reabrir();
      return fail("event_gone", t("O evento original deste run foi removido."), 409, { requestId });
    }

    const { data: rule, error: ruleErr } = await supabase
      .from("automation_rules")
      .select("id, name, actions")
      .eq("id", run.rule_id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (ruleErr) throw new Error(ruleErr.message);
    if (!rule) {
      await reabrir();
      return fail("not_found", t("Regra do run não encontrada."), 404, { requestId });
    }

    // O recibo tem um resultado por ação, na ordem de `rule.actions`. Se a regra
    // mudou desde então, a posição pode apontar para outra ação — e disparar
    // a ação errada é pior que não disparar.
    const acoesDaRegra = (rule.actions ?? []) as RuleAction[];
    const recibo = (run.actions_result ?? []) as ActionResultDetail[];
    const paradas = recibo
      .map((r, indice) => ({ r, indice }))
      .filter(({ r }) => r.error === MOTIVO_PARADA_NO_ASSISTIDO);
    if (!paradas.length || paradas.some(({ r, indice }) => acoesDaRegra[indice]?.type !== r.type)) {
      await reabrir();
      return fail(
        "state_conflict",
        t("A automação mudou depois que a ação ficou parada. Abra a automação e confira antes de disparar."),
        409,
        { requestId },
      );
    }

    const { data: eventRow, error: eventErr } = await supabase
      .from("event_log")
      .select("*")
      .eq("id", run.event_id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (eventErr) throw new Error(eventErr.message);
    if (!eventRow) {
      await reabrir();
      return fail("event_gone", t("O evento original deste run foi removido."), 409, { requestId });
    }
    const evento = eventRow as unknown as EventRow;
    const context = await buildContext(admin, evento);
    const serviceBoundaries = new Map<string, Promise<ServiceBoundary>>();
    const base = (indice: number): ActionCtx => ({
      admin,
      serviceBoundaries,
      organizationId: activeOrg.orgId,
      ruleId: rule.id as string,
      ruleName: (rule.name as string) ?? "Automação",
      event: evento,
      context,
      requestId: evento.id,
      actionIndex: indice,
      ruleActions: acoesDaRegra,
    });

    // A mesma pré-checagem do motor, para TODAS antes de executar qualquer uma.
    let puloPelaAgenda: { appointment_id: string | null } | undefined;
    for (const { indice } of paradas) {
      const acao = acoesDaRegra[indice]!;
      const until = await getAction(acao.type)?.postponeUntil?.(
        { ...base(indice), anotarPuloPelaAgenda: (appointmentId) => (puloPelaAgenda = { appointment_id: appointmentId }) },
        acao.config ?? {},
      );
      if (until) {
        await reabrir();
        return fail(
          "dispatch_postponed",
          t("Agora está fora da janela de envio deste número (ou no limite do dia). Nada foi enviado; tente depois do horário indicado."),
          409,
          { requestId, details: { retry_at: until } },
        );
      }
    }

    const results: ActionResultDetail[] = [];
    for (const { indice } of paradas) {
      const acao = acoesDaRegra[indice]!;
      const executor = getAction(acao.type);
      let resultado: ActionResultDetail;
      if (!executor) {
        resultado = { type: acao.type, status: "failed", error: "unknown_action" };
      } else {
        try {
          resultado = await executor.execute({ ...base(indice), puloCongeladoPelaAgenda: puloPelaAgenda }, acao.config ?? {});
        } catch (err) {
          resultado = falhaDeExecucaoParaRecibo(acao.type, err);
        }
      }
      results.push({ ...resultado, detail: { ...resultado.detail, dispatched_from_run_id: runId } });
    }

    const { data: novoRun, error: insErr } = await admin
      .from("automation_rule_runs")
      .insert({
        organization_id: activeOrg.orgId,
        rule_id: rule.id,
        event_id: evento.id,
        contact_id: run.contact_id ?? null,
        status: statusDoRun(results),
        actions_result: resultadosParaRecibo(results),
      })
      .select("*")
      .single();
    if (insErr || !novoRun) {
      // O que tinha de sair já saiu: reabrir o aviso convidaria a disparar de novo.
      return fail("internal_error", insErr?.message ?? "run_insert_failed", 500, { requestId });
    }

    void audit({
      action: "automation.held_actions_dispatched",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "automation_rule_run",
      resourceId: novoRun.id,
      requestId,
      metadata: { held_run_id: runId, rule_id: rule.id, action_types: paradas.map(({ r }) => r.type) },
    });

    return ok(novoRun, { requestId, status: 201 });
  } catch (err) {
    await reabrir();
    return fail("internal_error", err instanceof Error ? err.message : String(err), 500, { requestId });
  }
}
