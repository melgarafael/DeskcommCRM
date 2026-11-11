/**
 * GET /api/v1/conversations/[id]/passagens — o que a IA deixou para quem assume.
 *
 * ═══ Por que o client é o da SESSÃO, e nunca o admin ═══
 *
 * A linha de `passagens_de_atendimento` carrega o que a IA concluiu sobre uma
 * pessoa: o que ela quer, o que já foi tentado e as palavras dela. A policy da
 * tabela (migration 0291) exige TRÊS condições para ler — organização, papel
 * `agent`+ e `fn_can_view_conversation`. O service role bypassa RLS, então uma
 * leitura com admin entregaria o briefing de um atendimento que a política de
 * visibilidade da organização não deixa a pessoa nem abrir.
 *
 * É o defeito que a Central tem — ela lê os avisos com admin e entrega `body` a
 * qualquer `agent` —, e é por isso que o corpo do aviso ficou CURTO nesta
 * entrega. Ler aqui com admin desfaria aquilo pelo outro lado.
 *
 * O admin entra em UM lugar e só nele: o nome de quem assumiu
 * (`lib/users/nome-do-atendente.ts`), que fala com o endpoint admin do GoTrue —
 * o token do usuário recebe 403 `not_admin` lá, e o supabase-js **não lança**
 * nesse caso, então todo nome viria `null` em silêncio.
 *
 * ═══ Sem realtime, de propósito ═══
 *
 * `passagens_de_atendimento` não entra na publicação `supabase_realtime`. Abrir
 * um canal `postgres_changes` numa tabela fora da publicação é o defeito vivo de
 * `hooks/inbox/useConversationNotes.ts`: o canal assina, responde `SUBSCRIBED` e
 * não recebe nada — falha muda. A invalidação pega carona no realtime de
 * `conversations`, que JÁ está na publicação e JÁ muda quando a passagem
 * acontece (`bot_silenced_until`, `assigned_to_user_id`, `last_handoff_reason`).
 *
 * ═══ Read-only ⇒ sem audit ═══
 *
 * Mesma regra das rotas irmãs de leitura: `api_audit_log` registra MUTAÇÃO.
 *
 * As mensagens de erro passam por `traduzir()` por disciplina — `PASTAS_IGNORADAS`
 * do gate de i18n inclui `api`, então ninguém as cobra; elas são frase de
 * produto do mesmo jeito.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

/**
 * Teto de linhas. Uma conversa com dezenas de passagens é patológica (cada uma
 * é um episódio inteiro de ida e volta), mas "patológica" não é "impossível": um
 * laço de automação já produziu volume assim neste produto. Sem teto, o cartão
 * mais caro da tela carregaria a tabela inteira daquela conversa.
 *
 * 20 e não 5: o fio mostra as antigas recolhidas, e cortar cedo demais faria a
 * primeira passagem de um atendimento longo sumir sem ninguém saber que sumiu.
 */
const TETO_DE_PASSAGENS = 20;

/** As colunas que a tela lê. Um literal só — o supabase-js infere a linha do TIPO da string. */
const COLUNAS =
  "id, origem, motivo_codigo, title, body, notes, content, tentativas, cliente_avisado, aviso_motivo_codigo, caso_id, criado_em, reconhecido_em, reconhecido_por";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const authHeader = req.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader.trim())) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "passagens_de_atendimento",
      role: "agent",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "passagens_de_atendimento", requestId);
    if (teto) return teto;
    const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
    const { organizationId } = authz;
    return responderPassagens(authz.supabase, organizationId, id, requestId, t);
  }

  // Caminho de sessão: byte a byte igual.
  const authz = await requireRole("agent", { requestId, resource: "passagens_de_atendimento" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const supabase = await createClient();
  return responderPassagens(supabase, org.orgId, id, requestId, t);
}

async function responderPassagens(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  requestId: string,
  t: (texto: string) => string,
): Promise<Response> {
  // A existência é confirmada ANTES: sem isto, uma conversa de outra organização
  // devolveria `[]` com 200, que se lê como "esta conversa não teve passagem
  // nenhuma" — e afirma a existência dela de graça.
  const { data: conversa } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const { data, error } = await supabase
    .from("passagens_de_atendimento")
    .select(COLUNAS)
    .eq("conversation_id", conversationId)
    .eq("organization_id", organizationId)
    .order("criado_em", { ascending: true })
    .limit(TETO_DE_PASSAGENS);

  if (error) {
    logger.error("[passagens] leitura falhou", {
      conversation_id: conversationId,
      organization_id: organizationId,
      error: error.message,
      requestId,
    });
    return fail("internal_error", t("Não foi possível carregar o contexto da passagem."), 500, {
      requestId,
    });
  }

  const linhas = data ?? [];
  const nomes = await nomesDosAtendentes(organizationId,linhas.map((l) => l.reconhecido_por));

  return ok(
    // `reconhecido_por` continua na linha mesmo sem nome: o dono é a VERDADE, o
    // nome é a cortesia. Cair para `null` aqui faria o cartão ler uma passagem
    // assumida como "devolvida ao automático".
    linhas.map((l) => ({ ...l, reconhecido_por_nome: nomes.get(l.reconhecido_por ?? "") ?? null })),
    { requestId },
  );
}
