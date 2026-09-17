import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
/**
 * Ação `create_or_move_lead` — reusa os handlers core de /api/v1/leads
 * (mesmo caminho que REST/MCP) em vez de duplicar a lógica de criação/move.
 *
 * Actor = `webhook_source` com id = ruleId (ator automático; audit registra
 * actor_type=webhook_source). requestId = `rule:${ruleId}` — os handlers
 * propagam esse valor pro metadata.request_id dos eventos que emitem, e é
 * esse prefixo "rule:" que o engine (Task 8) usa pra não reprocessar os
 * eventos derivados (anti-loop profundidade 1: regra→ação→handler→evento).
 */
import { registerAction } from "@/lib/automation/actions";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const pipelineId = typeof config.pipeline_id === "string" ? config.pipeline_id : null;
  const stageId = typeof config.stage_id === "string" ? config.stage_id : null;
  if (!pipelineId || !stageId) {
    return { type: "create_or_move_lead", status: "failed", error: "missing_config" };
  }

  const handlerCtx: HandlerCtx = {
    organization_id: ctx.organizationId,
    actor: { type: "webhook_source", id: ctx.ruleId },
    requestId: `rule:${ctx.ruleId}`,
  };
  const lead = ctx.context.lead as { id: string; pipeline_id: string; contact_id?: string } | undefined;
  const contact = ctx.context.contact as
    | { id: string; name?: string | null; display_name?: string | null; phone_number?: string | null }
    | undefined;

  const contactId = contact?.id ?? lead?.contact_id;
  handlerCtx.serviceOrigin = contactId
    ? (await originFromAutomationEvent(ctx, contactId)) ?? { kind: "unavailable", reason: "origin_capture_failed" }
    : { kind: "unavailable", reason: "origin_capture_failed" };

  try {
    if (lead) {
      if (lead.pipeline_id !== pipelineId) {
        return { type: "create_or_move_lead", status: "failed", error: "cross_pipeline_move_not_allowed" };
      }
      const movido = await moveLeadHandler(ctx.admin, handlerCtx, lead.id, { to_stage_id: stageId });
      publicaNoContexto(ctx, movido, contactId);
      return { type: "create_or_move_lead", status: "success", detail: { moved: lead.id } };
    }
    if (contact) {
      // Gatilho de CONTATO não traz lead no contexto (`lib/automation/engine.ts`),
      // e sem isto a ação chamada de "criar/mover" só sabia criar: o contato
      // ganhava um negócio novo a cada vez que a regra rodava (#958). O negócio
      // procurado é o ABERTO no funil de destino — negócio de outro funil segue
      // fora, pela mesma regra que recusa mover entre funis.
      const existente = await negocioAbertoDoContato(ctx, contact.id, pipelineId);
      if (existente) {
        const movido = await moveLeadHandler(ctx.admin, handlerCtx, existente, { to_stage_id: stageId });
        publicaNoContexto(ctx, movido, contact.id);
        return { type: "create_or_move_lead", status: "success", detail: { moved: existente } };
      }
      const created = await createLeadHandler(ctx.admin, handlerCtx, {
        pipeline_id: pipelineId,
        stage_id: stageId,
        // O título nasce do MESMO resolvedor das telas. Remontado à mão, ele
        // gravava `Contato 543134@lid` no card do funil — e título de lead
        // não se reescreve sozinho depois.
        title: nomeDoContato(contact) ?? contact.phone_number ?? "Lead da automação",
        contact_id: contact.id,
        source: "automation",
      } as Parameters<typeof createLeadHandler>[2]);
      publicaNoContexto(ctx, created, contact.id);
      return { type: "create_or_move_lead", status: "success", detail: { created: String(created.id) } };
    }
    return { type: "create_or_move_lead", status: "skipped", detail: { reason: "no_lead_or_contact" } };
  } catch (err) {
    return {
      type: "create_or_move_lead",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * O negócio ABERTO do contato neste funil, se houver um.
 *
 * Só o funil de destino: o contato pode ter negócio em outro funil, e mover
 * entre funis é recusado logo acima. Falha de leitura devolve `null` — a ação
 * então cria, que é o comportamento de antes deste conserto.
 */
async function negocioAbertoDoContato(
  ctx: ActionCtx,
  contactId: string,
  pipelineId: string,
): Promise<string | null> {
  const { data } = await ctx.admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * As ações seguintes da MESMA regra passam a enxergar o lead.
 *
 * `assign_owner` lê `ctx.context.lead` e, num gatilho de contato, devolvia
 * `skipped: missing_input` mesmo depois de esta ação ter criado o negócio —
 * a execução inteira aparecia como "Parcial" na aba Atividade (#958). As
 * condições da regra já foram avaliadas quando isto roda (`engine.ts` filtra
 * `applicable` antes do laço), então escrever aqui não muda o que casou.
 */
function publicaNoContexto(ctx: ActionCtx, row: Record<string, unknown>, contactId?: string): void {
  // A LINHA INTEIRA, mesclada com o que já havia no contexto — nunca um objeto
  // com três campos. `add_tag` lê `ctx.context.lead.tags` como "as tags do
  // banco" e grava `[...prev, ...added]`: com um objeto parcial, `prev` é `[]`
  // e o UPDATE APAGA as tags existentes do negócio, inclusive a de anúncio que
  // `lib/leads/nascimento-do-lead.ts` grava. `call_webhook` projeta o mesmo
  // objeto sobre LEAD_PUBLIC_FIELDS, então o corpo entregue ao endpoint do
  // cliente encolheria em silêncio pelo mesmo motivo.
  const anterior = (ctx.context.lead ?? {}) as Record<string, unknown>;
  ctx.context.lead = {
    ...anterior,
    ...row,
    contact_id: row.contact_id ?? contactId ?? anterior.contact_id ?? null,
  };
}

registerAction({ type: "create_or_move_lead", execute });
