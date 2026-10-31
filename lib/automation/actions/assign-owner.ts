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
 *
 * ─── A passagem SDR → Closer (#3514) ────────────────────────────────────────
 *
 * Trocar o dono do NEGÓCIO não é trocar o dono do CLIENTE: `contacts.carteira_user_id`
 * e `conversations.assigned_to_user_id` continuavam com quem atendeu antes. Com
 * o negócio no nome do Closer e a carteira no nome do SDR, os avisos de "cliente
 * da sua carteira falou" iam para quem já não atende, o negócio seguinte daquele
 * cliente nascia com o SDR e a conversa seguia com ele.
 *
 * As duas opções (`contato`, `conversas`) são OPT-IN e nascem desligadas: uma
 * automação que hoje só move o negócio não pode começar a mover conversa porque
 * alguém acrescentou uma chave ao schema. Desligadas, o desfecho desta ação é
 * EXATAMENTE o de antes — `{ user_id }`, sem chave nova.
 *
 * As duas passagens usam as portas que já existem, e não um UPDATE direto:
 * `fn_definir_carteira_do_cliente` (a única que grava carteira, agora também com
 * a origem `automacao`) e `fn_conversation_assign` (a mesma do botão Transferir,
 * que grava o evento na mesma transação e revalida o destino como membro
 * ativo), chamada por `fn_passar_conversas_do_contato`. Inventar uma terceira
 * régua de dono é o defeito que a #3479 mediu.
 *
 * As duas opções se sobrepõem, e é de propósito: desde a #3642, passar a
 * CARTEIRA já leva as conversas abertas do dono anterior e as sem dono que a IA
 * não atende. `conversas` acrescenta as que estão com uma TERCEIRA pessoa. As
 * duas ligadas = toda conversa aberta com gente vai para o novo dono.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

/** O que `fn_automation_rodizio_atribuir` devolve: quem recebeu, ou o motivo de ninguém. */
type DesfechoDoRodizio =
  | { user_id: string; posicao: number }
  | { motivo: "sem_rodizio" | "fila_vazia" | "ninguem_disponivel" | "lead_nao_encontrado" };

/** Linha do negócio que a ação precisa — o contexto do motor traz a linha inteira. */
type NegocioDoContexto = { id: string; contact_id?: string | null };

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
    // ponytail: sem nome no perfil, o rótulo da régua (#3023) — o dono já foi gravado, e a
    // frase é informação: falhar aqui esconderia uma atribuição que aconteceu.
    const nome = rotuloDoMembro({
      full_name: pessoa?.user?.user_metadata?.full_name as string | undefined,
      user_id: desfecho.user_id,
    });
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

/** As duas caixas da #3514. Ausente = desligada: é o payload de quem já instalou. */
function opcoesDePassagem(config: Record<string, unknown>): { contato: boolean; conversas: boolean } {
  return { contato: config.contato === true, conversas: config.conversas === true };
}

/**
 * O contato do negócio. O `buildContext` do motor hidrata `context.contact` e
 * `context.lead` da linha do banco, então quase sempre a resposta já está na
 * mão; a consulta é o fallback de quem monta o contexto à mão (teste, Reenviar
 * de evento antigo). `contact_id` presente e NULO é resposta — o negócio não tem
 * contato, e não há o que passar.
 */
async function contatoDoNegocio(ctx: ActionCtx, lead: NegocioDoContexto): Promise<string | null> {
  const doContexto = (ctx.context.contact as { id?: string } | undefined)?.id;
  if (doContexto) return doContexto;
  if (lead.contact_id !== undefined) return lead.contact_id;
  const { data } = await ctx.admin
    .from("crm_leads")
    .select("contact_id")
    .eq("id", lead.id)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  return (data as { contact_id?: string | null } | null)?.contact_id ?? null;
}

/**
 * A carteira do contato (#2591) passa para o novo dono pela porta única.
 *
 * Sem ator humano: a automação não tem sessão. A função aceita `p_actor` nulo
 * SÓ com a origem `automacao` (migration 9057) — é o que separa "o sistema fez,
 * a pedido desta regra" de "uma pessoa fez, com o papel dela". O caminho do
 * humano continua exigindo manager+ e recusando origem `automacao`.
 */
async function passarACarteira(ctx: ActionCtx, contatoId: string, userId: string): Promise<string | null> {
  const { error } = await ctx.admin.rpc("fn_definir_carteira_do_cliente", {
    p_org: ctx.organizationId,
    p_actor: null,
    p_contact: contatoId,
    p_dono: userId,
    p_origem: "automacao",
  });
  return error ? error.message : null;
}

/**
 * As conversas ABERTAS do contato que estão com OUTRA pessoa passam para o novo
 * dono, numa chamada só (migration 9057). A função trava as linhas pelo filtro
 * de "aberta" e chama `fn_conversation_assign` (`reason = 'transfer'`, o botão
 * Transferir) para cada uma — conversa encerrada no meio do caminho não é
 * reaberta — e devolve quantas a atribuição de fato gravou. É tudo ou nada.
 *
 * Conversa SEM dono fica onde está: é fila ou IA atendendo, e `transfer`
 * silencia o bot. (Com `contato` ligado, a carteira já levou as sem dono que a
 * IA não atende — #3642.)
 */
async function passarAsConversas(
  ctx: ActionCtx,
  contatoId: string,
  userId: string,
): Promise<{ movidas: number } | { erro: string }> {
  const { data, error } = await ctx.admin.rpc("fn_passar_conversas_do_contato", {
    p_org: ctx.organizationId,
    p_contact: contatoId,
    p_dono: userId,
  });
  if (error) return { erro: error.message };
  return { movidas: typeof data === "number" ? data : 0 };
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  if (config.modo === "rodizio") {
    const lead = ctx.context.lead as { id: string } | undefined;
    if (!lead) return { type: "assign_owner", status: "skipped", detail: { reason: "missing_input" } };
    return executarRodizio(ctx, lead.id);
  }
  const userId = typeof config.user_id === "string" ? config.user_id : null;
  const lead = ctx.context.lead as NegocioDoContexto | undefined;
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

  const opcoes = opcoesDePassagem(config);
  // Contrato de quem não marcou nada: o desfecho é o de antes da #3514, sem
  // chave nova. "Byte a byte" aqui não é enfeite — é o que permite comparar o
  // comportamento antigo com o novo sem inventar diferença.
  if (!opcoes.contato && !opcoes.conversas) {
    return { type: "assign_owner", status: "success", detail: { user_id: userId } };
  }

  const contatoId = await contatoDoNegocio(ctx, lead);
  if (!contatoId) {
    // O negócio não tem contato: não há carteira nem conversa a passar. Não é
    // falha da automação — é um negócio sem cliente, e o dono do negócio mudou.
    return { type: "assign_owner", status: "success", detail: { user_id: userId, passagem: "sem_contato" } };
  }

  const detalhe: Record<string, unknown> = { user_id: userId };
  let falhouCarteira = false;
  let falhouConversas = false;

  if (opcoes.contato) {
    const erroDaCarteira = await passarACarteira(ctx, contatoId, userId);
    if (erroDaCarteira) {
      falhouCarteira = true;
      detalhe.carteira = "falhou";
      detalhe.erro = erroDaCarteira;
    } else {
      detalhe.carteira = "ok";
    }
  }

  if (opcoes.conversas) {
    const conversas = await passarAsConversas(ctx, contatoId, userId);
    if ("erro" in conversas) {
      falhouConversas = true;
      detalhe.conversas = "falhou";
      // Mensagem do banco: o recibo (`resultadoParaRecibo`) a troca pelo código
      // antes de gravar. A carteira tem prioridade porque veio primeiro.
      if (detalhe.erro === undefined) detalhe.erro = conversas.erro;
    } else {
      detalhe.conversas = { movidas: conversas.movidas };
    }
  }

  // A falha de uma opção não desfaz a outra e não desfaz o negócio — mas também
  // não pode sair daqui como sucesso: quem lê a Atividade precisa saber que a
  // passagem combinada não aconteceu inteira.
  if (falhouCarteira) {
    return { type: "assign_owner", status: "failed", error: "carteira_nao_passou", detail: detalhe };
  }
  if (falhouConversas) {
    return { type: "assign_owner", status: "failed", error: "conversas_nao_passaram", detail: detalhe };
  }
  return { type: "assign_owner", status: "success", detail: detalhe };
}

registerAction({ type: "assign_owner", execute });
