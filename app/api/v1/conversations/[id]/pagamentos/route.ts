/**
 * POST /api/v1/conversations/[id]/pagamentos — REGISTRAR o link de pagamento na
 * conversa (issue #3509, degrau 1).
 *
 * ─── O que esta rota NÃO faz ────────────────────────────────────────────────
 *
 * Não gera link, não chama provedor e não envia mensagem. Gerar o link é da
 * conta do dono no aplicativo do meio de pagamento (não temos contrato nem
 * token), e enviar é sempre um clique humano — a cadeia anti-banimento do
 * produto. O que a rota faz é transformar em DADO um link que já está na
 * conversa: cria o recebimento (`pendente`) e escreve o ponteiro
 * `metadata.pagamento` na mensagem, para o balão mostrar valor e estado.
 *
 * ─── Quem pode ──────────────────────────────────────────────────────────────
 *
 * `agent` para cima: quem atende registra. `viewer` não escreve (RLS diz o
 * mesmo, com `fn_role_at_least`). A organização vem da SESSÃO, nunca do corpo —
 * e a mensagem é procurada com `organization_id` + `conversation_id` no filtro,
 * então um id de outra empresa responde 404, não 403 (não confirma existência).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { registrarLinkDoPagamento } from "@/lib/pagamentos/registrar";
import {
  PROVEDORES_DE_RECEBIMENTO,
  TAMANHO_MAXIMO_DO_ID_EXTERNO,
  VALOR_MAXIMO_CENTS,
} from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({
  /** A mensagem que já foi enviada com o link dentro. */
  mensagem_id: z.string().uuid(),
  provedor: z.enum(PROVEDORES_DE_RECEBIMENTO),
  /** Id do pagamento NO PROVEDOR. */
  id_externo: z.string().min(1).max(TAMANHO_MAXIMO_DO_ID_EXTERNO),
  /** Valor em CENTAVOS (o repo inteiro fala centavos). */
  valor_cents: z.number().int().positive().max(VALOR_MAXIMO_CENTS),
  /** A MESMA URL que está no corpo da mensagem — a rota confere. */
  link: z.string().min(1),
  moeda: z.string().length(3).optional(),
});

interface Contexto {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Contexto) {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;
  if (!z.string().uuid().safeParse(conversationId).success) {
    return fail("validation_failed", "Conversa inválida.", 400, { requestId });
  }

  // O acompanhamento administrativo é LEITURA por desenho: registrar pagamento
  // em nome do cliente durante um suporte é escrita, e a guarda de efeito vem
  // antes de qualquer service role (não substitui o RBAC abaixo).
  const suporte = await requireSupportWrite();
  if (suporte) return suporte;

  const authz = await requireRole("agent", { requestId, resource: "pagamento_recebimentos" });
  if (!authz.ok) return authz.response;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) {
    return fail("validation_failed", "Pedido inválido.", 400, {
      requestId,
      details: corpo.error.flatten(),
    });
  }

  const d = corpo.data;
  const r = await registrarLinkDoPagamento(createAdminClient(), {
    organizationId: authz.org.orgId,
    conversationId,
    messageId: d.mensagem_id,
    provedor: d.provedor,
    externalId: d.id_externo,
    valorCents: d.valor_cents,
    link: d.link,
    ...(d.moeda === undefined ? {} : { moeda: d.moeda }),
  });

  if (r.ok) {
    logger.info("[pagamentos.registrar] link registrado na conversa", {
      requestId,
      organization_id: authz.org.orgId,
      conversation_id: conversationId,
      provedor: d.provedor,
      reutilizado: r.reutilizado,
    });
    // 200 mesmo no reutilizado: clicar duas vezes é o MESMO resultado, e o
    // cliente da tela não deve tratar a repetição como erro.
    return ok(
      {
        recebimento_id: r.recebimento.id,
        status: r.recebimento.status,
        valor_cents: r.recebimento.valor_cents,
        moeda: r.recebimento.moeda,
        pago_em: r.recebimento.pago_em,
        pagamento: r.pagamento,
        reutilizado: r.reutilizado,
      },
      { requestId, status: r.reutilizado ? 200 : 201 },
    );
  }

  return fail(r.code, r.message, r.status, {
    requestId,
    ...(r.details === undefined ? {} : { details: r.details }),
  });
}
