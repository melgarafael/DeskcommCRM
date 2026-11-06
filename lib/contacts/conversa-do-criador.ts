/**
 * A CONVERSA DO CADASTRO NASCE DE QUEM CADASTROU (#3479).
 *
 * ─── O buraco ──────────────────────────────────────────────────────────────
 *
 * `abrirConversaDoContatoNovo` (`./conversa-ao-criar.ts`) garante a conversa
 * pelo `fn_service_begin`, que INSERTA com `assigned_to_user_id` NULO. Em
 * `visibility_mode = 'own'`, `fn_can_view_conversation(org, null)` responde
 * "não vejo" (migration 0035) — a fila sem dono é invisível de propósito. Logo
 * o Atendente criava o contato e não enxergava a conversa que o próprio
 * cadastro abriu: o Inbox vinha vazio, o ícone de Contatos "piscava", e o
 * diálogo traduzia o 409 do claim em "está com outro atendente" — sobre uma
 * conversa de ninguém.
 *
 * O fluxo de ABRIR já dá dono (`open-with-contact` → claim). O de CRIAR não
 * dava. É a mesma assimetria que o #2547 mediu nos negócios: no "Só os seus" o
 * "Novo Lead" nasce com o Atendente de responsável (o `owner_user_id` é
 * preenchido na rota de leads), e a conversa criada junto com o contato nascia
 * sem dono nenhum.
 *
 * ─── Por que ASSUMIR (o claim), e não um UPDATE de dono ────────────────────
 *
 * A regra de quem pode virar dono de uma conversa livre mora num lugar só:
 * `fn_conversation_assign` com `p_reason = 'claim'` e CAS (migration 9017).
 * Escrever aqui um `update conversations set assigned_to_user_id = …` seria a
 * segunda cópia da regra — sem CAS, sem evento de atribuição, sem auditoria e
 * sem a linha do tempo que os outros botões produzem. `assumirConversaComEfeitos`
 * é a MESMA função do botão Assumir, do painel do Inbox e da abertura: o dono
 * nasce com o histórico que o produto já mostra.
 *
 * O CAS vai SEM `expected_assignee` — o contrato de "assuma se estiver livre".
 * Conversa que já tinha dono (rodízio, colega, outra aba) devolve zero linhas e
 * NADA muda: cadastrar contato não tira atendimento de ninguém.
 *
 * ─── Quem NÃO entra ───────────────────────────────────────────────────────
 *
 *   • token de servidor / agente de IA — não é "quem atendeu", mesma régua de
 *     `open-with-contact`; e a decisão sai ANTES de qualquer leitura;
 *   • gerente e admin — enxergam a organização inteira e criam como sempre
 *     (mesma decisão do #2547), então nada muda para eles;
 *   • modos `all`, `own_and_unassigned` e `own_and_sector` — neles a conversa
 *     sem dono é comportamento desenhado (a fila compartilhada, o setor), e
 *     dar dono a ela tiraria o contato da fila de quem deveria atendê-lo. O
 *     modo que a issue mede é `own`, e só ele entra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { somenteOProprio, type VisibilityMode } from "@/lib/auth/types";
import { assumirConversaComEfeitos } from "@/lib/inbox/assumir-conversa";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Quem deve nascer dono da conversa do cadastro — `null` = ninguém, como antes.
 *
 * Pura de propósito: é a decisão inteira, e o teste a mede sem dublê.
 */
export function donoDaConversaDoCadastro(ator: Actor, modo: unknown): string | null {
  if (ator.type !== "user") return null;
  if (ator.role !== "agent") return null;
  if (!somenteOProprio(modo)) return null;
  return ator.id;
}

/**
 * Dá a conversa recém-aberta ao Atendente que cadastrou o contato — SE a
 * decisão mandar e SE ela ainda estiver livre.
 *
 * Nunca lança: o contato já está gravado, e a conversa já existe. Perder o dono
 * é um efeito a menos (o produto volta ao comportamento de antes, e o claim do
 * "Iniciar conversa" tenta de novo), não um cadastro a menos.
 */
export async function atribuirConversaDoCadastroAoCriador(
  supabase: SupabaseClient,
  p: {
    organizationId: string;
    conversationId: string;
    actor: Actor;
    requestId: string;
  },
): Promise<boolean> {
  // A decisão que não precisa do banco vem PRIMEIRO: token e gestor custam
  // zero leitura, e é o que mantém o caminho de escrita por API intacto.
  if (p.actor.type !== "user" || p.actor.role !== "agent") return false;

  const modo = await modoDeVisibilidade(p.organizationId, p.requestId);
  const ator = p.actor;
  if (!donoDaConversaDoCadastro(ator, modo)) return false;

  try {
    const { conversation, error } = await assumirConversaComEfeitos(supabase, {
      organizationId: p.organizationId,
      conversationId: p.conversationId,
      actor: ator,
      requestId: p.requestId,
    });
    if (error) throw error;
    // Zero linhas = já tinha dono. É o caminho normal de quem cadastra um
    // contato que o rodízio já distribuiu (ou de uma segunda aba): nada a
    // fazer, nada a dizer.
    return conversation !== null;
  } catch (erro) {
    logger.warn("contato criado: a conversa não nasceu do criador (o contato já está gravado)", {
      organization_id: p.organizationId,
      conversation_id: p.conversationId,
      request_id: p.requestId,
      detail: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}

/**
 * `organizations.settings.visibility_mode` da organização do CONTEXTO.
 *
 * Service role porque a leitura não é a pergunta da RLS: quem decide o que o
 * Atendente enxerga é a policy, e ela lê o mesmo valor. Falha de leitura
 * degrada para "não sei o modo" — que não dá dono a ninguém e NUNCA derruba o
 * cadastro (mesma régua da rota de leads, #2547).
 */
async function modoDeVisibilidade(
  organizationId: string,
  requestId: string,
): Promise<VisibilityMode | undefined> {
  try {
    const { data, error } = await createAdminClient()
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw error;
    return (data?.settings as { visibility_mode?: VisibilityMode } | null)?.visibility_mode;
  } catch (erro) {
    logger.error("contato criado: leitura do modo de visibilidade falhou; a conversa segue sem dono", {
      organization_id: organizationId,
      request_id: requestId,
      detail: erro instanceof Error ? erro.message : String(erro),
    });
    return undefined;
  }
}
