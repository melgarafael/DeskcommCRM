/**
 * GET /api/v1/conversations/[id]/aviso-de-mensagem — "devo avisar ESTA pessoa
 * da mensagem que acabou de chegar nesta conversa?" → `{ avisar: boolean }`.
 *
 * Quem lê é `hooks/notifications/useInboundMessageAlerts.ts` (toast e
 * notificação do navegador). A regra é a do push do servidor, na MESMA função:
 * `lib/notifications/destinatarios-da-mensagem.ts` — conversa sem responsável
 * avisa todos; com responsável, só ele e os administradores.
 *
 * ═══ Por que uma rota nova, e não `GET /conversations/[id]` ═══
 *
 * A rota da conversa já devolve `assigned_to_user_id`, e isso basta quando a
 * conversa tem atendente. Não basta no outro ramo da regra — conversa sem
 * atendente cujo contato tem negócio aberto com dono: o dono vive em
 * `crm_leads`, e a policy de leitura dali (`fn_can_view_lead`) esconde de um
 * `agent`, no modo de visibilidade PADRÃO (`own_and_unassigned`), todo negócio
 * de outro dono. Para esse atendente, "não vejo negócio" seria indistinguível
 * de "não há negócio", e ele seria avisado justamente do cliente que é de outra
 * pessoa. A pergunta precisa ser feita onde o dono é visível — aqui, com o
 * service role — e a resposta volta como um booleano, sem expor o dono nem o
 * negócio que a pessoa não pode abrir.
 *
 * ═══ Por que o admin client, e com que cerca ═══
 *
 * A EXISTÊNCIA da conversa é conferida com o client da SESSÃO: quem não enxerga
 * a conversa recebe 404 e não aprende nada sobre ela. Só depois os fatos da
 * atribuição são lidos com o service role, e cada consulta filtra
 * `organization_id` da organização ATIVA da sessão — nunca de input.
 *
 * Read-only ⇒ sem audit (mesma regra das rotas irmãs de leitura).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import {
  carregarDestinatariosDaMensagem,
  usuarioRecebeAviso,
} from "@/lib/notifications/destinatarios-da-mensagem";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  // viewer+: todo membro recebe o realtime de mensagens, então todo membro
  // precisa poder perguntar se deve ser avisado.
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const supabase = await createClient();
  const { data: conversa } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  try {
    const destino = await carregarDestinatariosDaMensagem(createAdminClient(), org.orgId, id);
    // `null` só se a conversa sumiu entre as duas leituras: sem dono conhecido,
    // é fila — avisa, como antes da regra.
    const avisar = destino === null ? true : usuarioRecebeAviso(destino, user.id);
    return ok({ avisar }, { requestId });
  } catch (err) {
    logger.error("[aviso-de-mensagem] leitura falhou", {
      conversation_id: id,
      organization_id: org.orgId,
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", t("Não foi possível decidir o aviso da mensagem."), 500, { requestId });
  }
}
