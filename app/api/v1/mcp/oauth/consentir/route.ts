import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/mcp/oauth/consentir — a decisão da pessoa na tela de
 * consentimento (`/oauth/mcp/consentir`). Sessão por cookie, nunca bearer.
 *
 * Permitir emite o código de autorização (uso único, 5 min, só o hash no
 * banco) e devolve o endereço de volta do cliente; negar devolve o mesmo
 * endereço com `error=access_denied`. A tela navega até ele.
 *
 * Quem pode: ADMIN da organização escolhida — a mesma régua de quem emite token
 * de API na tela (`/api/v1/settings/api-tokens`), porque a conexão É um token
 * de API. A organização vem do corpo como ESCOLHA da pessoa, e a autoridade não
 * vem do corpo: `requireRole("admin", { organizationId })` confere o vínculo e
 * o papel no banco (`fn_user_role_in_org`), e a renovação re-confere a cada
 * hora (`fn_mcp_oauth_ainda_admin`). Acompanhamento de suporte não autoriza
 * conexão: o acesso de suporte é emprestado e com prazo, uma conexão OAuth
 * duraria além dele.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { buscarCliente } from "@/lib/mcp/oauth/clientes";
import { enderecosOAuth, escoposPedidos, escritaOferecida, PRAZOS, recursoConfere, type EscopoMcp } from "@/lib/mcp/oauth/config";
import { consentimentoSchema } from "@/lib/mcp/oauth/esquemas";
import { oauthMcpLimitado } from "@/lib/mcp/oauth/limites";
import { urlDeVoltaComCodigo, urlDeVoltaComErro } from "@/lib/mcp/oauth/respostas";
import { byteaDoHash, novoCodigo } from "@/lib/mcp/oauth/segredos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("validation_failed", "Corpo inválido.", 400, { requestId });
  }
  const parsed = consentimentoSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", "Pedido de autorização inválido.", 400, {
      requestId,
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  const c = parsed.data;

  const authz = await requireRole("admin", { requestId, resource: "mcp_oauth", organizationId: c.organization_id });
  if (!authz.ok) return authz.response;
  const { user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  if (user.support) {
    return fail("forbidden", t("Durante um acompanhamento de suporte não é possível conectar aplicativos."), 403, { requestId });
  }
  if (await oauthMcpLimitado("consentimento", user.id)) {
    return fail("rate_limited", t("Muitas tentativas. Espere alguns minutos."), 429, { requestId });
  }

  const admin = createAdminClient();
  const cliente = await buscarCliente(admin, c.client_id);
  if (!cliente || !cliente.redirect_uris.includes(c.redirect_uri)) {
    return fail("not_found", t("Este aplicativo não está registrado, ou o endereço de volta não confere."), 404, { requestId });
  }
  const e = enderecosOAuth();
  if (!recursoConfere(c.resource, e.recurso)) {
    return fail("validation_failed", t("O aplicativo pediu acesso a outro endereço."), 400, { requestId });
  }

  const auditoriaBase = {
    actorUserId: user.id,
    organizationId: c.organization_id,
    resourceType: "mcp_oauth_cliente",
    resourceId: cliente.id,
    requestId,
  };
  const redirectHost = new URL(c.redirect_uri).host;

  if (c.decisao === "negar") {
    await audit({ ...auditoriaBase, action: "mcp_oauth.negado", metadata: { client_name: cliente.nome, redirect_host: redirectHost } });
    return ok({ redirect_to: urlDeVoltaComErro(c.redirect_uri, "access_denied", c.state, e.issuer) }, { requestId });
  }

  const pedidos = escoposPedidos(c.scope);
  if (c.acesso === "leitura_e_escrita" && !escritaOferecida(pedidos)) {
    return fail("validation_failed", t("O aplicativo não pediu permissão para alterar dados."), 400, { requestId });
  }
  const escopos: EscopoMcp[] = c.acesso === "leitura_e_escrita" ? ["mcp:read", "mcp:write"] : ["mcp:read"];

  const codigo = novoCodigo();
  const { error } = await admin.from("mcp_oauth_codigos").insert({
    organization_id: c.organization_id,
    cliente_id: cliente.id,
    user_id: user.id,
    codigo_hash: byteaDoHash(codigo),
    code_challenge: c.code_challenge,
    redirect_uri: c.redirect_uri,
    escopos,
    recurso: e.recurso,
    expira_em: new Date(Date.now() + PRAZOS.codigo * 1000).toISOString(),
  });
  if (error) {
    logger.error("[mcp-oauth.consentir] insert failed", { request_id: requestId, error: error.message });
    return fail("internal_error", t("Não foi possível concluir a autorização. Tente de novo."), 500, { requestId });
  }

  await audit({
    ...auditoriaBase,
    action: "mcp_oauth.autorizado",
    metadata: { client_name: cliente.nome, redirect_host: redirectHost, escopos },
  });

  return ok({ redirect_to: urlDeVoltaComCodigo(c.redirect_uri, codigo, c.state, e.issuer) }, { requestId });
}
