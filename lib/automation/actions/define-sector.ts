/**
 * Ação `define_sector` (#3881) — a automação coloca a conversa num SETOR de
 * atendimento.
 *
 * ─── Por que ela existe ────────────────────────────────────────────────────
 *
 * A 9062 fez do setor o DESTINO da distribuição: a conversa com `sector_id` só
 * vai para quem atende aquele setor. Mas a única forma de gravar era o gesto
 * humano na tela, uma conversa por vez. A triagem que a agência de viagens
 * descreve na issue — "pedido de pagamento/boleto → Financeiro", "tag
 * fornecedor → Recepção" — não tinha por onde existir.
 *
 * ─── Uma regra, uma porta ──────────────────────────────────────────────────
 *
 * Esta ação NÃO faz `update` em `conversations`: ela chama
 * `definirSetorDaConversa`, a mesma régua que a rota humana e a ferramenta da
 * IA usam. Lá moram a conferência de que o setor existe NESTA organização, a
 * recusa de conversa encerrada, a precedência do setor definido à mão e a
 * auditoria `conversation.sector_changed` com "de qual setor para qual".
 *
 * ─── Qual conversa? ───────────────────────────────────────────────────────
 *
 * O motor hidrata `context.lead` e `context.contact` — nunca a conversa. Então
 * a conversa vem do EVENTO quando ele a traz (`payload.conversation_id`, o
 * caminho de `message.received`) e, quando não traz, é a conversa ABERTA mais
 * recente do contato do evento. As duas escolhas aparecem no `detail` da
 * execução (`conversa_de`), para a Atividade não virar caixa-preta.
 *
 * ─── Sem laço, de propósito ────────────────────────────────────────────────
 *
 * Mudar o setor grava `conversations.sector_id` e, no máximo, enfileira a
 * distribuição (`fn_request_channel_routing`). Nenhum dos dois emite um
 * gatilho de automação: o motor só escuta os eventos de
 * `ENTIDADE_ESPERADA_POR_GATILHO` (lead, mensagem, contato, compromisso), e
 * esta ação NÃO chama `emit_event`. Uma regra "mensagem com boleto → Financeiro"
 * roda uma vez por mensagem porque cada mensagem é um evento novo — não porque
 * a mudança de setor redispara a si mesma. E repetir a mesma chamada é
 * idempotente: a régua devolve `mudou: false` e não audita de novo.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { definirSetorDaConversa } from "@/lib/atendimento/setor-da-conversa";
import { logger } from "@/lib/logger";

/** Os status em que a conversa ainda aceita ser classificada. */
const STATUS_ENCERRADOS = ["closed", "archived"] as const;

/** O que o evento pode entregar de graça — o caminho de `message.received`. */
function conversaDoEvento(ctx: ActionCtx): string | null {
  const doPayload = ctx.event.payload?.conversation_id;
  return typeof doPayload === "string" ? doPayload : null;
}

/**
 * A conversa aberta mais recente do contato. Só quando o evento não traz a
 * conversa (negócio, contato, compromisso): sem isso, a regra "campo
 * `tipo_viagem` = Internacional → setor Internacional" não teria onde gravar,
 * porque o evento de negócio não conhece a conversa.
 */
async function conversaAbertaDoContato(ctx: ActionCtx, contactId: string): Promise<string | null> {
  const { data, error } = await ctx.admin
    .from("conversations")
    .select("id, status, last_message_at")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .not("status", "in", `(${STATUS_ENCERRADOS.join(",")})`)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn("[automation.define_sector] não foi possível ler a conversa do contato", {
      organization_id: ctx.organizationId,
      contact_id: contactId,
      error: error.message,
    });
    return null;
  }
  return (data as { id?: string } | null)?.id ?? null;
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const sectorId = typeof config.sector_id === "string" ? config.sector_id : null;
  if (!sectorId) {
    // Ação sem destino salva no editor e falha no disparo é a regra quebrada que
    // ninguém percebe; a falha é NOMEADA para o operador corrigir a regra.
    return { type: "define_sector", status: "failed", error: "sector_id_ausente" };
  }

  const doEvento = conversaDoEvento(ctx);
  const contactId = (ctx.context.contact as { id?: string } | undefined)?.id ?? null;
  const conversaId = doEvento ?? (contactId ? await conversaAbertaDoContato(ctx, contactId) : null);
  if (!conversaId) {
    // Negócio sem contato, contato sem conversa: não há onde gravar. Ignorar é
    // honesto — inventar uma conversa (ou pular para o setor do contato) seria
    // trocar de alvo em silêncio.
    return { type: "define_sector", status: "skipped", detail: { reason: "sem_conversa" } };
  }

  const resultado = await definirSetorDaConversa({
    // Service role: a regra não tem sessão. Quem autoriza é o motor (regra
    // criada por manager+) e a régua confere organização, conversa e setor.
    db: ctx.admin,
    organizationId: ctx.organizationId,
    conversationId: conversaId,
    sectorId,
    origem: "automacao",
    sobrescreverSetorManual: config.sobrescrever_setor_manual === true,
    ator: { tipo: "automacao", id: ctx.ruleId },
    requestId: ctx.requestId,
  });

  if (!resultado.ok) {
    // Recusa NOMEADA, com o motivo no run e na Atividade: setor inexistente,
    // conversa encerrada e setor definido à mão são coisas diferentes, e o
    // operador precisa saber qual delas a regra bateu. Sem `explicacao` aqui: ela
    // venceria o mapa MOTIVO_DA_PARADA da Atividade, e a frase da régua não é
    // traduzida — quem lê em espanhol leria português.
    const detalhe: Record<string, unknown> = {
      conversa_id: conversaId,
      conversa_de: doEvento ? "evento" : "contato",
      motivo: resultado.motivo,
    };
    const statusDaRecusa = resultado.motivo === "conversa_nao_encontrada" ? "skipped" : "failed";
    return {
      type: "define_sector",
      status: statusDaRecusa,
      error: resultado.motivo,
      detail: detalhe,
    };
  }

  return {
    type: "define_sector",
    status: "success",
    detail: {
      conversa_id: conversaId,
      conversa_de: doEvento ? "evento" : "contato",
      de: resultado.de,
      para: resultado.para,
      mudou: resultado.mudou,
      redistribuiu: resultado.redistribuiu,
      explicacao: resultado.mudou
        ? "A conversa foi classificada no setor da regra."
        : "A conversa já estava neste setor — nada mudou.",
    },
  };
}

registerAction({ type: "define_sector", execute });
