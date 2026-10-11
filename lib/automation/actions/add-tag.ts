/**
 * Ação `add_tag` — merge idempotente de tags no LEAD do contexto (ou no
 * CONTATO, se o contexto não tiver lead). Emite o próprio evento
 * lead.tag_added/contact.tag_added com metadata.caused_by_rule — é a ação, e
 * não um handler reusado, então é ela quem carrega o anti-loop.
 *
 * ─── #2498 — `config.destino` é OPCIONAL ────────────────────────────────────
 *
 * `card` é o PADRÃO e é o caminho de sempre, byte a byte: lead manda, e sem
 * lead o contato do contexto. `contato` é a escolha nova, para a regra que
 * etiqueta no `lead.created` e quer a marca na CAIXA que o Inbox consulta —
 * ali as duas fontes divergiam: a ação marcava o card, a tela lia o contato.
 *
 * Com `contato` a leitura é NO BANCO, não no contexto: o evento pode trazer
 * `contact.tags` velho (gravado antes da própria regra rodar), e um merge a
 * partir dele regravaria o vocabulário do contato com o que o evento lembra.
 * Preservar as etiquetas ATUAIS é a metade da promessa da issue.
 *
 * Sem contato resolvível (`lead.contact_id` ausente e sem `context.contact`)
 * a ação é IGNORADA — `skipped`/`no_contact`. Trocar de destino em silêncio
 * para o card seria repetir o defeito pelo lado contrário: a regra marcaria o
 * card de quem pediu contato, e ninguém veria por quê.
 *
 * Inalterado de propósito: autorização da IA, mensagens, gatilhos e as
 * consultas do Inbox (nenhum join novo — a tela continua lendo o que sempre
 * leu, e é o destino da escrita que passa a escolher a caixa certa).
 */
import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

type Destino = "card" | "contato";

type LinhaDeAlvo = { id: string; tags?: string[] };

type Alvo = {
  table: "crm_leads" | "contacts";
  row: LinhaDeAlvo;
  event: "lead.tag_added" | "contact.tag_added";
  kind: "crm_lead" | "contact";
};

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  if (!tags.length) return { type: "add_tag", status: "skipped", detail: { reason: "no_tags" } };

  // Sem a chave (regra antiga) ou com `card`, o caminho é o de sempre.
  const destino: Destino = config.destino === "contato" ? "contato" : "card";

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;

  let target: Alvo | null = null;
  if (destino === "contato") {
    // O contato do LEAD primeiro (é o vínculo que a issue pede); o do contexto
    // cobre o evento que chega sem lead — aí "contato" já é o alvo natural.
    const contactId = lead?.contact_id ?? contact?.id;
    if (!contactId) return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    const { data, error } = await ctx.admin
      .from("contacts")
      .select("id, tags")
      .eq("id", contactId)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (error) return { type: "add_tag", status: "failed", error: error.message };
    if (!data) return { type: "add_tag", status: "skipped", detail: { reason: "no_contact" } };
    target = {
      table: "contacts",
      row: data as LinhaDeAlvo,
      event: "contact.tag_added",
      kind: "contact",
    };
  } else {
    target = lead
      ? { table: "crm_leads", row: lead, event: "lead.tag_added", kind: "crm_lead" }
      : contact
        ? { table: "contacts", row: contact, event: "contact.tag_added", kind: "contact" }
        : null;
    if (!target) return { type: "add_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const prev = target.row.tags ?? [];
  const added = tags.filter((t) => !prev.includes(t));
  if (!added.length) return { type: "add_tag", status: "success", detail: { added: [] } };

  const contactId =
    target.table === "contacts" ? target.row.id : (lead?.contact_id ?? contact?.id);
  const serviceOrigin = contactId
    ? await originFromAutomationEvent(ctx, contactId)
    : null;
  const merged = [...prev, ...added];
  const { error } = await ctx.admin
    .from(target.table)
    .update({ tags: merged, updated_at: new Date().toISOString() })
    .eq("id", target.row.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "add_tag", status: "failed", error: error.message };

  await ctx.admin.rpc("emit_event", {
    p_event_type: target.event,
    p_entity_kind: target.kind,
    p_entity_id: target.row.id,
    p_payload: { added_tags: added, tags: merged, service_origin: serviceOrigin },
    p_metadata: { caused_by_rule: ctx.ruleId },
    p_organization_id: ctx.organizationId,
  });
  return { type: "add_tag", status: "success", detail: { added } };
}

registerAction({ type: "add_tag", execute });
