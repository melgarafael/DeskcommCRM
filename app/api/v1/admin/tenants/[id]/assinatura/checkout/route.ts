/**
 * POST /api/v1/admin/tenants/[id]/assinatura/checkout — "Gerar link de
 * pagamento" (spec da cobrança do revendedor §7g, D-15). O dono gera o link que
 * manda à empresa: as mesmas três fases do "Assinar" dela
 * (`lib/cobranca/checkout.ts`), com a org do PATH e o e-mail do admin mais
 * antigo da empresa — nunca o do dono, que ficaria gravado no cliente do provedor.
 * Fatura já aberta no provedor não é recusa aqui: o dono quer o link, e é ele.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { gerarLinkDePagamento } from "@/lib/cobranca/checkout";
import { emailDoAdminDaEmpresa } from "@/lib/cobranca/emails";
import { urlDoPainelDaEmpresa } from "@/lib/cobranca/url";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.strictObject({
  /** CPF ou CNPJ de quem paga, com ou sem máscara. Vai direto ao provedor e NÃO é guardado (spec §2.3, LGPD). */
  documento: z.string().max(32).optional(),
});

/** As frases do núcleo falam com a empresa ("fale com quem administra o sistema"); estas falam com o dono. */
const FRASE_DO_DONO: Record<string, string> = {
  not_found: "Esta empresa é isenta: atribua um plano antes de gerar o link.",
  provedor_nao_conectado: "Conecte o provedor de pagamento em Cobrança › Conexão antes de gerar o link.",
  sem_link_de_pagamento: "A empresa já tem assinatura, mas não há cobrança aberta agora. Ela precisa atualizar o cartão em Plano e cobrança.",
  provedor_recusou: "O provedor de pagamento recusou o pedido. Confira a chave em Cobrança › Conexão e tente de novo; o motivo aparece no painel do provedor.",
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: tenantId } = await params;
  const supportDenied = await requireSupportWrite(tenantId);
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca")) || !z.string().uuid().safeParse(tenantId).success) {
    return fail("not_found", "Not found", 404, { requestId });
  }
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }
  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) return fail("validation_failed", "Pedido inválido.", 400, { requestId, details: corpo.error.flatten() });

  let email: string | null;
  try {
    email = await emailDoAdminDaEmpresa(admin, tenantId);
  } catch (e) {
    // A mensagem leva só o código do PostgREST/Auth, nunca o endereço (`lib/cobranca/emails.ts`).
    logger.error("cobranca: admins da empresa ilegíveis no link do dono", {
      requestId,
      organizationId: tenantId,
      motivo: e instanceof Error ? e.message : "desconhecido",
    });
    return fail("internal_error", "Não foi possível ler os administradores da empresa.", 500, { requestId });
  }

  const r = await gerarLinkDePagamento(admin, {
    orgId: tenantId,
    documentoBruto: corpo.data.documento,
    email,
    chaveIdempotencia: chave ?? randomUUID(),
    urlDeVolta: urlDoPainelDaEmpresa(),
    actorUserId: adminCtx.user.id,
    requestId,
    comoDono: true,
  });
  if (r.ok) return ok({ url: r.url }, { requestId });
  const vivo = (r.details as { link_de_pagamento?: unknown } | undefined)?.link_de_pagamento;
  if (r.code === "pagamento_em_andamento" && typeof vivo === "string") return ok({ url: vivo }, { requestId });
  return fail(r.code, FRASE_DO_DONO[r.code] ?? r.message, r.status, {
    requestId,
    ...(r.details === undefined ? {} : { details: r.details }),
    ...(r.headers === undefined ? {} : { headers: r.headers }),
  });
}
