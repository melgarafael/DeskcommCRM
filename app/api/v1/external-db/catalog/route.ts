import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/external-db/catalog — lê o mapeamento do catálogo da org ativa.
 * PUT /api/v1/external-db/catalog — grava/atualiza o mapeamento (admin).
 *
 * ─── O que isto resolve (migration 0244) ────────────────────────────────────
 * O catálogo do agente (tabela + colunas do banco externo) estava cravado no
 * código (`motos`, `imagem_url`). Aqui o dono escolhe, pela tela de Integração de
 * dados, qual tabela é o catálogo e quais colunas são nome/ano/cor/km/preço/
 * imagem/estoque. O motor passa a ler este mapeamento em vez do hardcode.
 *
 * ─── Validação ao vivo ──────────────────────────────────────────────────────
 * O PUT abre a conexão e confere a tabela e as colunas CONTRA O BANCO EXTERNO
 * (introspecção ao vivo). Gravar um mapeamento que não existe só para falhar no
 * primeiro turno do agente daria uma mensagem pior (o agente "não acha" o
 * catálogo) para o mesmo problema de configuração.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { abrirAcesso } from "@/lib/external-db/acesso";
import { colunasDaTabela } from "@/lib/external-db/introspeccao";
import { salvarCatalogoSchema } from "@/lib/external-db/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = [
  "connection_id",
  "schema_name",
  "table_name",
  "col_nome",
  "col_ano",
  "col_cor",
  "col_km",
  "col_preco",
  "col_imagem",
  "col_estoque",
  "col_cilindrada",
  "col_tipo",
  "busca_operador",
  "enabled",
  "updated_at",
].join(", ");

function mensagemDeAcesso(motivo: string): string {
  switch (motivo) {
    case "nao_encontrada":
      return "essa conexão não existe nesta empresa.";
    case "desativada":
      return "essa conexão está desativada; um administrador precisa ativá-la.";
    case "cifra_indisponivel":
      return "a chave de criptografia da instalação não está disponível.";
    case "host_bloqueado":
      return "o endereço dessa conexão não é um destino permitido pela política de rede.";
    case "dns_falhou":
      return "não foi possível resolver o endereço dessa conexão agora.";
    default:
      return "não foi possível abrir a conexão.";
  }
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_mappings" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_mappings")
    .select(COLUNAS)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao consultar o catálogo.", 500, { requestId });
  }
  return ok({ mapping: data ?? null }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "catalog_mappings" });
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

  const parsed = salvarCatalogoSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  // A conexão tem de existir, estar ativa e pertencer à organização.
  const admin = createAdminClient();
  const { data: conexao } = await admin
    .from("external_db_connections_safe")
    .select("id, enabled")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", input.connection_id)
    .maybeSingle();
  if (!conexao) {
    return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
  }
  if (!conexao.enabled) {
    return fail("validation_failed", t("A conexão está desativada."), 422, { requestId });
  }

  // Confere tabela e colunas AO VIVO no banco externo.
  const acesso = await abrirAcesso(admin, activeOrg.orgId, input.connection_id);
  if (!acesso.ok) {
    return fail("external_db_acesso_negado", t(mensagemDeAcesso(acesso.motivo)), 422, {
      requestId,
      details: { motivo: acesso.motivo },
    });
  }

  let permitidas: Set<string> | null;
  try {
    permitidas = await colunasDaTabela(acesso.pool, input.schema_name, input.table_name);
  } catch {
    return fail("external_db_acesso_negado", t("Não foi possível conferir a tabela agora."), 422, {
      requestId,
    });
  }
  if (permitidas === null) {
    return fail("validation_failed", t("A tabela informada não existe no banco conectado."), 422, {
      requestId,
      details: { tabela: input.table_name, schema: input.schema_name },
    });
  }

  const camposColuna: Array<keyof typeof input> = [
    "col_nome",
    "col_ano",
    "col_cor",
    "col_km",
    "col_preco",
    "col_imagem",
    "col_estoque",
    "col_cilindrada",
    "col_tipo",
  ];
  const inexistentes = camposColuna
    .map((campo) => input[campo])
    .filter((valor): valor is string => typeof valor === "string" && valor !== "")
    .filter((coluna) => !permitidas.has(coluna));
  if (inexistentes.length > 0) {
    return fail("validation_failed", t("Algumas colunas não existem nessa tabela."), 422, {
      requestId,
      details: { colunas_inexistentes: inexistentes, colunas_disponiveis: [...permitidas] },
    });
  }

  const payload = {
    organization_id: activeOrg.orgId,
    connection_id: input.connection_id,
    schema_name: input.schema_name,
    table_name: input.table_name,
    col_nome: input.col_nome,
    col_ano: input.col_ano ?? null,
    col_cor: input.col_cor ?? null,
    col_km: input.col_km ?? null,
    col_preco: input.col_preco ?? null,
    col_imagem: input.col_imagem ?? null,
    col_estoque: input.col_estoque ?? null,
    col_cilindrada: input.col_cilindrada ?? null,
    col_tipo: input.col_tipo ?? null,
    busca_operador: input.busca_operador,
    enabled: input.enabled,
  };

  const { data: salvo, error } = await admin
    .from("catalog_mappings")
    .upsert(payload, { onConflict: "organization_id" })
    .select(COLUNAS)
    .single();

  if (error) {
    return fail("internal_error", "Erro ao salvar o catálogo.", 500, { requestId });
  }

  await audit({
    action: "external_db_catalog.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "catalog_mapping",
    resourceId: input.connection_id,
    requestId,
    metadata: {
      table_name: input.table_name,
      schema_name: input.schema_name,
      colunas: camposColuna.filter((c) => input[c] !== undefined),
      enabled: input.enabled,
    },
  });

  return ok({ mapping: salvo }, { requestId });
}
