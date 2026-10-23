import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/external-db/connections/:id/recipes (qualquer autenticado)
 * PUT /api/v1/external-db/connections/:id/recipes (admin)
 *
 * As INSTÂNCIAS DE RECEITA da conexão: receita escolhida + parâmetros preenchidos
 * na tela (fixos), gravados na coluna `receitas` (jsonb) de
 * `external_db_connections`. O GET lê com `organization_id` SÓ da sessão e o `id`
 * da conexão (zero linhas → 404). Bruto inválido → lista vazia, nunca 500 mudo.
 *
 * NÃO exige que a receita rode agora: a pré-visualização é que consulta o banco de
 * origem, e só para `mysql` nesta fatia. Se alguma instância só aceita um motor que
 * não é o desta conexão, recusa com `receita_incompatível_com_o_motor` (422).
 *
 * A organização vem do contexto autenticado, nunca do corpo.
 *
 * O audit guarda CONTAGENS (número de instâncias, quantas ativas) — nunca os
 * parâmetros de fixos (podem conter dado do cliente).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { atualizarReceitasSchema, validarFixosDaReceita, lerReceitasDoBanco } from "@/lib/external-db/receitas/instancias";
import { receitaDe } from "@/lib/external-db/receitas/registro";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { seModuloDesligado } from "../../../_falha";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { data, error } = await createAdminClient()
    .from("external_db_connections")
    .select("receitas")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao ler as receitas.", 500, { requestId });
  if (!data) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  // Bruto inválido → lista vazia: o que o assistente enxerga é nada, falha fechada.
  const lida = lerReceitasDoBanco(data.receitas);
  return ok(
    { receitas: lida.ok ? lida.instancias : [] },
    { requestId },
  );
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
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

  const parsed = atualizarReceitasSchema.safeParse(rawBody);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const strings = issue.path.filter((p) => typeof p === "string");
      const chave = strings.length > 0 ? strings[strings.length - 1]! : "receitas";
      (fieldErrors[chave] ??= []).push(issue.message);
    }
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: { fieldErrors },
    });
  }
  const { receitas } = parsed.data;

  // Fixos inválidos são erro de entrada: 422 antes de qualquer leitura do banco.
  for (const inst of receitas) {
    try {
      validarFixosDaReceita(inst.receita, inst.fixos);
    } catch (err) {
      return fail(
        "validation_failed",
        t("Os parâmetros fixos da receita são inválidos."),
        422,
        { requestId, details: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  // Carrega a conexão para conferir o motor (db_type) antes de gravar.
  const admin = createAdminClient();
  const { data: conexao, error: erroConexao } = await admin
    .from("external_db_connections")
    .select("db_type, receitas")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (erroConexao) return fail("internal_error", "Erro ao ler a conexão.", 500, { requestId });
  if (!conexao) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  // Se alguma receita só aceita mysql, a conexão deve ser mysql.
  let receitasIncompativeis = false;
  for (const inst of receitas) {
    const receita = receitaDe(inst.receita);
    if (receita && !receita.motores.includes(conexao.db_type as "mysql" | "postgres")) {
      receitasIncompativeis = true;
    }
  }
  if (receitasIncompativeis) {
    return fail(
      "receita_incompativel_com_o_motor",
      t("Esta conexão não aceita alguma das receitas escolhidas (o banco é do motor errado)."),
      422,
      { requestId },
    );
  }

  const { data: atualizado, error } = await admin
    .from("external_db_connections")
    .update({ receitas })
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .select("receitas")
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao salvar as receitas.", 500, { requestId });
  if (!atualizado) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  const lida = lerReceitasDoBanco(atualizado.receitas);
  const ativas = lida.ok ? lida.instancias.filter((i) => i.ativa).length : 0;

  await audit({
    action: "external_db_recipes.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: id,
    requestId,
    metadata: { receitas: receitas.length, ativas },
  });

  return ok(
    { receitas: lida.ok ? lida.instancias : [] },
    { requestId },
  );
}
