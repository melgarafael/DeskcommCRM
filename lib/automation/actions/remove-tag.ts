/**
 * Ação `remove_tag` — a irmã da `add_tag` no sentido contrário: TIRA etiquetas
 * do card ou do contato.
 *
 * ─── A escrita é do banco, como na `add_tag` ───────────────────────────────
 *
 * A lista é refeita DENTRO do `UPDATE`, numa função SQL por tabela
 * (`fn_lead_remover_etiquetas` / `fn_contato_remover_etiquetas`, migration
 * 0768). Ler `tags` aqui e gravar "a lista menos as pedidas" repetiria a corrida
 * da #2888 do outro lado: os dois drenos do `event_log` processam eventos
 * distintos do mesmo negócio em paralelo, e a gravação de um devolveria a
 * etiqueta que o outro tirou (ou apagaria a que o outro pôs). A ação só usa o
 * que a função devolve: `tags` (o que ficou gravado) e `removidas` (o que ESTA
 * chamada tirou de fato).
 *
 * A comparação é pela chave canônica (`lower(btrim(...))`), feita no banco:
 * tirar "VIP" tira "vip". Tirar nunca cria variante, então casar pela chave é
 * seguro aqui.
 *
 * ─── Destino: a mesma semântica da `add_tag` (#2498) ───────────────────────
 *
 * `card` (padrão) é o lead do contexto, e sem lead o contato do contexto.
 * `contato` é o contato do lead (`lead.contact_id`), com o do contexto como
 * segunda opção; sem contato resolvível a ação é IGNORADA (`no_contact`), nunca
 * troca de destino em silêncio.
 *
 * ─── Sem evento ────────────────────────────────────────────────────────────
 *
 * A `add_tag` emite `*.tag_added` porque há gatilho que o consome. Não existe
 * gatilho `*.tag_removed`, e evento sem consumidor é o anti-pattern 3 do
 * CLAUDE.md. O rastro é o detalhe da execução (`removed`), na aba Atividade.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

type Destino = "card" | "contato";

type Alvo = {
  table: "crm_leads" | "contacts";
  id: string;
  rpc: "fn_lead_remover_etiquetas" | "fn_contato_remover_etiquetas";
  /** A foto do CONTEXTO, quando o alvo é ela mesma — as próximas regras do mesmo evento a enxergam. */
  foto?: { tags?: string[] };
};

type RetornoDaRemocao = { tags?: unknown; removidas?: unknown };

function lista(valor: unknown): string[] {
  return Array.isArray(valor) ? valor.map(String) : [];
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String).filter((t) => t.trim() !== "") : [];
  if (!tags.length) return { type: "remove_tag", status: "skipped", detail: { reason: "no_tags" } };

  const destino: Destino = config.destino === "contato" ? "contato" : "card";

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;

  let target: Alvo;
  if (destino === "contato") {
    const contactId = lead?.contact_id ?? contact?.id;
    if (!contactId) return { type: "remove_tag", status: "skipped", detail: { reason: "no_contact" } };
    target = {
      table: "contacts",
      id: contactId,
      rpc: "fn_contato_remover_etiquetas",
      foto: contact && contact.id === contactId ? contact : undefined,
    };
  } else if (lead) {
    target = { table: "crm_leads", id: lead.id, rpc: "fn_lead_remover_etiquetas", foto: lead };
  } else if (contact) {
    target = { table: "contacts", id: contact.id, rpc: "fn_contato_remover_etiquetas", foto: contact };
  } else {
    return { type: "remove_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const parametros =
    target.table === "contacts"
      ? { p_org: ctx.organizationId, p_contato: target.id, p_etiquetas: tags }
      : { p_org: ctx.organizationId, p_lead: target.id, p_etiquetas: tags };

  const { data, error } = await ctx.admin.rpc(target.rpc, parametros);
  if (error) return { type: "remove_tag", status: "failed", error: error.message };

  // Nulo = linha inexistente OU de outra organização: nada foi tocado.
  if (data === null || data === undefined) {
    if (destino === "contato") return { type: "remove_tag", status: "skipped", detail: { reason: "no_contact" } };
    return { type: "remove_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const retorno = data as RetornoDaRemocao;
  if (target.foto) target.foto.tags = lista(retorno.tags);
  return { type: "remove_tag", status: "success", detail: { removed: lista(retorno.removidas) } };
}

registerAction({ type: "remove_tag", execute });
