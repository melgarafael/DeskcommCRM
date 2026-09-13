import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/external-db/connections/:id — detalhe (qualquer autenticado)
 * PATCH  /api/v1/external-db/connections/:id — atualiza (admin)
 * DELETE /api/v1/external-db/connections/:id — remove (admin)
 *
 * A senha nunca sai daqui: a leitura vem da `_safe` view e a escrita só aceita
 * `password` em claro para cifrar NA HORA. O `PATCH` sem `password` preserva a
 * senha guardada — separar "editar o rótulo" de "rotacionar a credencial" evita
 * que trocar o nome apague a senha sem ninguém pedir.
 *
 * O DELETE fecha o pool em memória (`fecharPool`): sem isso, uma conexão
 * removida continuaria com socket aberto no processo até o idle timeout.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { cifrarSenha } from "@/lib/external-db/credenciais";
import { fecharPool } from "@/lib/external-db/conexao";
import { validarHostDeBanco } from "@/lib/external-db/guardas";
import { atualizarConexaoSchema } from "@/lib/external-db/schemas";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS_SEGURAS =
  "id, organization_id, label, host, port, database_name, username, ssl_mode, enabled, max_rows, max_filters, max_response_bytes, last_tested_at, last_test_ok, last_test_error, created_by, created_at, updated_at";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("external_db_connections_safe")
    .select(COLUNAS_SEGURAS)
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao consultar a conexão.", 500, { requestId });
  }
  if (!data) return fail("not_found", "Conexão não encontrada.", 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const limite = await checkRateLimit(`external-db:write:${activeOrg.orgId}`, 30, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas alterações em pouco tempo. Tente de novo em instantes."), 429, {
      requestId,
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = atualizarConexaoSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  if (Object.keys(input).length === 0) {
    return fail("validation_failed", t("Nada para atualizar."), 422, { requestId });
  }

  if (input.host !== undefined) {
    const alvo = await validarHostDeBanco(input.host);
    if (!alvo.ok) {
      const dns = alvo.motivo === "dns_falhou" || alvo.motivo === "dns_vazio";
      return fail(
        dns ? "validation_failed" : "external_db_destino_bloqueado",
        dns
          ? t("Não foi possível resolver o endereço informado. Confira o host.")
          : t("O endereço informado não é um destino permitido pela política de rede."),
        422,
        { requestId, details: { motivo: alvo.motivo } },
      );
    }
  }

  const { password, ...campos } = input;
  const patch: Record<string, unknown> = { ...campos };
  if (password !== undefined) Object.assign(patch, cifrarSenha(password));

  const admin = createAdminClient();
  const { data: atualizado, error } = await admin
    .from("external_db_connections")
    .update(patch)
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .select(COLUNAS_SEGURAS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("external_db_label_em_uso", t("Já existe uma conexão com este nome."), 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao atualizar a conexão.", 500, { requestId });
  }
  if (!atualizado) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  // Trocar host/porta/tls/senha cria uma conexão DIFERENTE: o pool antigo tem de
  // morrer, senão a próxima leitura usa a credencial velha que ainda está viva.
  if (
    password !== undefined ||
    input.host !== undefined ||
    input.port !== undefined ||
    input.username !== undefined ||
    input.database_name !== undefined ||
    input.ssl_mode !== undefined
  ) {
    await fecharPool(id);
  }

  await audit({
    action: "external_db_connection.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: id,
    requestId,
    metadata: {
      campos: Object.keys(input),
      senha_trocada: password !== undefined,
    },
  });

  return ok(atualizado, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();
  const { data: removido, error } = await admin
    .from("external_db_connections")
    .delete()
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .select("id, label")
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao remover a conexão.", 500, { requestId });
  }
  if (!removido) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  await fecharPool(id);

  await audit({
    action: "external_db_connection.deleted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: id,
    requestId,
    metadata: { label: removido.label },
  });

  return ok({ id, deleted: true }, { requestId });
}
