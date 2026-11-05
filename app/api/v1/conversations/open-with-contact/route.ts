import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/open-with-contact
 *
 * Resolve o contato do cartão compartilhado e abre a conversa 1:1 na mesma sessão
 * de canal — comportamento equivalente ao toque no contato no WhatsApp.
 */
import { type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { openConversationWithContactSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { assumirConversaComEfeitos } from "@/lib/inbox/assumir-conversa";

export const dynamic = "force-dynamic";

/**
 * #3479 — A CONVERSA QUE "INICIAR CONVERSA" ABRE NASCE DE QUEM CLICOU.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * `openSharedContactConversation` garante a conversa: cria pelo
 * `fn_service_begin` (que INSERTA com `assigned_to_user_id` nulo) ou reabre a
 * que estava fechada. Nenhum dos caminhos dá dono a ela. Em `visibility_mode =
 * 'own'` a conversa sem dono não é exibida a Atendente nenhum — o modo foi
 * desenhado assim (0035) —, então a tela que abrisse essa conversa caía num
 * Inbox vazio, e o diálogo do Inbox traduzia isso em "está com outro
 * atendente", que era falso.
 *
 * O diálogo do Inbox já pedia o `claim` logo depois de abrir; a tabela de
 * Contatos, o quadro do funil e o cartão de contato chamam ESTA rota e não
 * pediam — daí a inconsistência da issue (Contatos pisca e não mostra nada,
 * Inbox reclama de um dono que não existe). Pedir o `claim` em cada tela seria
 * N cópias da mesma regra; aqui é uma, e vale para todas.
 *
 * ─── Por que é seguro, e por que é o lugar ─────────────────────────────────
 *
 * `expected_assignee` AUSENTE é o contrato de "assuma se estiver livre" (mesma
 * chamada do diálogo do Inbox): se a conversa reaberta já tinha dono — o caso
 * de um colega —, o RPC devolve zero linhas e NADA acontece. Não se rouba
 * atendimento de ninguém, e a conversa do colega continua invisível para quem
 * não a enxerga, porque o predicado de escopo (9017) só abre a assinatura da
 * conversa SEM dono quando o dono novo é o próprio chamador.
 *
 * Só a SESSÃO do navegador assume: token de servidor (MCP) não é "quem
 * atendeu", e assumir em nome dele seria mentir na linha do tempo — a mesma
 * régua de `lib/inbox/assumir-conversa-apos-envio.ts`.
 *
 * A falha do claim NUNCA derruba a abertura: a conversa já existe e a tela
 * precisa dela. Sem o dono, o produto volta ao comportamento de antes (a
 * conversa aparece para gerente/admin, e o claim do diálogo do Inbox tenta de
 * novo), que é ruim — não é pior que uma abertura que não abre.
 */
async function assumirConversaSeLivre(p: {
  supabase: SupabaseClient;
  organizationId: string;
  conversationId: string;
  userId: string;
  role?: string;
  requestId: string;
}): Promise<boolean> {
  try {
    const { conversation, error } = await assumirConversaComEfeitos(p.supabase, {
      organizationId: p.organizationId,
      conversationId: p.conversationId,
      actor: { type: "user", id: p.userId, role: p.role },
      requestId: p.requestId,
    });
    if (error) throw error;
    // Zero linhas = a conversa já tinha dono. É o caminho normal de quem abre
    // uma conversa que já é de outra pessoa: nada a fazer, nada a dizer.
    return conversation !== null;
  } catch (err) {
    console.error(
      "[conversations.open-with-contact] não foi possível assumir a conversa livre",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Sessão de navegador OU token de servidor: é o passo que antecede o envio,
  // e quem envia por token precisa poder resolver a conversa pelo telefone.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversations",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // Rota que aceita Bearer (PUBLIC_PATHS): sem estrangulamento a montante, o
  // que não for contado aqui não é contado em lugar nenhum — mesmo teto das
  // irmãs que já aplicam sobre resolveAuthDual.
  const teto = await tetoDeEscritaDoToken(authz, "conversations.open", requestId);
  if (teto) return teto;
  // O ramo do token não carrega idioma de usuário: cai no padrão do produto.
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  let input;
  try {
    input = await validateRequest(openConversationWithContactSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const admin = createAdminClient();
    const result = await openSharedContactConversation(admin, authz.organizationId, input);
    // #3479: a conversa que o clique abriu nasce de quem clicou. Sem isto, em
    // "Só os seus" o Atendente abre uma conversa que ele não enxerga (dona:
    // ninguém) — ver o bloco de `assumirConversaSeLivre`.
    if (authz.via === "session" && authz.actor.type === "user") {
      await assumirConversaSeLivre({
        supabase: authz.supabase,
        organizationId: authz.organizationId,
        conversationId: result.conversation_id,
        userId: authz.actor.id,
        role: authz.actor.role,
        requestId,
      });
    }
    return ok(result, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "open_failed";
    if (msg === "contact_not_found") {
      return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    }
    if (msg === "session_not_found") {
      return fail("not_found", t("Sessão de canal não encontrada."), 404, { requestId });
    }
    if (msg === "invalid_phone") {
      return fail("validation_error", t("Telefone inválido."), 422, { requestId });
    }
    if (msg === "contact_personal") {
      return fail("forbidden", t("Contato marcado como pessoal."), 403, { requestId });
    }
    return fail("internal_error", msg, 500, { requestId });
  }
}
