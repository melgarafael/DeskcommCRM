/**
 * O NOME DE QUEM DA EQUIPE ENVIOU (#4031) — o que faz o balão dizer
 * "Atendente · Andreia" em vez de "Atendente".
 *
 * ## Por que isso existe, e por que AQUI
 *
 * `messages.sent_by_user_id` já estava gravado em todo envio humano pelo CRM. O
 * que faltava era o NOME: ele mora em `auth.users.raw_user_meta_data->>'full_name'`,
 * que o PostgREST não expõe (schema `auth`), então nenhuma consulta da tela o
 * alcança. O balão — por decisão de desenho registrada nele mesmo — não faz
 * join: o que não está na linha (nem no payload) não aparece.
 *
 * Duas saídas possíveis:
 *
 *   1. gravar o nome na própria mensagem no ENVIO (é o caminho de
 *      `metadata.ai_actor_name` e `metadata.sent_on_behalf.user_name`). Ficaria
 *      certo para o que sair daqui pra frente e ERRADO para todo o histórico —
 *      justamente as conversas em que o gestor já não sabe quem prometeu o quê —,
 *      e ainda congelaria o nome de solteira de quem se casou;
 *   2. resolver na LEITURA, uma vez por página. É o que o export em PDF já faz
 *      (`app/api/v1/conversations/[id]/export/route.ts` → `nomesDosAtendentes`),
 *      e por isso o rótulo do PDF e o do balão passam a concordar.
 *
 * Escolhemos (2): mesma fonte da verdade (`auth.users`), histórico inteiro
 * coberto, zero mudança no envio.
 *
 * ## Custo — e a razão de o helper ser por PÁGINA
 *
 * `nomesDosAtendentes` deduplica os ids e faz UMA requisição ao GoTrue Admin API
 * por id DISTINTO (não por mensagem). Uma página de 50 mensagens de duas
 * consultoras custa 2 chamadas; uma conversa inteira de uma pessoa custa 1.
 * Chamar isto por bolha seria N requisições por rolagem — por isso o balão só
 * LÊ `sent_by_user_name`, e quem preenche é a rota.
 *
 * ## Por que a rota, e não `_handler.ts`
 *
 * `listMessagesHandler` é compartilhado com as tools MCP (`crm_get_conversation_history`),
 * cujo client é o admin e que já resolve o que precisa por conta própria.
 * Enriquecer dentro do handler pagaria o lookup duas vezes em toda chamada do
 * agente. O mesmo motivo já está escrito em `lib/users/com-nome-do-atendente.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Message } from "@/lib/types/messaging";

import { nomesDosAtendentes, nomesDosAtendentesCom } from "./nome-do-atendente";

/**
 * Os valores de `sent_via` que o balão rotula como PESSOA. É a mesma lista do
 * ramo `senderLabel` em `MessageBubble.tsx` (`user` e `crm`, o default da
 * coluna) — mensagem de IA, automação, sistema, celular ou recebida do cliente
 * não pede nome de atendente, e pedi-lo gastaria requisição para um rótulo que
 * ninguém desenha.
 */
const ROTULADAS_COMO_PESSOA: ReadonlySet<string> = new Set(["user", "crm"]);

/**
 * Esta linha pede NOME de gente? A régua é UMA e mora aqui.
 *
 * Recebida do cliente (`inbound`) não tem autor interno: o `sent_by_user_id` da
 * linha é do sistema que a gravou, não de quem falou, e chamá-lo de "atendente"
 * seria inventar autoria. IA, automação, sistema e celular idem — o rótulo que a
 * tela desenha para elas não é nome de pessoa.
 */
export function mereceNomeDeQuemEnviou(
  m: Pick<Message, "direction" | "sent_via" | "sent_by_user_id">,
): boolean {
  return (
    m.direction === "outbound" &&
    ROTULADAS_COMO_PESSOA.has(m.sent_via) &&
    Boolean(m.sent_by_user_id)
  );
}

export type MensagemComNomeDeQuemEnviou = Message & {
  /** `null` = não resolvido (sem service role, usuário removido, linha sem id). */
  sent_by_user_name: string | null;
};

/**
 * O nome por ID DE MENSAGEM, para quem já tem o admin client na mão (#4077).
 *
 * É a mesma leitura de `comNomeDeQuemEnviou`, com o client de quem chama — o
 * mesmo par que `nome-do-atendente.ts` já expõe (`nomesDosAtendentes` /
 * `nomesDosAtendentesCom`). Existe porque a tool MCP
 * `crm_get_conversation_history` recebe o admin client no contexto (`ctx.supabase`)
 * e não pode abrir um segundo: a regra de vínculo com a organização continua
 * sendo a de `nomesDosAtendentesCom`, uma só.
 *
 * Devolve um mapa `id da mensagem → nome`, com os ids DISTINTOS deduplicados:
 * uma consulta de vínculo por página e um lookup por AUTOR, nunca por mensagem.
 * Quem não merece nome (cliente, IA, automação, sem id) simplesmente não entra no
 * mapa, e o chamador projeta `null`.
 */
export async function nomesDeQuemEnviouCom<
  T extends Pick<Message, "id" | "sent_via" | "sent_by_user_id" | "direction">,
>(
  admin: SupabaseClient,
  orgId: string,
  mensagens: readonly T[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = mensagens.filter(mereceNomeDeQuemEnviou).map((m) => m.sent_by_user_id as string);
  if (ids.length === 0) return out;

  const nomes = await nomesDosAtendentesCom(admin, orgId, ids);
  for (const m of mensagens) {
    if (!mereceNomeDeQuemEnviou(m)) continue;
    out.set(m.id, nomes.get(m.sent_by_user_id as string) ?? null);
  }
  return out;
}

/**
 * Acrescenta `sent_by_user_name` às mensagens de UMA página.
 *
 * Devolve cópias: o array que veio do handler continua intacto (ele é o mesmo
 * objeto que as tools MCP e o invariante de paginação consomem).
 *
 * Nunca lança: `nomesDosAtendentes` já degrada para mapa vazio quando o service
 * role não está configurado ou o lookup falha, e um nome ausente não pode
 * derrubar o histórico — o `sent_by_user_id` continua sendo a verdade, e o
 * rótulo cai em "Atendente".
 */
export async function comNomeDeQuemEnviou<
  T extends Pick<Message, "sent_via" | "sent_by_user_id" | "direction">,
>(mensagens: T[], orgId: string): Promise<Array<T & { sent_by_user_name: string | null }>> {
  const ids = mensagens.filter(mereceNomeDeQuemEnviou).map((m) => m.sent_by_user_id);

  const membros = ids.length > 0 ? await membrosDaOrganizacao(orgId, ids) : [];
  const nomes =
    membros.length > 0 ? await nomesDosAtendentes(orgId, membros) : new Map<string, string | null>();

  return mensagens.map((m) => ({
    ...m,
    sent_by_user_name:
      mereceNomeDeQuemEnviou(m) && m.sent_by_user_id
        ? (nomes.get(m.sent_by_user_id) ?? null)
        : null,
  }));
}

/**
 * Dos ids recebidos, só os que são (ou foram) membros de `orgId`.
 *
 * O nome sai de `auth.users`, que não tem organização: sem esta conferência, o
 * nome resolvido seria o de qualquer id que estivesse na linha. `orgId` vem de
 * fonte confiável (a org ativa resolvida pela rota). `revoked_at` NÃO filtra: o
 * ex-membro continua nomeado no histórico que ele escreveu.
 *
 * Sem service role não há nome a resolver (`nomesDosAtendentes` devolveria mapa
 * vazio), então não há leitura. Falha da consulta = ninguém aprovado: o rótulo
 * cai em "Atendente", e a página não cai.
 */
async function membrosDaOrganizacao(
  orgId: string,
  ids: Array<string | null>,
): Promise<string[]> {
  if (!isServiceRoleConfigured()) return [];
  const unicos = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const { data, error } = await createAdminClient()
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .in("user_id", unicos);
  if (error) {
    logger.warn("[nome-de-quem-enviou] conferência de membros falhou", { erro: error.message });
    return [];
  }
  return [...new Set((data ?? []).map((r: { user_id: string }) => r.user_id))];
}
