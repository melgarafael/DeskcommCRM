import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/external-db/connections/:id/test (admin)
 *
 * Abre um `Client` descartável (não polui o cache de pools), roda `select 1` e
 * grava o resultado em `last_tested_*`. A resposta é 200 mesmo quando o teste
 * FALHA: o resultado é dado para a tela, não erro do pedido — quem quis testar
 * recebeu a informação que pediu.
 *
 * O erro gravado é truncado e passa pelo mesmo `mensagemSegura` do núcleo: a
 * mensagem do driver pode citar host/porta, nunca a senha.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { carregarConexao } from "@/lib/external-db/credenciais";
import { testarConexao } from "@/lib/external-db/conexao";
import { validarHostDeBanco } from "@/lib/external-db/guardas";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeAcesso, seModuloDesligado } from "../../../_falha";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const limite = await checkRateLimit(`external-db:test:${activeOrg.orgId}`, 10, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitos testes seguidos. Tente de novo em instantes."), 429, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const leitura = await carregarConexao(admin, activeOrg.orgId, id);
  if (!leitura.ok) return respostaDeAcesso(leitura.motivo, { requestId, idioma: authUser.idioma });

  const alvo = await validarHostDeBanco(leitura.conexao.host);
  if (!alvo.ok) return respostaDeAcesso("host_bloqueado", { requestId, idioma: authUser.idioma });

  const resultado = await testarConexao(leitura.conexao);
  const agora = new Date().toISOString();

  await admin
    .from("external_db_connections")
    .update({
      last_tested_at: agora,
      last_test_ok: resultado.ok,
      last_test_error: resultado.ok ? null : resultado.erro,
    })
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id);

  await audit({
    action: "external_db_connection.tested",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: id,
    requestId,
    metadata: { ok: resultado.ok },
  });

  return ok(
    resultado.ok ? { ok: true, testado_em: agora } : { ok: false, erro: resultado.erro, testado_em: agora },
    { requestId },
  );
}
