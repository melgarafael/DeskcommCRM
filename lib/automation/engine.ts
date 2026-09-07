import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
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

/**
 * Grava a linha do adiamento — a única evidência de que a regra casou e está
 * esperando.
 *
 * Um run por adiamento, e não um por tique do drain: o evento só volta na hora
 * marcada por `retry_at`, então não há repetição a cada minuto. Se a janela
 * seguir fechada quando ele voltar, sai outra linha — e aí a repetição É a
 * informação (a automação está presa há três dias).
 *
 * Fire-and-forget quanto a erro: perder o registro não pode impedir o
 * adiamento, que é o que protege o número.
 */
async function registrarAdiamento(
  admin: SupabaseClient,
  row: EventRow,
  rule: RuleRow,
  actionType: string,
  retryAt: string,
): Promise<void> {
  const { error } = await admin.from("automation_rule_runs").insert({
    organization_id: row.organization_id,
    rule_id: rule.id,
    event_id: row.id,
    status: "adiado",
    actions_result: [
      {
        type: actionType,
        status: "postponed",
        detail: {
          reason: "fora_da_janela_de_envio",
          retry_at: retryAt,
          explicacao:
            "A regra casou e está esperando a janela de envio do número reabrir — nada foi tentado ainda.",
        },
      },
    ],
  });
  if (error) {
    logger.error("[automation.engine] não foi possível registrar o adiamento", {
      rule_id: rule.id,
      organization_id: row.organization_id,
      error: error.message,
    });
  }
}

export async function runAutomationForEvent(
  admin: SupabaseClient,
  row: EventRow,
): Promise<HandlerResult> {
  const serviceBoundaries = new Map<string, Promise<ServiceBoundary>>();
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
        { admin, serviceBoundaries, organizationId: row.organization_id, ruleId: rule.id, ruleName: rule.name, event: row, context, requestId: row.id },
        action.config ?? {},
      );
      if (until) {
        // A ESPERA É UM ESTADO, e um estado que ninguém vê é indistinguível de
        // morte. Sem esta linha o evento sumia até a janela reabrir e a aba
        // Atividade não mostrava NADA — para quem montou a regra, "não apareceu
        // nada" e "não rodou" são a mesma tela (migration 0175).
        await registrarAdiamento(admin, row, rule, action.type, until);
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
            { admin, serviceBoundaries, organizationId: row.organization_id, ruleId: rule.id, ruleName: rule.name, event: row, context, requestId: row.id },
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

    // ═══ O AGREGADOR TAMBÉM PRECISA DIZER A VERDADE ═══
    //
    // `failed === 0 ? "success"` fazia uma ação `postponed` — mensagem que ficou
    // em `queued` e NÃO chegou ao cliente — virar "Sucesso" verde na tela. É o
    // MESMO defeito que `desfecho-do-envio.ts` existe para matar, ressurgindo
    // um nível acima: a ação passou a ser honesta e quem soma continuava
    // mentindo. Conserto por instância, não por classe.
    //
    // Achado por revisão adversarial, com o cenário alcançável: instalação sem
    // o transporte de WhatsApp configurado (o caso de TODA instalação nova), a
    // janela aberta, `postponeUntil` devolve null, a ação executa, e o envio
    // termina em `queued` com `queued_reason`. É exatamente o estado congelado
    // em `tests/invariants/automation-send-whatsapp.test.ts` caso 2.
    //
    // A MESMA mentira reapareceu de novo, um degrau abaixo: `status ===
    // "skipped"` (guarda-do-contato.ts — sem contato, bloqueado, sem telefone,
    // OU sem consentimento) também não era `failed` nem `postponed`, então caía
    // no `else` e virava "Sucesso" — pra uma mensagem que nunca foi NEM
    // TENTADA. Achado pelo e2e `tests/e2e/automacao-diz-a-verdade.spec.ts`: um
    // lead de webhook genérico (sem Respondi, sem pergunta de consentimento)
    // nunca tem `consent.marketing.granted_at`, então TODO envio automático
    // pra um lead assim batia no gate de consentimento — e a tela dizia
    // "Sucesso" pra um envio que nem chegou a discar o WhatsApp. Pior que o
    // defeito original: aquele pelo menos tinha TENTADO.
    //
    // `skipped` entra junto de `failed` na contagem: as duas significam "não
    // saiu, e não é a fila que vai resolver sozinha" — a diferença entre elas
    // (uma tentou e não conseguiu, a outra nem tentou) é o `reason`/`error` que
    // a ação já registra, não o status agregado.
    //
    // A ordem importa: falha (+ skip) vence adiamento. Uma regra em que uma
    // ação falhou/pulou e outra ficou esperando é `partial` — quem lê precisa
    // saber que algo quebrou, não que está tudo a caminho.
    const naoEnviadas = results.filter((r) => r.status === "failed" || r.status === "skipped").length;
    const adiados = results.filter((r) => r.status === "postponed").length;
    const status =
      naoEnviadas > 0
        ? naoEnviadas === results.length
          ? "failed"
          : "partial"
        : adiados > 0
          ? "adiado"
          : "success";
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
