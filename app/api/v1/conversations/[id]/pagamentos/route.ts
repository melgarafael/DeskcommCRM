/**
 * POST /api/v1/conversations/[id]/pagamentos — REGISTRAR um recebimento na
 * conversa e entregar o ENDEREÇO DE AVISO dele (issue #3509, degrau 1).
 *
 * ─── O que esta rota NÃO faz ────────────────────────────────────────────────
 *
 * Não gera link, não chama provedor e não envia mensagem. Gerar o link é da
 * conta do dono no aplicativo do meio de pagamento, e enviar é sempre um clique
 * humano. O que a rota faz é criar o recebimento (`pendente`) e devolver a URL
 * que a atendente cola como "URL do Webhook" ao criar o link
 * (`lib/pagamentos/registrar.ts` explica a ordem).
 *
 * ─── O segredo é mostrado UMA vez ───────────────────────────────────────────
 *
 * A URL leva o segredo deste recebimento, e só o hash fica no banco. Repetir o
 * registro cria OUTRO recebimento com outra URL; o anterior fica pendente e
 * ninguém o confirma. Por isso a resposta não é cacheável.
 *
 * ─── Quem pode ──────────────────────────────────────────────────────────────
 *
 * `agent` para cima, com o módulo `link_de_pagamento` ligado (desligado: 404).
 * A organização vem da SESSÃO, nunca do corpo. A conversa é lida com o cliente
 * da REQUISIÇÃO antes de registrar, como em `pause-ai` e `close`: é a policy
 * `conversations_select` que aplica o escopo de visibilidade do atendimento, e
 * conversa que quem pede não enxerga responde 404, igual a id de outra empresa.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { urlDoAviso } from "@/lib/pagamentos/assinatura";
import { registrarRecebimento } from "@/lib/pagamentos/registrar";
import { PROVEDORES_DE_RECEBIMENTO, VALOR_MAXIMO_CENTS } from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({
  provedor: z.enum(PROVEDORES_DE_RECEBIMENTO),
  /** Valor em CENTAVOS (o repo inteiro fala centavos). É o que o aviso tem de trazer. */
  valor_cents: z.number().int().positive().max(VALOR_MAXIMO_CENTS),
  /** O único provedor (InfinitePay) só cobra em real; outra moeda é 400, não um link que nunca bate. */
  moeda: z.enum(["BRL"]).optional(),
});

interface Contexto {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Contexto) {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;

  // O acompanhamento administrativo é LEITURA por desenho: registrar pagamento
  // em nome do cliente durante um suporte é escrita, e a guarda de efeito vem
  // antes de qualquer service role (não substitui o RBAC abaixo).
  const suporte = await requireSupportWrite();
  if (suporte) return suporte;

  const authz = await requireRole("agent", { requestId, resource: "pagamento_recebimentos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // Depois da autorização: quem não pode registrar recebe a recusa do papel,
  // não a validação do id.
  if (!z.string().uuid().safeParse(conversationId).success) {
    return fail("validation_failed", t("Conversa inválida."), 400, { requestId });
  }

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "link_de_pagamento"))) {
    return fail("not_found", "Not found", 404, { requestId });
  }

  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) {
    return fail("validation_failed", t("Pedido inválido."), 400, {
      requestId,
      details: corpo.error.flatten(),
    });
  }
  const d = corpo.data;

  // Antes de gravar: sem endereço público, o aviso nunca chegaria e o
  // recebimento ficaria pendente para sempre com cara de que vai confirmar.
  const base = env.NEXT_PUBLIC_APP_URL ?? "";
  if (urlDoAviso(base, d.provedor, "00000000-0000-4000-8000-000000000000", "x") === null) {
    return fail("unavailable", t("Esta instalação não tem um endereço público https para receber o aviso de pagamento."), 503, {
      requestId,
      details: { falta: "NEXT_PUBLIC_APP_URL" },
    });
  }

  // Client da REQUISIÇÃO, nunca admin: o registro só acontece numa conversa que
  // quem pede enxerga. O `registrarRecebimento` lê de novo com o admin para
  // achar o contato; esta leitura é a que decide se pode.
  const supabase = await createClient();
  const { data: visivel, error: erroDaLeitura } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (erroDaLeitura) {
    logger.error("[pagamentos.registrar] conversa ilegível pela sessão", {
      requestId,
      organization_id: authz.org.orgId,
      codigo: erroDaLeitura.code ?? null,
    });
    return fail("internal_error", t("Não foi possível ler a conversa."), 500, { requestId });
  }
  if (!visivel) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const r = await registrarRecebimento(admin, {
    organizationId: authz.org.orgId,
    conversationId,
    provedor: d.provedor,
    valorCents: d.valor_cents,
    ...(d.moeda === undefined ? {} : { moeda: d.moeda }),
  });

  if (r.ok) {
    logger.info("[pagamentos.registrar] recebimento registrado na conversa", {
      requestId,
      organization_id: authz.org.orgId,
      conversation_id: conversationId,
      provedor: d.provedor,
    });
    await audit({
      action: "pagamento.link_registrado",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "pagamento_recebimento",
      resourceId: r.recebimento.id,
      requestId,
      metadata: {
        conversation_id: conversationId,
        provedor: d.provedor,
        valor_cents: r.recebimento.valor_cents,
        moeda: r.recebimento.moeda,
      },
    });
    return ok(
      {
        recebimento_id: r.recebimento.id,
        status: r.recebimento.status,
        valor_cents: r.recebimento.valor_cents,
        moeda: r.recebimento.moeda,
        lead_id: r.recebimento.lead_id,
        // Mostrada uma vez: o segredo dela não fica no banco.
        url_do_aviso: urlDoAviso(base, r.recebimento.provedor, r.recebimento.id, r.token),
      },
      { requestId, status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  return fail(r.code, t(r.message), r.status, {
    requestId,
    ...(r.details === undefined ? {} : { details: r.details }),
  });
}
