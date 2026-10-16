import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/external-db/connections — lista as conexões da org ativa.
 * POST /api/v1/external-db/connections — cria uma conexão (admin).
 *
 * ─── Quem vê, quem configura (D2) ───────────────────────────────────────────
 *
 * A LISTA é de qualquer autenticado: saber que a empresa tem uma fonte de dados
 * não é segredo, e a tela de Integração é de todos. A senha nunca aparece — a
 * leitura sai de `external_db_connections_safe`, que não tem as colunas
 * cifradas. Já CRIAR/editar/apagar é `admin`: é ali que credencial de outro
 * sistema entra no servidor.
 *
 * O POST valida o destino contra a guarda de rede ANTES de gravar. Gravar um
 * host que a política bloqueia só para falhar no primeiro `pg.connect` daria uma
 * mensagem pior (timeout do driver) para o mesmo problema.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { cifrarSenha } from "@/lib/external-db/credenciais";
import { validarHostDeBanco } from "@/lib/external-db/guardas";
import { criarConexaoSchema } from "@/lib/external-db/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { seModuloDesligado } from "../_falha";

export const dynamic = "force-dynamic";

const COLUNAS_SEGURAS =
  "id, organization_id, label, host, port, database_name, username, ssl_mode, enabled, max_rows, max_filters, max_response_bytes, customer_key_column, customer_key_kind, last_tested_at, last_test_ok, last_test_error, created_by, created_at, updated_at, source_mode, sources_count";

/**
 * As escritas (insert/update) voltam da TABELA BASE, que não tem as colunas calculadas da view
 * (`sources_count` só existe em `external_db_connections_safe`). É um texto LITERAL de propósito:
 * o cliente do Supabase tipa o resultado lendo o texto do `select` em compilação, e uma string
 * calculada (`split/filter/join`) vira `GenericStringError`. Mantenha igual a `COLUNAS_SEGURAS`,
 * menos as colunas calculadas.
 */
const COLUNAS_DA_TABELA =
  "id, organization_id, label, host, port, database_name, username, ssl_mode, enabled, max_rows, max_filters, max_response_bytes, customer_key_column, customer_key_kind, last_tested_at, last_test_ok, last_test_error, created_by, created_at, updated_at, source_mode";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("viewer", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("external_db_connections_safe")
    .select(COLUNAS_SEGURAS)
    .eq("organization_id", activeOrg.orgId)
    .order("label", { ascending: true });

  if (error) {
    return fail("internal_error", "Erro ao listar conexões.", 500, { requestId });
  }
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
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

  const parsed = criarConexaoSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

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

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("external_db_connections")
    .insert({
      organization_id: activeOrg.orgId,
      label: input.label,
      host: input.host,
      port: input.port,
      database_name: input.database_name,
      username: input.username,
      ...cifrarSenha(input.password),
      ssl_mode: input.ssl_mode,
      enabled: input.enabled,
      source_mode: "list",
      max_rows: input.max_rows,
      max_filters: input.max_filters,
      max_response_bytes: input.max_response_bytes,
      customer_key_column: input.customer_key_column,
      customer_key_kind: input.customer_key_kind,
      created_by: authUser.id,
    })
    .select(COLUNAS_DA_TABELA)
    .single();

  if (error || !created) {
    if (error?.code === "23505") {
      return fail(
        "external_db_label_em_uso",
        t("Já existe uma conexão com este nome."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao criar conexão.", 500, { requestId });
  }

  await audit({
    action: "external_db_connection.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: created.id,
    requestId,
    metadata: { label: input.label, host: input.host, port: input.port, ssl_mode: input.ssl_mode, source_mode: "list" },
  });

  return ok(created, { status: 201, requestId });
}
