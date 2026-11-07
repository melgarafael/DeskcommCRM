/**
 * Ação `set_lead_date_field` — a data do atendimento vira um campo de DATA do
 * negócio (issue #3727).
 *
 * ═══ O PROBLEMA QUE ELA RESOLVE, E O QUE ELA NÃO FAZ ═══
 *
 * A clínica precisa falar com quem fez toxina daqui a 120 dias. O produto já
 * sabe agir "N dias depois de uma data do funil" — é o gatilho
 * `lead.date_field_due` (#989), com varredura no relógio
 * (`app/api/v1/cron/lead-date-field-due`), rearme por VALOR da data (#1540) e
 * recusa de campo de contato. O que faltava era só a PRIMEIRA ponta: ninguém
 * gravava a data do atendimento, então o operador tinha de digitar no card, e
 * atendimento marcado por fora do agente nunca era digitado.
 *
 * Esta ação NÃO espera: ela grava e sai. Quem espera é a regra de data, que já
 * existe e já sabe contar dias para trás (`dias` negativo). A espera mora no
 * CAMPO, não numa execução pendente — e é isso que deixa o desenho barato e
 * honesto: nenhum evento fica meses em fila, nenhum follow-up fica vivo
 * ocupando a vaga de "um follow-up vivo por contato"
 * (`idx_followup_enrollments_one_live`), e remarcar o atendimento rearma o
 * aviso sozinho, porque a chave de disparo do gatilho de data leva o valor.
 *
 * ═══ POR QUE UM CAMPO DE DATA DO NEGÓCIO, E NÃO DO CONTATO ═══
 *
 * A varredura lê `crm_leads.custom_fields`; campo de escopo `contato` mora em
 * `contacts.custom_fields` e a regra de data o RECUSA na porta
 * (`lib/automation/campo-do-gatilho-de-data.ts`). Então a lista oferecida é a
 * mesma `camposDeDataDoNegocio` dos seletores, e a execução CONFERE de novo
 * aqui: chave renomeada ou transformada em texto gravaria num campo que a
 * varredura nunca lê — a regra existiria, o dia chegaria e nada sairia, em
 * silêncio. Recusar com `campo_nao_e_data` é o desfecho honesto.
 *
 * ═══ QUAL DIA ═══
 *
 * O dia do relógio da ORGANIZAÇÃO, nunca o do servidor (UTC): a varredura
 * compara com `diaLocal`, no fuso do tenant (`lib/automation/cron-de-data.ts`).
 * Um compromisso às 23h30 de Brasília é 02h30 UTC do dia seguinte, e gravar
 * `2026-03-10` onde a clínica lê `09/03` adiaria a mensagem em um dia — o
 * defeito silencioso que este arquivo existe para não repetir.
 *
 * ═══ O NEGÓCIO ALVO ═══
 *
 * O evento `appointment.completed` traz o COMPROMISSO e o CONTATO, não o
 * negócio (`buildContext`, lib/automation/engine.ts) — o compromisso não tem
 * `lead_id`. Por isso: o negócio do evento, quando ele é do funil escolhido; e,
 * quando não é, o card ABERTO do contato naquele funil, pelo degrau que a
 * automação e a captação já compartilham (`negocioAbertoDoContato`). Sem nenhum
 * dos dois a ação é IGNORADA (`sem_negocio_aberto`), e não cria card: criar
 * card é a ação `create_or_move_lead`, com a etapa que só quem montou a regra
 * sabe.
 *
 * ═══ A ESCRITA É A FUNÇÃO DO BANCO ═══
 *
 * `fn_lead_anotar_campos` (migration 0502) faz `custom_fields || $1` numa única
 * instrução: a segunda escrita concorrente recalcula sobre a linha vigente.
 * Montar o merge aqui (`{ ...lead.custom_fields, [campo]: data }`) é o defeito
 * que a 0502 consertou — a foto do contexto é de quando o evento nasceu, e duas
 * regras do mesmo evento gravariam uma por cima da outra.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { audit } from "@/lib/audit";
import { diaLocal, fusoDaOrganizacao } from "@/lib/automation/cron-de-data";
import { camposDeDataDoNegocio } from "@/lib/leads/campos-do-funil";
import { negocioAbertoDoContato } from "@/lib/leads/negocio-aberto-do-contato";
import { logger } from "@/lib/logger";

const TIPO = "set_lead_date_field";

type ComTexto = { [chave: string]: unknown };

/** String aparada, ou `""` — o `jsonb` do contexto não promete tipo nenhum. */
function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * O fuso que vale para a organização.
 *
 * Leitura que falha NÃO cala a ação: cai no padrão do produto
 * (`fusoDaOrganizacao(null)`), com um aviso no log — a mesma doutrina da janela
 * de envio (`janela-do-canal.ts`), porque um fuso ilegível não pode impedir a
 * data de ser gravada e o aviso de sair. O que não se faz é decidir pelo
 * relógio do servidor em silêncio.
 */
async function fusoDaOrganizacaoDa(ctx: ActionCtx): Promise<string> {
  const { data, error } = await ctx.admin
    .from("organizations")
    .select("timezone")
    .eq("id", ctx.organizationId)
    .maybeSingle();
  if (error) {
    logger.warn("[automation.set-lead-date-field] fuso da organização ilegível — usando o padrão", {
      organization_id: ctx.organizationId,
      rule_id: ctx.ruleId,
      error: error.message,
    });
    return fusoDaOrganizacao(null);
  }
  return fusoDaOrganizacao((data as { timezone?: string | null } | null)?.timezone);
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const pipelineId = texto(config.pipeline_id);
  const campo = texto(config.campo);
  if (!pipelineId || !campo) {
    return { type: TIPO, status: "skipped", detail: { reason: "missing_config" } };
  }

  // ─── A data vem do COMPROMISSO, e só dele ────────────────────────────────
  //
  // Sem compromisso no contexto a ação não tem o que gravar. Recusar é melhor
  // que gravar "hoje": a regra que dispara em `lead.won` também quer lembrar o
  // cliente, mas ali a data que vale não é a do atendimento, e um campo com a
  // data errada manda a mensagem no mês errado, meses depois, sem ninguém
  // ligar uma coisa à outra.
  const compromisso = ctx.context.appointment as ComTexto | undefined;
  const inicio = texto(compromisso?.starts_at);
  if (!inicio) {
    return { type: TIPO, status: "skipped", detail: { reason: "sem_compromisso" } };
  }
  const instante = Date.parse(inicio);
  if (Number.isNaN(instante)) {
    return { type: TIPO, status: "skipped", detail: { reason: "data_do_compromisso_ilegivel" } };
  }

  const fuso = await fusoDaOrganizacaoDa(ctx);
  let data: string;
  try {
    data = diaLocal(new Date(instante), fuso);
  } catch {
    // `partesNoFuso` lança em fuso inexistente (o campo digitado errado em
    // Configurações). Cair no padrão do produto erra o dia em horas de
    // fronteira, mas calar a ação erra o aviso inteiro — e o aviso no log diz
    // que foi isso.
    logger.warn("[automation.set-lead-date-field] fuso inválido — usando o padrão", {
      organization_id: ctx.organizationId,
      rule_id: ctx.ruleId,
      fuso,
    });
    data = diaLocal(new Date(instante), fusoDaOrganizacao(null));
  }

  // ─── Qual negócio ───────────────────────────────────────────────────────
  const lead = ctx.context.lead as ComTexto | undefined;
  const leadDoEvento =
    texto(lead?.id) && texto(lead?.pipeline_id) === pipelineId ? texto(lead?.id) : "";
  const contatoDoEvento =
    texto((ctx.context.contact as ComTexto | undefined)?.id) ||
    texto(lead?.contact_id) ||
    texto(compromisso?.contact_id);

  let leadId = leadDoEvento;
  if (!leadId) {
    if (!contatoDoEvento) {
      return { type: TIPO, status: "skipped", detail: { reason: "sem_contato" } };
    }
    const aberto = await negocioAbertoDoContato(
      ctx.admin,
      ctx.organizationId,
      contatoDoEvento,
      pipelineId,
    );
    if (!aberto) {
      return { type: TIPO, status: "skipped", detail: { reason: "sem_negocio_aberto" } };
    }
    leadId = aberto.id;
  }

  // ─── O campo tem de ser DATA do NEGÓCIO neste funil ──────────────────────
  const { data: funil, error: erroFunil } = await ctx.admin
    .from("crm_pipelines")
    .select("settings")
    .eq("id", pipelineId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (erroFunil) {
    return { type: TIPO, status: "failed", error: erroFunil.message };
  }
  const settings = (funil as { settings?: Record<string, unknown> | null } | null)?.settings ?? null;
  if (!camposDeDataDoNegocio(settings).some((definicao) => definicao.key === campo)) {
    return { type: TIPO, status: "skipped", detail: { reason: "campo_nao_e_data" } };
  }

  // ─── A escrita ──────────────────────────────────────────────────────────
  const { data: gravado, error } = await ctx.admin.rpc("fn_lead_anotar_campos", {
    p_org: ctx.organizationId,
    p_lead: leadId,
    p_campos: { [campo]: data },
  });
  if (error) {
    return { type: TIPO, status: "failed", error: error.message };
  }
  // Nulo = negócio inexistente OU de outra organização: nada foi lido, nada foi
  // gravado, e a ação não anuncia alteração que não houve.
  if (gravado === null || gravado === undefined) {
    return { type: TIPO, status: "skipped", detail: { reason: "sem_negocio" } };
  }

  // Muta o card, então audita — o DoD do repo pede audit em mutação relevante, e
  // este caminho não passa pelo `updateLeadHandler`, que é quem audita o PATCH.
  await audit({
    action: "lead.updated",
    organizationId: ctx.organizationId,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId: ctx.requestId,
    metadata: {
      origem: "automacao",
      regra_id: ctx.ruleId,
      regra: ctx.ruleName,
      campos: { [campo]: data },
      data_do_compromisso: inicio,
    },
  });

  return {
    type: TIPO,
    status: "success",
    detail: { lead_id: leadId, campo, data },
  };
}

registerAction({ type: TIPO, execute });
