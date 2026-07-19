/**
 * Motor de regras: consome eventos-gatilho do event_log e executa as
 * automation_rules ativas do tenant. Registrado no registry via engine.handler.
 *
 * Anti-loop: eventos com metadata.caused_by_rule OU metadata.request_id
 * prefixado "rule:" não reprocessam (profundidade 1 no v1 — cadeia
 * regra→regra fica pra v2/Task 9, que estampa esse metadata nos eventos que
 * uma ação do motor emite).
 *
 * entity_kind guard: o trigger legado `fn_emit_event_on_lead_change` emite
 * lead.created/lead.stage_changed com entity_kind='lead' (derivado por
 * split_part do event_type), enquanto os handlers desta feature emitem com
 * entity_kind='crm_lead'. Sem este filtro o motor rodaria a regra 2x por
 * mudança de lead (uma vez por linha de event_log duplicada).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { evaluateConditions, type RuleCondition } from "@/lib/automation/conditions";
import { getAction } from "@/lib/automation/actions";
import type { ActionResultDetail } from "@/lib/automation/types";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const AUTOMATION_CONSUMER_KEY = "automation-rules";

const EXPECTED_ENTITY_KIND: Record<string, string> = {
  "lead.created": "crm_lead",
  "lead.stage_changed": "crm_lead",
  "lead.tag_added": "crm_lead",
  "contact.tag_added": "contact",
  "message.received": "message",
};

interface RuleRow {
  id: string;
  name: string;
  conditions: RuleCondition[];
  actions: Array<{ type: string; config?: Record<string, unknown> }>;
}

/** Hidrata o contexto avaliado pelas condições/ações a partir do entity do evento. */
export async function buildContext(admin: SupabaseClient, row: EventRow): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = { event: row.payload };
  // Admin client bypassa RLS — todo lookup filtra organization_id do evento
  // (doutrina multi-tenant; um FK cross-org corrompido nunca vaza pro contexto).
  const org = row.organization_id;
  if (row.entity_kind === "crm_lead" && row.entity_id) {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("*")
      .eq("id", row.entity_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (lead) {
      context.lead = lead;
      if (lead.contact_id) {
        const { data: contact } = await admin
          .from("contacts")
          .select("*")
          .eq("id", lead.contact_id)
          .eq("organization_id", org)
          .maybeSingle();
        if (contact) context.contact = contact;
      }
    }
  } else if (row.entity_kind === "contact" && row.entity_id) {
    const { data: contact } = await admin
      .from("contacts")
      .select("*")
      .eq("id", row.entity_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (contact) context.contact = contact;
  } else if (row.entity_kind === "message" && row.entity_id) {
    const contactId = row.payload.contact_id as string | undefined;
    if (contactId) {
      const { data: contact } = await admin
        .from("contacts")
        .select("*")
        .eq("id", contactId)
        .eq("organization_id", org)
        .maybeSingle();
      if (contact) context.contact = contact;
    }
  }
  return context;
}

export async function runAutomationForEvent(
  admin: SupabaseClient,
  row: EventRow,
): Promise<HandlerResult> {
  const requestId = row.metadata?.request_id;
  const causedByRule =
    Boolean(row.metadata?.caused_by_rule) || (typeof requestId === "string" && requestId.startsWith("rule:"));
  if (causedByRule) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "caused_by_rule" };
  }

  const expectedKind = EXPECTED_ENTITY_KIND[row.event_type];
  if (expectedKind && row.entity_kind !== expectedKind) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "entity_kind_mismatch" };
  }

  const { data: rules, error } = await admin
    .from("automation_rules")
    .select("id, name, conditions, actions")
    .eq("organization_id", row.organization_id)
    .eq("trigger_event", row.event_type)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "error", detail: error.message };
  }
  const matched = (rules ?? []) as unknown as RuleRow[];
  if (!matched.length) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok", detail: "no_rules" };
  }

  const context = await buildContext(admin, row);
  const applicable = matched.filter((r) => evaluateConditions(r.conditions ?? [], context));
  if (!applicable.length) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok", detail: "no_match" };
  }

  // Pré-checagem de postpone (throttle etc.): all-or-nothing ANTES de executar
  // qualquer ação — reexecução parcial no retry seria pior que atraso.
  for (const rule of applicable) {
    for (const action of rule.actions ?? []) {
      const executor = getAction(action.type);
      if (!executor?.postponeUntil) continue;
      const until = await executor.postponeUntil(
        { admin, organizationId: row.organization_id, ruleId: rule.id, event: row, context, requestId: row.id },
        action.config ?? {},
      );
      if (until) {
        return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "retry", retry_at: until };
      }
    }
  }

  for (const rule of applicable) {
    const results: ActionResultDetail[] = [];
    for (const action of rule.actions ?? []) {
      const executor = getAction(action.type);
      if (!executor) {
        results.push({ type: action.type, status: "failed", error: "unknown_action" });
        continue;
      }
      try {
        results.push(
          await executor.execute(
            { admin, organizationId: row.organization_id, ruleId: rule.id, event: row, context, requestId: row.id },
            action.config ?? {},
          ),
        );
      } catch (err) {
        results.push({
          type: action.type,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const failed = results.filter((r) => r.status === "failed").length;
    const status = failed === 0 ? "success" : failed === results.length ? "failed" : "partial";
    const { data: runRow, error: runErr } = await admin
      .from("automation_rule_runs")
      .insert({
        organization_id: row.organization_id,
        rule_id: rule.id,
        event_id: row.id,
        status,
        actions_result: results,
      })
      .select("id")
      .maybeSingle();
    if (runErr) logger.error("[automation.engine] run insert failed", { error: runErr.message });

    // Audit só em falha/partial (spec §9) — não inflar audit em toda run.
    if (status !== "success") {
      void audit({
        action: "automation.rule_executed",
        organizationId: row.organization_id,
        resourceType: "automation_rule_run",
        resourceId: runRow?.id ?? null,
        metadata: { rule_id: rule.id, status, event_type: row.event_type },
      });
    }

    // run_count sem RPC de increment: read-modify-write é aceitável aqui
    // (contador informativo de UI, não invariante).
    const { data: cur } = await admin.from("automation_rules").select("run_count").eq("id", rule.id).maybeSingle();
    await admin
      .from("automation_rules")
      .update({ last_run_at: new Date().toISOString(), run_count: (cur?.run_count ?? 0) + 1 })
      .eq("id", rule.id);
  }

  return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok" };
}
