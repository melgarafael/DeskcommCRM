/**
 * Ação `apply_task_plan` — aplicar um PLANO de tarefas ao negócio (#1752).
 *
 * A sequência mora em `organizations.settings.task_plans` e toda a regra
 * (leitura, idempotência, ordem, marca na timeline) mora em
 * `lib/tarefas/plano.ts`, junto do caminho que a tela vai usar quando a
 * cadastros existir — dois executores escritos à mão divergiriam no primeiro
 * ajuste, e a divergência aqui é invisível: os dois "aplicam o plano", só que
 * um deles duplica tarefa.
 *
 * O `detail` diz o que o operador precisa para depurar a regra: quantas
 * tarefas nasceram, ou que a aplicação já tinha acontecido (aí o `status`
 * segue `success` — repetir a regra não é erro, é o contrato da
 * idempotência).
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { aplicarPlanoDeTarefas } from "@/lib/tarefas/plano";

async function execute(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  const planoId = typeof config.plano_id === "string" ? config.plano_id.trim() : "";

  const lead = ctx.context.lead as { id: string } | undefined;

  if (!planoId) {
    return { type: "apply_task_plan", status: "skipped", detail: { reason: "missing_input" } };
  }
  if (!lead) {
    return { type: "apply_task_plan", status: "skipped", detail: { reason: "no_target" } };
  }

  const resultado = await aplicarPlanoDeTarefas(ctx.admin, {
    organizationId: ctx.organizationId,
    leadId: lead.id,
    planoId,
    origem: `automation:${ctx.ruleId}`,
    requestId: ctx.requestId,
  });

  if (!resultado.ok) {
    // Mesma régua do `create_task`: falha de INSERT/leitura é `failed` (infra,
    // reenviar adianta); plano inexistente, negócio sem dono ou sem alvo são
    // recusa de CONFIGURAÇÃO — dizer "failed" ensinaria o operador a reenviar
    // uma regra que nunca vai funcionar como está.
    if (resultado.codigo === "falha") {
      return { type: "apply_task_plan", status: "failed", error: resultado.erro ?? "falha" };
    }
    return {
      type: "apply_task_plan",
      status: "skipped",
      detail: { reason: resultado.codigo },
    };
  }

  return {
    type: "apply_task_plan",
    status: "success",
    detail: {
      plano_id: planoId,
      ja_aplicado: resultado.ja_aplicado,
      tarefas: resultado.tarefa_ids.length,
      task_ids: resultado.tarefa_ids,
    },
  };
}

registerAction({ type: "apply_task_plan", execute });
