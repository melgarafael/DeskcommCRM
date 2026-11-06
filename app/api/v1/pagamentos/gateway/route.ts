/**
 * GET    /api/v1/pagamentos/gateway — o gateway em vigor da org ativa (manager+).
 * PUT    /api/v1/pagamentos/gateway — grava/atualiza a configuração própria (admin).
 * DELETE /api/v1/pagamentos/gateway — desliga a configuração própria; volta a
 *                                     herdar a da instalação, sem apagar nada.
 *
 * Issue #4058, fatia 1. O provedor de pagamento era da INSTALAÇÃO
 * (`lib/cobranca/configuracao.ts`, `platform_config`); a empresa não tinha como
 * cobrar o cliente dela na própria conta. Aqui a organização escolhe provedor e
 * credencial, e a ausência de configuração herda a instalação.
 *
 * ─── O segredo não sai daqui ────────────────────────────────────────────────
 *
 * O GET devolve `EstadoDoGatewayParaTela` — provedor, modo, `last4`, origem. Não
 * existe campo com a chave no tipo, então não há como a resposta levá-la por
 * descuido de quem monta o payload. E a chave da INSTALAÇÃO herdada não expõe
 * nem os 4 últimos: ela não é da organização.
 *
 * ─── Erro nomeado, nunca 500 mudo ───────────────────────────────────────────
 *
 * Toda recusa tem código próprio: chave recusada pelo provedor
 * (`invalid_provider_key`), chave sem permissão
 * (`provider_key_without_permission`), chave de produção contra a base de teste
 * (`provider_key_mode_mismatch`), provedor fora (`provider_unavailable`), cifra
 * indisponível (`credential_encryption_unavailable`), e a gravação recusada pelo
 * banco (`gateway_save_failed`, com o detalhe).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  desligarGatewayDaOrganizacao,
  estadoParaTela,
  guardarGatewayDaOrganizacao,
  type ErroDeEscrita,
} from "@/lib/pagamentos/gateway-da-organizacao";
import { PROVEDORES_DE_PAGAMENTO } from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  provider: z.enum(PROVEDORES_DE_PAGAMENTO),
  /** Opcional numa atualização (mantém a chave já cifrada); obrigatório na primeira. */
  api_key: z.string().trim().min(8).max(400).optional(),
  /** `null` apaga o segredo; ausente mantém o que está gravado. */
  webhook_secret: z.string().trim().min(4).max(400).nullable().optional(),
  is_active: z.boolean().default(true),
});

const RESPOSTA_POR_ERRO: Record<ErroDeEscrita, { code: string; message: string; status: number }> = {
  credencial_obrigatoria: {
    code: "credential_required",
    message: "Informe a chave do provedor para configurar o gateway desta organização.",
    status: 422,
  },
  credencial_invalida: {
    code: "invalid_provider_key",
    message: "O provedor recusou esta chave. Confira a chave e o ambiente (teste ou produção).",
    status: 422,
  },
  credencial_sem_permissao: {
    code: "provider_key_without_permission",
    message: "A chave existe, mas não tem permissão para cobrar neste provedor.",
    status: 422,
  },
  provedor_fora: {
    code: "provider_unavailable",
    message: "O provedor não respondeu. Nada foi gravado; tente de novo em instantes.",
    status: 502,
  },
  modo_divergente: {
    code: "provider_key_mode_mismatch",
    message: "Esta é uma chave de produção. Use a chave do ambiente desta instalação.",
    status: 422,
  },
  cifra_indisponivel: {
    code: "credential_encryption_unavailable",
    message: "A cifra de credenciais não está configurada nesta instalação; nada foi gravado.",
    status: 422,
  },
  banco_recusou: {
    code: "gateway_save_failed",
    message: "Não foi possível gravar a configuração do gateway.",
    status: 500,
  },
};

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "organization_payment_gateways" });
  if (!authz.ok) return authz.response;

  const estado = await estadoParaTela(createAdminClient(), authz.org.orgId);
  return ok(estado, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  // Guarda de EFEITO antes do RBAC: quem só ACOMPANHA a organização de outra
  // pessoa não troca a conta que recebe o dinheiro dela.
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "organization_payment_gateways" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = putSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const entrada = parsed.data;
  const resultado = await guardarGatewayDaOrganizacao({
    admin: createAdminClient(),
    organizationId: org.orgId,
    userId: user.id,
    provider: entrada.provider,
    apiKey: entrada.api_key,
    webhookSecret: entrada.webhook_secret,
    isActive: entrada.is_active,
  });

  if (!resultado.ok) {
    const resposta = RESPOSTA_POR_ERRO[resultado.erro];
    return fail(resposta.code, resposta.message, resposta.status, { requestId });
  }

  return ok(await estadoParaTela(createAdminClient(), org.orgId), { requestId });
}

export async function DELETE(): Promise<Response> {
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "organization_payment_gateways" });
  if (!authz.ok) return authz.response;

  const resultado = await desligarGatewayDaOrganizacao(
    createAdminClient(),
    authz.org.orgId,
    authz.user.id,
  );
  if (!resultado.ok) {
    const resposta = RESPOSTA_POR_ERRO[resultado.erro];
    return fail(resposta.code, resposta.message, resposta.status, { requestId });
  }

  return ok(await estadoParaTela(createAdminClient(), authz.org.orgId), { requestId });
}
