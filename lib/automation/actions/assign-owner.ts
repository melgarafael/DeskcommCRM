/**
 * Ação `assign_owner` — valida membership ativa na org (tabela
 * `user_organizations`, `revoked_at is null`, role acima de viewer — doutrina
 * G3-04: responsável tem que ser atendente ativo) e seta owner_user_id +
 * assigned_at do lead do contexto.
 *
 * A consulta de membro tem três respostas, não duas: é membro; não é membro
 * (`user_not_in_org`); e não deu para saber — a consulta falhou por rede/banco
 * (`membro_indeterminado`, falha transitória, com a mensagem da consulta em
 * `detail.erro` para o suporte). As duas últimas não se confundem: dizer
 * `user_not_in_org` quando a infraestrutura caiu manda o operador mexer no que
 * está certo.
 *
 * Modo rodízio (`{ modo: "rodizio", fila }`, #2041): ver `executarRodizio`.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";

/** O que `fn_automation_rodizio_atribuir` devolve: quem recebeu, ou o motivo de ninguém. */
type DesfechoDoRodizio =
  | { user_id: string; posicao: number }
  | { motivo: "sem_rodizio" | "fila_vazia" | "ninguem_disponivel" | "lead_nao_encontrado" };

/**
 * Modo rodízio (#2041). A escolha, o registro da vez e a gravação do dono
 * acontecem na função SQL, numa transação só, com trava por regra: se o
 * registro ficasse aqui, depois da RPC, dois leads simultâneos leriam o mesmo
 * "último" e iriam para a mesma pessoa. A fila também é lida lá, da regra
 * gravada — esta ação só passa QUAL regra e QUAL lead, e traduz o desfecho.
 */
async function executarRodizio(ctx: ActionCtx, leadId: string): Promise<ActionResultDetail> {
  const { data, error } = await ctx.admin.rpc("fn_automation_rodizio_atribuir", {
    p_org: ctx.organizationId,
    p_rule: ctx.ruleId,
    p_lead: leadId,
    // O mesmo evento reprocessado devolve a mesma pessoa em vez de andar a fila.
    p_event: ctx.event.id,
  });
  if (error) return { type: "assign_owner", status: "failed", error: error.message };
  const desfecho = data as DesfechoDoRodizio | null;
  if (desfecho && "user_id" in desfecho) {
    const { data: pessoa } = await ctx.admin.auth.admin.getUserById(desfecho.user_id);
    // ponytail: sem nome no perfil, o começo do id — o dono já foi gravado, e a
    // frase é informação: falhar aqui esconderia uma atribuição que aconteceu.
    const nome = (pessoa?.user?.user_metadata?.full_name as string | undefined) ?? desfecho.user_id.slice(0, 8);
    return {
      type: "assign_owner",
      status: "success",
      detail: {
        user_id: desfecho.user_id,
        posicao: desfecho.posicao,
        nome,
        explicacao: `Vez de ${nome}, posição ${desfecho.posicao} da fila do rodízio.`,
      },
    };
  }
  switch (desfecho?.motivo) {
    case "ninguem_disponivel":
      return { type: "assign_owner", status: "skipped", detail: { reason: "ninguem_disponivel" } };
    case "fila_vazia":
      return { type: "assign_owner", status: "skipped", detail: { reason: "fila_vazia" } };
    case "lead_nao_encontrado":
      return { type: "assign_owner", status: "failed", error: "lead_nao_encontrado" };
    default:
      // `sem_rodizio`: a regra gravada não tem mais o rodízio (foi editada entre
      // o evento e a execução) — ou a função devolveu algo que não sabemos ler.
      return { type: "assign_owner", status: "failed", error: "sem_rodizio" };
  }
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  if (config.modo === "rodizio") {
    const lead = ctx.context.lead as { id: string } | undefined;
    if (!lead) return { type: "assign_owner", status: "skipped", detail: { reason: "missing_input" } };
    return executarRodizio(ctx, lead.id);
  }
  const userId = typeof config.user_id === "string" ? config.user_id : null;
  const lead = ctx.context.lead as { id: string } | undefined;
  if (!userId || !lead) return { type: "assign_owner", status: "skipped", detail: { reason: "missing_input" } };

  const { data: member, error: erroDaConsulta } = await ctx.admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", ctx.organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (erroDaConsulta) {
    // A consulta de membro também pode NÃO VOLTAR (rede, banco fora). Isso não é
    // "não é membro": culpar a configuração do operador por uma queda de
    // infraestrutura manda ele mexer no que está certo. Falha fechada na ação,
    // aberta na informação — código transitório e a mensagem do erro.
    return {
      type: "assign_owner",
      status: "failed",
      error: "membro_indeterminado",
      detail: { reason: "membro_indeterminado", erro: erroDaConsulta.message },
    };
  }
  if (!member) return { type: "assign_owner", status: "failed", error: "user_not_in_org" };
  if (member.role === "viewer") {
    // Mesma régua do bulk-assign (G3-04 invalid_owner): viewer não atende.
    return { type: "assign_owner", status: "failed", error: "invalid_owner" };
  }

  const patchResult = resolveOwnerPatch({ owner_user_id: userId });
  if (!patchResult.ok || !patchResult.patch) {
    return { type: "assign_owner", status: "failed", error: "invalid_owner" };
  }

  const { error } = await ctx.admin
    .from("crm_leads")
    .update({
      ...patchResult.patch,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "assign_owner", status: "failed", error: error.message };
  return { type: "assign_owner", status: "success", detail: { user_id: userId } };
}

registerAction({ type: "assign_owner", execute });
