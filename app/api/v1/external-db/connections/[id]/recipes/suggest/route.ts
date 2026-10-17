/**
 * POST /api/v1/external-db/connections/:id/recipes/suggest (admin)
 *
 * Sugere os `meta_key` mais frequentes de um `post_type` do WordPress/ACF,
 * para o admin preencher o mapeamento da receita `acf-imoveis`. Só-leitura:
 * consulta fixa com `count(*)`, sem `meta_key` que comece por `_`,
 * limitada a 50, passando pelas fontes liberadas e pelo validador.
 *
 * Se o banco tiver tabelas do JetEngine (`<prefixo>jet_*`), diz isso na resposta
 * ("parece JetEngine; a receita dele vem depois").
 *
 * Auditoria só com contagens (never valores de meta_key).
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { validarConsultaDeReceita } from "@/lib/external-db/receitas/validador";
import {
  prefixoSchema,
  postTypeSchema,
  quotarIdentificadorMysql,
} from "@/lib/external-db/receitas/acf-imoveis";
import { abrirAcesso } from "@/lib/external-db/acesso";
import { createAdminClient } from "@/lib/supabase/admin";

import { seModuloDesligado } from "../../../../_falha";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const suggestBodySchema = z
  .object({
    receita: z
      .literal("acf-imoveis")
      .describe("A receita a ser sugerida (só acf-imoveis nesta fatia)."),
    prefixo: prefixoSchema.describe("Prefixo das tabelas do WordPress (ex.: wp_)."),
    post_type: postTypeSchema.describe("Tipo de post do WordPress (ex.: imovel)."),
  })
  .strict();

/** Consulta fixa: meta_key mais frequentes de um post_type, excluindo as internas do ACF (_*). */
function consultaSugestao(prefixo: string): string {
  const posts = quotarIdentificadorMysql(`${prefixo}posts`);
  const postmeta = quotarIdentificadorMysql(`${prefixo}postmeta`);
  return `
    select pm.meta_key as meta_key, count(*) as frequencia
    from ${postmeta} pm
    join ${posts} p on p.ID = pm.post_id
    where p.post_type = ?
      and pm.meta_key not like '\\_%%'
    group by pm.meta_key
    order by frequencia desc
    limit 50
  `;
}

/** Heurística simples: mapeia nomes de meta_key comuns para os campos da receita. */
function sugerirMapeamento(metaKeys: string[]): Record<string, string | null> {
  const mapa: Record<string, string | null> = {
    preco: null,
    quartos: null,
    bairro: null,
    cidade: null,
    area: null,
    finalidade: null,
  };
  for (const mk of metaKeys) {
    const lower = mk.toLowerCase();
    if (!mapa.preco && /preco|valor|price/.test(lower)) mapa.preco = mk;
    else if (!mapa.quartos && /quarto|dormit|bedroom/.test(lower)) mapa.quartos = mk;
    else if (!mapa.bairro && /bairro|neighborhood/.test(lower)) mapa.bairro = mk;
    else if (!mapa.cidade && /cidade|city/.test(lower)) mapa.cidade = mk;
    else if (!mapa.area && /area|metragem|m2|sqm/.test(lower)) mapa.area = mk;
    else if (!mapa.finalidade && /finalidade|tipo|purpose|sale|rent/.test(lower))
      mapa.finalidade = mk;
  }
  return mapa;
}

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

  const limite = await checkRateLimit(`external-db:write:${activeOrg.orgId}`, 30, 60);
  if (!limite.allowed) {
    return fail(
      "rate_limited",
      t("Muitas alterações em pouco tempo. Tente de novo em instantes."),
      429,
      {
        requestId,
      },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = suggestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { receita, prefixo, post_type } = parsed.data;

  // Só a receita acf-imoveis tem sugestão nesta fatia.
  if (receita !== "acf-imoveis") {
    return fail(
      "validation_failed",
      t("Esta receita não tem sugestão de campos nesta fatia."),
      422,
      {
        requestId,
      },
    );
  }

  // Carrega a conexão para verificar o motor.
  const admin = createAdminClient();
  const { data: conexao, error: erroConexao } = await admin
    .from("external_db_connections")
    .select("id, db_type")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (erroConexao) return fail("internal_error", "Erro ao ler a conexão.", 500, { requestId });
  if (!conexao) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
  if (conexao.db_type !== "mysql") {
    return fail(
      "receita_incompativel_com_o_motor",
      t("A sugestão de campos só está disponível para conexões MySQL."),
      422,
      { requestId },
    );
  }

  // Abre o pool de leitura para rodar a consulta fixa.
  const acesso = await abrirAcesso(admin, activeOrg.orgId, id);
  if (!acesso.ok) {
    return fail("acesso_negado", t("Não foi possível abrir a conexão."), 500, { requestId });
  }

  const sql = consultaSugestao(prefixo);
  const tabelas = [`${prefixo}posts`, `${prefixo}postmeta`];

  // Passa pelo validador (segunda trava) antes de rodar.
  try {
    validarConsultaDeReceita(sql, tabelas);
  } catch {
    return fail("validation_failed", t("Consulta de sugestão não é válida."), 422, { requestId });
  }

  let linhas: { meta_key: string; frequencia: number }[];
  try {
    const resultado = await acesso.dialeto.executarReceita(
      {
        sql,
        valores: [post_type],
        tabelas,
        colunasPorTabela: {
          [`${prefixo}posts`]: ["ID", "post_type"],
          [`${prefixo}postmeta`]: ["post_id", "meta_key"],
        },
      },
      { limiteMax: 50 },
    );
    linhas = (resultado.linhas ?? []) as { meta_key: string; frequencia: number }[];
  } catch (err) {
    if (err instanceof Error && err.name === "FonteNaoLiberadaError") {
      return fail(
        "fonte_nao_liberada",
        t("Uma tabela da receita não foi liberada pelo administrador desta conexão."),
        422,
        {
          requestId,
        },
      );
    }
    return fail("falha_na_leitura", t("Não foi possível consultar o banco de origem agora."), 500, {
      requestId,
    });
  }

  const metaKeys = linhas.map((l) => l.meta_key);
  const mapeamento = sugerirMapeamento(metaKeys);

  // Deteta JetEngine pelo nome das tabelas (consulta fixa, sem meta_key crua).
  let avisoJetEngine: string | null = null;
  try {
    const schema = acesso.dialeto.schemaDasReceitas();
    const resultadoJet = await acesso.dialeto.executarReceita(
      {
        sql: `select table_name as table_name from information_schema.tables where table_schema = ? and table_name like ? limit 5`,
        valores: [schema, `${prefixo}jet_%`],
        tabelas: [],
        colunasPorTabela: {},
      },
      { limiteMax: 5 },
    );
    const jetRows = (resultadoJet.linhas ?? []) as { table_name: string }[];
    const temJet = jetRows.length > 0;
    if (temJet) {
      avisoJetEngine = "parece JetEngine; a receita dele vem depois";
    }
  } catch {
    // Se não conseguir listar tabelas, ignora o aviso — não é crítico.
  }

  await audit({
    action: "external_db_recipes.suggested",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: id,
    requestId,
    metadata: { receita, prefixo, post_type, sugestoes: metaKeys.length },
  });

  return ok(
    {
      receita,
      prefixo,
      post_type,
      meta_keys: metaKeys,
      mapeamento_sugerido: mapeamento,
      ...(avisoJetEngine ? { aviso: avisoJetEngine } : {}),
    },
    { requestId },
  );
}
