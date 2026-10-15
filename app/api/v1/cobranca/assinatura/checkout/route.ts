/**
 * POST /api/v1/cobranca/assinatura/checkout — o botão "Assinar" (spec da
 * cobrança do revendedor §7b). As três fases moram em `lib/cobranca/checkout.ts`,
 * que o "Gerar link de pagamento" do dono também usa. Aqui: sessão, módulo,
 * `Idempotency-Key` e corpo. O e-mail do cliente no provedor é o de quem clicou.
 * Empresa suspensa também assina (o hub leva aqui). A org vem da sessão.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { gerarLinkDePagamento } from "@/lib/cobranca/checkout";
import { urlDoHub, urlDoPainelDaEmpresa } from "@/lib/cobranca/url";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({
  /** Só um destino nomeado (nunca uma URL livre: sem redirecionamento aberto). */
  volta: z.enum(["hub"]).optional(),
  /** CPF ou CNPJ de quem paga, com ou sem máscara. Vai direto ao provedor e NÃO é guardado (spec §2.3, LGPD). */
  documento: z.string().max(32).optional(),
});

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "cobranca_assinaturas", permiteOrgSuspensa: true });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }
  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) return fail("validation_failed", "Pedido inválido.", 400, { requestId, details: corpo.error.flatten() });

  const r = await gerarLinkDePagamento(admin, {
    orgId: authz.org.orgId,
    documentoBruto: corpo.data.documento,
    email: authz.user.email,
    chaveIdempotencia: chave ?? randomUUID(),
    urlDeVolta: corpo.data.volta === "hub" ? urlDoHub() : urlDoPainelDaEmpresa(),
    actorUserId: authz.user.id,
    requestId,
    comoDono: false,
  });
  if (r.ok) return ok({ url: r.url }, { requestId });
  return fail(r.code, r.message, r.status, {
    requestId,
    ...(r.details === undefined ? {} : { details: r.details }),
    ...(r.headers === undefined ? {} : { headers: r.headers }),
  });
}
