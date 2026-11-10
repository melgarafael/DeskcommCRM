/**
 * Ação `add_tag` — a junção das etiquetas acontece DENTRO do banco (issue #2888).
 *
 * ─── Por que a escrita saiu do aplicativo ──────────────────────────────────
 *
 * O PR #2864 fez esta ação reler `tags` antes de mesclar, e isso consertou o caso
 * que a correção pública jmpo/DeskcommCRM#89 descreve: o motor monta o contexto
 * UMA vez por evento, todas as regras daquele evento recebem a mesma foto, e a
 * segunda gravação apagava o que a primeira tinha acabado de gravar.
 *
 * O que a releitura NÃO fecha é o caso de dois EVENTOS DIFERENTES ao mesmo tempo
 * sobre a mesma linha. Eles não são hipótese: o `event_log` tem dois drenos
 * concorrentes (o laço do agent-worker e o cron `event-log-drain`) e o claim é
 * exclusivo por LINHA, não por negócio — dois eventos distintos do mesmo negócio
 * rodam um em cada dreno, em paralelo:
 *
 *     dreno A: select tags --> (janela) --> update lista_lida + etiqueta_A
 *     dreno B:       select tags --> update lista_lida + etiqueta_B
 *
 * As duas leem a MESMA lista; a última sobrescreve a coluna com a foto que leu
 * mais as suas etiquetas, e a etiqueta da outra some sem erro e sem log. Ler
 * "mais fresquinho" só estreita a janela; não a fecha.
 *
 * ─── O que passou a acontecer ──────────────────────────────────────────────
 *
 * A junção vai para dentro da instrução `UPDATE`, numa função SQL por tabela
 * (`fn_lead_adicionar_etiquetas` / `fn_contato_adicionar_etiquetas`, migration
 * 0682): `tags = tags || array(select unnest(p_etiquetas) except select
 * unnest(tags))` com `RETURNING tags`. Em READ COMMITTED quem chega depois
 * ESPERA o commit da linha e RECALCULA sobre a linha vigente — soma sobre o que
 * a outra gravou em vez de sobre o que leu antes. Mesma saída da 0502
 * (`custom_fields`) e da 0673 (excluir uma etiqueta preserva as outras).
 *
 * Por isso esta ação NÃO lê mais `tags` para montar a lista: não há lista
 * montada aqui. O que ela usa é o que o `RETURNING` devolveu — `data.tags` é o
 * que ficou gravado (o `tag_added` anunciado) e `data.adicionadas` é o que ESTA
 * chamada acrescentou de fato, que é o que decide se há evento (evitar evento à
 * toa é o mesmo cuidado de antes) e o que alimenta `event.added_tags`.
 *
 * ─── Nada de mudar o dreno, o claim nem o agendamento ──────────────────────
 *
 * A corrida é da escrita e é ali que ela se resolve; serializar a automação por
 * negócio custaria a fila inteira de toda instalação para pagar por um defeito
 * que a linha resolve. O anti-laço (`caused_by_rule`) e o tipo do evento não
 * mudam.
 *
 * ─── #2498 — `config.destino` é OPCIONAL ───────────────────────────────────
 *
 * `card` é o PADRÃO e é o alvo de sempre: lead manda, e sem lead o contato do
 * contexto. `contato` é a escolha nova, para a regra que etiqueta no
 * `lead.created` e quer a marca na CAIXA que o Inbox consulta — ali as duas
 * fontes divergiam: a ação marcava o card, a tela lia o contato.
 *
 * Em `contato` a linha alvo é `lead.contact_id`, com o contato do contexto como
 * segunda opção — e quem decide se ela existe é a própria função, que devolve
 * nulo para linha de outra organização. Sem contato resolvível a ação é
 * IGNORADA (`skipped`/`no_contact`): trocar de destino em silêncio para o card
 * seria repetir o defeito pelo lado contrário.
 *
 * Inalterado de propósito: autorização da IA, mensagens, gatilhos e as consultas
 * do Inbox (nenhum join novo — a tela continua lendo o que sempre leu, e é o
 * destino da escrita que escolhe a caixa certa).
 */
import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

type Destino = "card" | "contato";

/** A função SQL que faz a junção na linha alvo — uma por tabela (migration 0682). */
type RpcDaJuncao = "fn_lead_adicionar_etiquetas" | "fn_contato_adicionar_etiquetas";

type Alvo = {
  table: "crm_leads" | "contacts";
  id: string;
  event: "lead.tag_added" | "contact.tag_added";
  kind: "crm_lead" | "contact";
  rpc: RpcDaJuncao;
  /** A foto do CONTEXTO, quando o alvo é ela mesma (card manda) — é ela que as
   *  próximas regras do mesmo evento enxergam. */
  foto?: { tags?: string[] };
};

/** O que a função devolve: o que ficou GRAVADO e o que ESTA chamada acrescentou. */
type RetornoDaJuncao = { tags?: unknown; adicionadas?: unknown };

function lista(valor: unknown): string[] {
  return Array.isArray(valor) ? valor.map(String) : [];
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  if (!tags.length) return { type: "add_tag", status: "skipped", detail: { reason: "no_tags" } };

  const destino: Destino = config.destino === "contato" ? "contato" : "card";

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;

  let target: Alvo;
  if (destino === "contato") {
    // O contato do LEAD primeiro (é o vínculo que a issue pede); o do contexto
    // cobre o evento que chega sem lead — aí "contato" já é o alvo natural.
    const contactId = lead?.contact_id ?? contact?.id;
    if (!contactId) return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    target = {
      table: "contacts",
      id: contactId,
      event: "contact.tag_added",
      kind: "contact",
      rpc: "fn_contato_adicionar_etiquetas",
    };
  } else if (lead) {
    target = {
      table: "crm_leads",
      id: lead.id,
      event: "lead.tag_added",
      kind: "crm_lead",
      rpc: "fn_lead_adicionar_etiquetas",
      foto: lead,
    };
  } else if (contact) {
    target = {
      table: "contacts",
      id: contact.id,
      event: "contact.tag_added",
      kind: "contact",
      rpc: "fn_contato_adicionar_etiquetas",
      foto: contact,
    };
  } else {
    return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  // ─── A escrita: UMA chamada, e nada dela é calculado aqui ────────────────
  //
  // A junção acontece no `UPDATE` da função, sobre a linha vigente. Mandar a
  // lista pronta (como antes) é o que perdia a etiqueta do evento concorrente.
  const parametros =
    target.table === "contacts"
      ? { p_org: ctx.organizationId, p_contato: target.id, p_etiquetas: tags }
      : { p_org: ctx.organizationId, p_lead: target.id, p_etiquetas: tags };

  const { data, error } = await ctx.admin.rpc(target.rpc, parametros);
  if (error) return { type: "add_tag", status: "failed", error: error.message };

  // Nulo = linha inexistente OU de outra organização: nada foi lido, nada foi
  // gravado, e a ação não anuncia alteração que não houve.
  if (data === null || data === undefined) {
    if (destino === "contato") return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const retorno = data as RetornoDaJuncao;
  const merged = lista(retorno.tags);
  const added = lista(retorno.adicionadas);

  // A foto do contexto carrega o que o banco devolveu como gravado.
  if (target.foto) target.foto.tags = merged;

  // Já tinha todas: não houve escrita (a função devolve `adicionadas` vazio sem
  // tocar na linha) e não há evento a anunciar.
  if (!added.length) return { type: "add_tag", status: "success", detail: { added: [] } };

  const contactId =
    target.table === "contacts" ? target.id : (lead?.contact_id ?? contact?.id);
  const serviceOrigin = contactId
    ? await originFromAutomationEvent(ctx, contactId)
    : null;

  const metadata: Record<string, unknown> = {};
  if (ctx.ruleId) metadata.caused_by_rule = ctx.ruleId;
  await ctx.admin.rpc("emit_event", {
    p_event_type: target.event,
    p_entity_kind: target.kind,
    p_entity_id: target.id,
    p_payload: { added_tags: added, tags: merged, service_origin: serviceOrigin },
    p_metadata: metadata,
    p_organization_id: ctx.organizationId,
  });
  return { type: "add_tag", status: "success", detail: { added } };
}

registerAction({ type: "add_tag", execute });
