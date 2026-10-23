import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/external-db/connections/:id/recipes/preview (admin)
 *
 * Executa UMA instância de receita com parâmetros de busca vindos do corpo
 * (Zod da receita) e devolve as linhas para a tela. Só-leitura, pela mesma
 * armadura do dialeto (transação READ ONLY + timeouts, tetos da conexão).
 *
 * Auditoria só com contagens (`external_db.recipes.previewed`: linhas, colunas,
 * truncado) — nunca valores.
 *
 * A organização vem do contexto autenticado, nunca do corpo. Uma instância de
 * outra organização ou inexistente → "não encontrada".
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerReceitasDoBanco } from "@/lib/external-db/receitas/instancias";
import { limiteDaReceita } from "@/lib/external-db/receitas/limite";
import { receitaDe } from "@/lib/external-db/receitas/registro";
import { abrirAcesso } from "@/lib/external-db/acesso";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { seModuloDesligado } from "../../../../_falha";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O corpo da pré-visualização: qual instância e com quais parâmetros de busca. */
const previewBodySchema = z
  .object({
    instancia_id: z.string().uuid().describe("A instância de receita a executar."),
    busca: z
      .unknown()
      .optional()
      .describe("Os parâmetros de busca da receita (validados pelo Zod dela)."),
  })
  .strict();

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
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

  const rateLimit = await checkRateLimit(`external-db:write:${activeOrg.orgId}`, 30, 60);
  if (!rateLimit.allowed) {
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

  const parsed = previewBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { instancia_id, busca } = parsed.data;

  // Carrega a conexão com filtro de organização (nunca o id do corpo escapa daqui).
  const admin = createAdminClient();
  const { data: conexao, error: erroConexao } = await admin
    .from("external_db_connections")
    .select("id, db_type, receitas, max_response_bytes, max_rows")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (erroConexao) return fail("internal_error", "Erro ao ler a conexão.", 500, { requestId });
  if (!conexao) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  // A instância está na coluna `receitas` da mesma linha — organização já filtrada.
  const lida = lerReceitasDoBanco(conexao.receitas);
  if (!lida.ok) return fail("internal_error", "As receitas da conexão estão corrompidas.", 500, { requestId });
  const instancia = lida.instancias.find((i) => i.id === instancia_id);
  if (!instancia) return fail("not_found", t("Receita não encontrada nesta conexão."), 404, { requestId });

  const receita = receitaDe(instancia.receita);
  if (!receita) return fail("not_found", t("Receita não encontrada."), 404, { requestId });
  if (!receita.motores.includes(conexao.db_type as "mysql" | "postgres")) {
    return fail(
      "receita_incompativel_com_o_motor",
      t("Esta receita não roda no motor desta conexão."),
      422,
      { requestId },
    );
  }

  // Valida os parâmetros de busca pelo Zod da receita.
  let buscaValidada: unknown;
  try {
    buscaValidada = receita.parametrosDaBusca.parse(busca ?? {});
  } catch (err) {
    return fail("validation_failed", t("Parâmetros de busca inválidos."), 422, {
      requestId,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  // Limite igual à ferramenta do agente — mesma conta em
  // lib/external-db/receitas/limite.
  const { limiteItens, limiteMax } = limiteDaReceita({
    buscaLimite: (buscaValidada as { limite?: number }).limite,
    tetoDeItens: receita.tetoDeItens,
    maxRows: conexao.max_rows,
    termos: (buscaValidada as { termos?: unknown[] })?.termos,
  });

  const { sql, valores } = receita.montar(instancia.fixos, buscaValidada, limiteItens);

  const prefixo = (instancia.fixos as { prefixo?: string }).prefixo ?? "wp_";
  const tabelasPermitidas = receita.tabelas(prefixo);

  const acesso = await abrirAcesso(admin, activeOrg.orgId, id);
  if (!acesso.ok) {
    return fail("acesso_negado", t("Não foi possível abrir a conexão."), 500, { requestId });
  }

  let resultado;
  try {
    resultado = await acesso.dialeto.executarReceita(
      { sql, valores, tabelas: tabelasPermitidas, colunasPorTabela: receita.colunas(prefixo) },
      { limiteMax },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "FonteNaoLiberadaError") {
      return fail("fonte_nao_liberada", t("Uma tabela da receita não foi liberada pelo administrador desta conexão."), 422, { requestId });
    }
    return fail("falha_na_leitura", t("Não foi possível consultar o banco de origem agora."), 500, { requestId });
  }

  await audit({
    action: "external_db_recipes.previewed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: id,
    requestId,
    metadata: { instancia: instancia.id, receita: instancia.receita, linhas: resultado.linhas.length, colunas: resultado.colunas.length, truncado: !!resultado.truncado },
  });

  return ok(
    {
      instancia: { id: instancia.id, receita: instancia.receita, rotulo: instancia.rotulo },
      colunas: resultado.colunas,
      linhas: resultado.linhas,
      linhas_devolvidas: resultado.linhas.length,
      ...(resultado.truncado ? { truncado: true } : {}),
    },
    { requestId },
  );
}
