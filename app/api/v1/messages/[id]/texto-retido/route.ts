/**
 * POST /api/v1/messages/[id]/texto-retido — revelar o texto de uma mensagem
 * que o CONTATO apagou (#4500).
 *
 * ═══ Por que esta porta existe, separada da conversa ═══════════════════════
 *
 * O corpo de uma apagada pelo contato NÃO sai mais no carregamento da thread
 * (`mascararTextoRetido`, `lib/messaging/texto-retido.ts`). Revelar é uma
 * decisão de ACESSO, com perfil autorizado por organização e trilha de cada
 * clique — então tem rota própria, e o clique do botão é o que a aciona.
 *
 * ═══ A ordem das cercas, e por que ela importa ═════════════════════════════
 *
 *   1. `requireRole("agent")` — quem não vê a conversa não chega ao texto.
 *   2. Ler `organizations.settings` e conferir o PERFIL autorizado. Nega antes
 *      de qualquer leitura de conteúdo. O 403 não carrega texto — nem no corpo,
 *      nem em mensagem de erro.
 *   3. Ler a linha por id **e** `organization_id` da org ativa. Mensagem de
 *      outro tenant simplesmente não existe para esta rota (o mesmo 409 mudo
 *      de "indisponível" — não se revela existência alheia).
 *   4. Só então buscar o CORPO, numa segunda consulta. Antes da permissão, o
 *      conteúdo não é lido do banco: o que não é lido não vaza por log, por
 *      mensagem de erro nem por stack trace.
 *
 * ═══ Auditoria ════════════════════════════════════════════════════════════
 *
 * TODO clique vira linha — revelado, NEGADO e indisponível. O metadata leva
 * usuário (actor), organização, conversa, mensagem, perfil e resultado; e
 * **nunca** o conteúdo: `api_audit_log` é append-only com retenção de 5 anos e
 * não alcança a cascata de anonimização da LGPD. Copiar o texto para lá seria
 * criar dado pessoal fora do alcance do titular — a mesma doutrina de
 * `message.edited` / `message.revoked`.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { podeVerTextoRetido } from "@/lib/messaging/texto-retido";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

type ResultadoDoClique = "revelado" | "negado" | "indisponivel";

const ACAO_POR_RESULTADO = {
  revelado: "message.retained_text_revealed",
  negado: "message.retained_text_denied",
  indisponivel: "message.retained_text_unavailable",
} as const;

interface LinhaDaMensagem {
  id: string;
  conversation_id: string;
  direction: string | null;
  revoked_at: string | null;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: messageId } = await ctx.params;

  // Cerca de EFEITO do acompanhamento administrativo: revelar é escrita de
  // trilha (e entrega conteúdo), então `support_readonly` não passa daqui — a
  // guarda é chamada antes de qualquer leitura de conteúdo. Ela não substitui o
  // `requireRole` abaixo nem o perfil autorizado por organização.
  const support = await requireSupportWrite();
  if (support) return support;

  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma ?? "pt-BR");

  const supabase = await createClient();

  // A linha SEM o corpo: id, conversa e estado bastam para decidir e para
  // auditar. Filtrar por `organization_id` aqui é a porta do isolamento — o
  // client de sessão já tem RLS, mas esta rota também é chamada por quem lê com
  // service role em outros caminhos, e a cerca não pode depender do chamador.
  const { data: linha, error: erroDaLinha } = await supabase
    .from("messages")
    .select("id, conversation_id, direction, revoked_at")
    .eq("id", messageId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroDaLinha) {
    return fail("internal_error", t("Não foi possível verificar a mensagem."), 500, { requestId });
  }

  const conversaId = (linha as LinhaDaMensagem | null)?.conversation_id ?? null;

  const auditar = async (resultado: ResultadoDoClique) => {
    await audit({
      action: ACAO_POR_RESULTADO[resultado],
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "message",
      resourceId: messageId,
      requestId,
      metadata: {
        conversation_id: conversaId,
        message_id: messageId,
        role: org.role,
        result: resultado,
      },
    });
  };

  // 1º cercado: o PERFIL. A lista nasce vazia e é independente por organização
  // (`perfisDoTextoRetido`); nenhum papel entra por padrão, nem `admin`.
  const { data: organizacao, error: erroDaOrg } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroDaOrg) {
    return fail("internal_error", t("Não foi possível verificar a permissão."), 500, { requestId });
  }
  const settings = (organizacao as { settings?: unknown } | null)?.settings ?? null;
  if (!podeVerTextoRetido(settings, org.role)) {
    await auditar("negado");
    // A frase é a MESMA que o botão mostra; o corpo não tem nada além dela.
    return fail(
      "forbidden_role",
      t("Você não tem permissão para ver este texto."),
      403,
      { requestId },
    );
  }

  // 2º cercado: a mensagem precisa ser uma apagada PELO CONTATO. Apagada pelo
  // atendente continua visível pela régua do balão (não é conteúdo retido), e
  // mensagem viva não tem o que revelar por aqui.
  if (!linha || linha.direction !== "inbound" || !linha.revoked_at) {
    await auditar("indisponivel");
    return fail("texto_indisponivel", t("Texto não disponível."), 409, { requestId });
  }

  // Só AGORA o conteúdo é lido do banco.
  const { data: corpo, error: erroDoCorpo } = await supabase
    .from("messages")
    .select("body")
    .eq("id", messageId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroDoCorpo) {
    return fail("internal_error", t("Não foi possível ler o texto."), 500, { requestId });
  }
  const texto = (corpo as { body?: string | null } | null)?.body ?? null;
  if (!texto || !texto.trim()) {
    await auditar("indisponivel");
    return fail("texto_indisponivel", t("Texto não disponível."), 409, { requestId });
  }

  await auditar("revelado");
  return ok({ texto }, { requestId });
}
