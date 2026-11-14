/**
 * Doc 301 = B: no modo ASSISTIDO, quando quem mexe é a IA, a automação não fala
 * com o cliente sozinha.
 *
 * O modo assistido promete "nada sai sem alguém aprovar". O Operador passou a
 * organizar o card também no assistido (#4319), e mover o card dispara as
 * automações da etapa — algumas mandam WhatsApp, e-mail, mensagem da IA ou
 * inscrevem numa sequência. Essas quatro ficam PARADAS; o resto da regra
 * (etiqueta, tarefa, aviso à equipe) roda como sempre. A Central ganha um aviso
 * com o que ficou parado, e quem pode disparar decide.
 *
 * QUEM marca o evento é o emissor, no momento da ação: o ator `ai_agent` leva
 * `operation_mode: "assisted"` (montado em `lib/agent-engine/edge/crm/mcp-tools.ts`)
 * e o handler grava `actor_operation_mode` no `metadata`. A marca é do momento:
 * trocar o agente para automático depois não solta o que já ficou parado.
 * Evento sem a marca (pessoa, automático, sistema) segue exatamente como antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

/** As ações que falam com o cliente — a lista literal do doc 301. */
export const ACOES_QUE_FALAM_COM_O_CLIENTE: readonly string[] = [
  "send_whatsapp_message",
  "send_email",
  "send_ai_message",
  "start_message_flow",
];

/** O código gravado no recibo da ação parada (`ActionResultDetail.error`). */
export const MOTIVO_PARADA_NO_ASSISTIDO = "parada_no_assistido";

/** `ref_kind` do aviso: aponta para o run que guarda o que ficou parado. */
export const REF_DO_AVISO_DE_PARADA = "automation_rule_run";

/**
 * O ator leva a marca? A IA no assistido, ou a regra que rodou por causa dela
 * (marca HERDADA, `marcaHerdadaDoEvento`) — sem a herança, a regra A que só
 * move o card emitia um evento limpo, e o que vem depois dele saía.
 */
function atorNoAssistido(actor: Actor): boolean {
  return (actor.type === "ai_agent" || actor.type === "webhook_source") && actor.operation_mode === "assisted";
}

/** O pedaço de `metadata` que o emissor acrescenta quando o ator está no assistido. */
export function marcaDoAssistido(actor: Actor): { actor_operation_mode?: "assisted" } {
  return atorNoAssistido(actor) ? { actor_operation_mode: "assisted" } : {};
}

/**
 * O cabeçalho que leva a marca até o GATILHO do banco. `lead.won`, `lead.lost`,
 * `lead.reopened` e `lead.assigned` só nascem de `fn_emit_event_on_lead_change`
 * (o `emit_event` os recusa vindos do app), e o gatilho não vê o ator — vê a
 * requisição: o PostgREST expõe os cabeçalhos em `request.headers`. Mandar o
 * cabeçalho só deixa a automação MAIS contida (o que fala com o cliente espera
 * aprovação); por isso um cliente que o forje não ganha nada.
 */
export const CABECALHO_DO_ASSISTIDO = "x-actor-operation-mode";

/** Põe o cabeçalho na escrita de `crm_leads` quando o ator está no assistido. */
export function escritaComMarca<B extends { setHeader(nome: string, valor: string): B }>(builder: B, actor: Actor): B {
  return atorNoAssistido(actor) ? builder.setHeader(CABECALHO_DO_ASSISTIDO, "assisted") : builder;
}

export function eventoDaIaNoAssistido(row: Pick<EventRow, "metadata"> | null | undefined): boolean {
  return (row?.metadata as Record<string, unknown> | null | undefined)?.actor_operation_mode === "assisted";
}

/** O que a ação de uma regra herda do evento que a disparou, para pôr no ator dela. */
export function marcaHerdadaDoEvento(row: Pick<EventRow, "metadata"> | null | undefined): { operation_mode?: "assisted" } {
  return eventoDaIaNoAssistido(row) ? { operation_mode: "assisted" } : {};
}

/**
 * A ação fica parada? As quatro da lista, e a `ai_decide` quando ALGUMA opção
 * dela é uma das quatro: o `execute` da decisão chama o executor da opção
 * escolhida direto (`actions/ai-decide.ts`), por fora deste laço.
 */
export function acaoFicaParada(
  row: Pick<EventRow, "metadata">,
  acao: { type: string; config?: Record<string, unknown> | null },
): boolean {
  if (!eventoDaIaNoAssistido(row)) return false;
  if (ACOES_QUE_FALAM_COM_O_CLIENTE.includes(acao.type)) return true;
  if (acao.type !== "ai_decide") return false;
  const opcoes = acao.config?.opcoes;
  return (
    Array.isArray(opcoes) &&
    opcoes.some((o) => {
      const tipo = (o as { acao?: { type?: unknown } } | null)?.acao?.type;
      return typeof tipo === "string" && ACOES_QUE_FALAM_COM_O_CLIENTE.includes(tipo);
    })
  );
}

const NOME_DA_ACAO: Record<string, string> = {
  send_whatsapp_message: "WhatsApp",
  send_email: "e-mail",
  send_ai_message: "mensagem da IA",
  start_message_flow: "sequência",
  ai_decide: "decisão da IA",
};

/**
 * A Central mostra título e corpo como foram gravados (nunca passam por `t()`
 * na tela), então o aviso nasce no idioma da ORGANIZAÇÃO — o mesmo padrão do
 * aviso de etapa (`lib/leads/aviso-de-etapa.handler.ts`).
 */
async function idiomaDaOrganizacao(admin: SupabaseClient, organizationId: string): Promise<Idioma> {
  const { data } = await admin.from("organizations").select("locale").eq("id", organizationId).maybeSingle();
  return normalizarIdioma((data as { locale?: string | null } | null)?.locale);
}

/**
 * Abre o aviso na Central. Fire-and-forget como os outros avisos do motor: um
 * aviso que não entra não desfaz o que a regra já fez — mas vira log de erro,
 * porque sem ele a mensagem parada fica invisível.
 */
export async function avisarAcoesParadas(
  admin: SupabaseClient,
  entrada: { organizationId: string; ruleName: string; runId: string; tipos: readonly string[] },
): Promise<void> {
  const idioma = await idiomaDaOrganizacao(admin, entrada.organizationId);
  const nomes = [...new Set(entrada.tipos.map((t) => (NOME_DA_ACAO[t] ? traduzir(NOME_DA_ACAO[t], idioma) : t)))].join(", ");
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: entrada.organizationId,
    kind: "other",
    severity: "warn",
    title: traduzir("Automação esperando aprovação para falar com o cliente", idioma),
    body: traduzir(
      'Uma ação da IA no modo assistido disparou a automação "{regra}", e o que fala com o cliente ficou parado ({acoes}). O resto da automação já rodou. Dispare se quiser que a mensagem saia; marque como resolvido para descartar.',
      idioma,
    )
      // {acoes} antes: o nome da regra é do cliente e pode conter o marcador.
      .replace("{acoes}", () => nomes)
      .replace("{regra}", () => entrada.ruleName),
    ref_kind: REF_DO_AVISO_DE_PARADA,
    ref_id: entrada.runId,
  });
  if (error) {
    logger.error("[automation] aviso de ação parada no assistido não entrou na Central", {
      organization_id: entrada.organizationId,
      error: error.message,
    });
  }
}

/**
 * O aviso da SEQUÊNCIA parada: o gatilho de follow-up por etapa ou por negócio
 * novo não inscreveu porque a IA mexeu no modo assistido. Sem botão de disparo:
 * quem quiser inscreve pelo painel do contato, que já faz isso.
 */
export async function avisarSequenciaParada(
  admin: SupabaseClient,
  entrada: { organizationId: string; leadId: string; quantas: number },
): Promise<void> {
  const idioma = await idiomaDaOrganizacao(admin, entrada.organizationId);
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: entrada.organizationId,
    kind: "other",
    severity: "warn",
    title: traduzir("Sequência esperando aprovação para falar com o cliente", idioma),
    body: (entrada.quantas === 1
      ? traduzir(
          "Uma ação da IA no modo assistido levou o negócio a um ponto que inscreve o contato em uma sequência de follow-up, e a inscrição ficou parada. Se quiser que a sequência comece, inscreva o contato pelo painel dele na conversa; marque como resolvido para descartar.",
          idioma,
        )
      : traduzir(
          "Uma ação da IA no modo assistido levou o negócio a um ponto que inscreve o contato em {quantas} sequências de follow-up, e a inscrição ficou parada. Se quiser que a sequência comece, inscreva o contato pelo painel dele na conversa; marque como resolvido para descartar.",
          idioma,
        )
    ).replace("{quantas}", String(entrada.quantas)),
    ref_kind: "lead",
    ref_id: entrada.leadId,
  });
  if (error) {
    logger.error("[followup] aviso de sequência parada no assistido não entrou na Central", {
      organization_id: entrada.organizationId,
      error: error.message,
    });
  }
}
