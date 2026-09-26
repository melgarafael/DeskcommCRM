/**
 * Ação `create_task` — o lembrete interno da automação (#1540).
 *
 * Grava `crm_tasks`, audita e avisa o responsável pelo MESMO caminho do
 * `push.handler` (`enviarPushAoUsuario`) — só que dirigido ao dono da tarefa e
 * não ao canal. Nada aqui chega ao cliente: o título é lido por uma pessoa na
 * tela de tarefas.
 *
 * Toda a regra (placeholders, prazo, atribuição, audit, push) mora em
 * `lib/tarefas/criar-tarefa.ts`, que esta ação e o nó `internal_task` dos
 * fluxos compartilham — dois executores da mesma operação escritos à mão
 * divergiriam no primeiro ajuste, e a divergência aqui é invisível: os dois
 * "criam tarefa", só que um esquece o audit.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { criarTarefaInterna, type AtribuicaoDaTarefa } from "@/lib/tarefas/criar-tarefa";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const titulo = typeof config.titulo === "string" ? config.titulo : "";
  const venceEmDias = typeof config.vence_em_dias === "number" ? config.vence_em_dias : null;
  const prioridade = typeof config.prioridade === "string" ? config.prioridade : null;
  const atribuirA = atribuicao(config.atribuir_a);

  const lead = ctx.context.lead as { id: string } | undefined;
  const contact = ctx.context.contact as { id: string } | undefined;

  if (!titulo || venceEmDias === null || !atribuirA || !prioridade) {
    return { type: "create_task", status: "skipped", detail: { reason: "missing_input" } };
  }
  if (!lead && !contact) {
    return { type: "create_task", status: "skipped", detail: { reason: "no_target" } };
  }

  const resultado = await criarTarefaInterna(ctx.admin, {
    organizationId: ctx.organizationId,
    titulo,
    venceEmDias,
    atribuirA,
    prioridade: prioridade as "low" | "medium" | "high" | "urgent",
    leadId: lead?.id ?? null,
    contactId: contact?.id ?? null,
    descricao: `Regra: ${ctx.ruleName}`,
    origem: `automation:${ctx.ruleId}`,
    requestId: ctx.requestId,
  });

  if (!resultado.ok) {
    // `sem_dono`/`titulo_vazio` são recusa de CONFIGURAÇÃO e não falha de
    // infra: dizer "failed" com mensagem de rede ensinaria o operador a
    // reenviar uma regra que nunca vai funcionar como está.
    return {
      type: "create_task",
      status: "skipped",
      detail: { reason: resultado.codigo, ...(resultado.erro ? { erro: resultado.erro } : {}) },
    };
  }

  return {
    type: "create_task",
    status: "success",
    detail: { task_id: resultado.tarefa_id, assigned_to: resultado.assigned_to },
  };
}

/** `dono_do_lead` (nominal) ou `{ usuario_id }` — o resto é configuração torta. */
function atribuicao(bruto: unknown): AtribuicaoDaTarefa | null {
  if (bruto === "dono_do_lead") return "dono_do_lead";
  if (bruto && typeof bruto === "object" && !Array.isArray(bruto)) {
    const usuarioId = (bruto as { usuario_id?: unknown }).usuario_id;
    if (typeof usuarioId === "string" && usuarioId.trim()) {
      return { usuario_id: usuarioId.trim() };
    }
  }
  return null;
}

registerAction({ type: "create_task", execute });
