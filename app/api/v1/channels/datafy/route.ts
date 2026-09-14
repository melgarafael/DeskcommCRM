import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Rotas de conexão do parceiro Graph-compatível: estado (GET) e conectar (POST).
 *
 * A conexão é SÓ com o token (decisão do dono): o sistema chama `GET /me` no
 * provedor e descobre o `phone_number_id`/`waba_id` sozinho, em vez de pedir ao
 * operador que cace o id no painel.
 *
 * A rota não nomeia o provider nem as colunas dele: fala em "número", "token" e
 * "webhook", e delega a persistência a `lib/channels/graph-parceiro/` — é o que
 * o `lint:channels` cobra. O rótulo visível do canal vem do seam
 * (`lib/channels/rotulos.ts`), nunca daqui.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  findGraphPartnerSession,
  saveGraphPartnerSession,
} from "@/lib/channels/graph-parceiro/session";
import { validateGraphPartnerCredentials } from "@/lib/channels/graph-parceiro/validate-credentials";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  token: z.string().trim().min(20),
});

/**
 * Base pública desta instalação — é o que o operador cola no painel do provedor.
 * `env.*` e não `process.env.NEXT_PUBLIC_APP_URL` direto: variáveis públicas são
 * substituídas no BUILD e a imagem genérica traz `placeholder.invalid`.
 */
function publicBase(req: NextRequest): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  return usavel ?? req.headers.get("origin") ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_graph_partner" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const sessao = await findGraphPartnerSession(admin, authz.org.orgId);
  const ativa = sessao && !sessao.archivedAt ? sessao : null;
  const base = publicBase(req);

  return ok({
    connected: Boolean(ativa),
    channel_session_id: ativa?.id ?? null,
    hasToken: Boolean(ativa?.hasToken),
    phoneNumberId: ativa?.phoneNumberId ?? null,
    wabaId: ativa?.wabaId ?? null,
    displayName: ativa?.displayName ?? null,
    phoneNumber: ativa?.phoneNumber ?? null,
    status: ativa?.status ?? null,
    webhook: ativa
      ? {
          callbackUrl: `${base}/api/v1/webhooks/channel/${ativa.webhookPathToken}`,
          // A assinatura do provedor é opcional (só existe quando ativada no
          // painel, com um secret próprio). A proteção é a URL secreta acima.
          signatureOptional: true,
        }
      : null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_graph_partner" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Informe o token do provedor parceiro."), 422, { requestId });
  }
  const { token } = parsed.data;

  const validacao = await validateGraphPartnerCredentials({ token });
  if (!validacao.ok) {
    return fail("invalid_request", validacao.motivo, 422, { requestId });
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    return fail(
      "invalid_request",
      t(
        "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado",
      ),
      422,
      { requestId },
    );
  }

  // A busca enxerga também a linha arquivada (é ela que o POST ressuscita).
  const existente = await findGraphPartnerSession(admin, authz.org.orgId);

  const { error } = await saveGraphPartnerSession(admin, {
    organizationId: authz.org.orgId,
    existingId: existente?.id ?? null,
    existingArchivedAt: existente?.archivedAt ?? null,
    phoneNumberId: validacao.phoneNumberId,
    wabaId: validacao.wabaId,
    tokenEncrypted: cifrado,
    phoneNumber: validacao.displayPhoneNumber
      ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}`
      : null,
    displayName: validacao.verifiedName ?? "Provedor parceiro",
    userId: authz.user.id,
    requestId,
  });

  if (error) {
    return fail("internal_error", error, 500, { requestId });
  }

  return ok({
    connected: true,
    phoneNumberId: validacao.phoneNumberId,
    wabaId: validacao.wabaId,
    displayName: validacao.verifiedName ?? "Provedor parceiro",
    phoneNumber: validacao.displayPhoneNumber,
  });
}
