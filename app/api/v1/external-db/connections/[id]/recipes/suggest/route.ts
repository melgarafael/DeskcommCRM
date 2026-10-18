/**
 * POST /api/v1/external-db/connections/:id/recipes/suggest (admin)
 *
 * Sugere colunas/campos para preencher o mapeamento de uma receita. Só-leitura:
 * consulta fixa passando pelas fontes liberadas e pelo validador.
 *
 * O corpo usa uma união discriminada por `receita`:
 *  - acf-imoveis: { receita, prefixo, post_type } → meta_key mais frequentes do post_type
 *  - tabela-direta: { receita, tabela } → colunas da tabela com sugestão por nome
 *  - jetengine-imoveis: { receita, prefixo } → tabelas <prefixo>jet_cct_% existentes
 *
 * Auditoria só com contagens (never valores de meta_key/coluna).
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

const tabelaSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]{1,64}$/, "Use apenas letras, números e underline no nome da tabela.");

/** Esquema do corpo: união discriminada por `receita`. */
const suggestBodySchema = z.discriminatedUnion("receita", [
    z.object({
      receita: z.literal("acf-imoveis"),
      prefixo: prefixoSchema.describe("Prefixo das tabelas do WordPress (ex.: wp_)."),
      post_type: postTypeSchema.describe("Tipo de post do WordPress (ex.: imovel)."),
    }),
    z.object({
      receita: z.literal("tabela-direta"),
      tabela: tabelaSchema.describe("Nome da tabela plana do banco externo."),
    }),
    z.object({
      receita: z.literal("jetengine-imoveis"),
      prefixo: prefixoSchema.describe("Prefixo das tabelas do WordPress (ex.: wp_)."),
    }),
  ]);

/** Consulta fixa: meta_key mais frequentes de um post_type, excluindo as internas do ACF (_*). */
function consultaSugestaoACF(prefixo: string): string {
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

/** Heurística simples: mapeia nomes de meta_key comuns para os campos da receita ACF. */
function sugerirMapeamentoACF(metaKeys: string[]): Record<string, string | null> {
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

/** Heurística simples: mapeia nomes de coluna para campos da tabela-direta. */
function sugerirMapeamentoTabelaDireta(colunas: string[]): Record<string, string | null> {
  const mapa: Record<string, string | null> = {
    id: null,
    titulo: null,
    preco: null,
    filtro_numero: null,
    imagem: null,
  };
  for (const c of colunas) {
    const lower = c.toLowerCase();
    if (!mapa.id && /^(id|codigo|codigo_externo)$/.test(lower)) mapa.id = c;
    else if (!mapa.titulo && /^(nome|titulo|modelo|descricao)$/.test(lower)) mapa.titulo = c;
    else if (!mapa.preco && /^(preco|valor|price)$/.test(lower)) mapa.preco = c;
    else if (!mapa.filtro_numero && /^(ano|year)$/.test(lower)) mapa.filtro_numero = c;
    else if (!mapa.imagem && /^(foto|imagem|image|thumbnail|img|photo)$/.test(lower)) mapa.imagem = c;
  }
  return mapa;
}

/** Heurística simples: mapeia nomes de coluna para campos do JetEngine. */
function sugerirMapeamentoJetEngine(colunas: string[]): Record<string, string | null> {
  const mapa: Record<string, string | null> = {
    preco: null,
    quartos: null,
    bairro: null,
    cidade: null,
    area: null,
    titulo: null,
    imagem: null,
  };
  for (const c of colunas) {
    const lower = c.toLowerCase();
    if (!mapa.preco && /preco|valor|price/.test(lower)) mapa.preco = c;
    else if (!mapa.quartos && /quarto|dormit|bedroom/.test(lower)) mapa.quartos = c;
    else if (!mapa.bairro && /bairro|neighborhood/.test(lower)) mapa.bairro = c;
    else if (!mapa.cidade && /cidade|city/.test(lower)) mapa.cidade = c;
    else if (!mapa.area && /area|metragem|m2|sqm/.test(lower)) mapa.area = c;
    else if (!mapa.titulo && /^(nome|titulo|titulo_imovel|imovel)$/.test(lower)) mapa.titulo = c;
    else if (!mapa.imagem && /^(foto|imagem|image|thumbnail|img|photo)$/.test(lower)) mapa.imagem = c;
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
      { requestId },
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

  const { receita } = parsed.data;

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

  const schema = acesso.dialeto.schemaDasReceitas();

  if (receita === "acf-imoveis") {
    const { prefixo, post_type } = parsed.data;

    const sql = consultaSugestaoACF(prefixo);
    const tabelas = [`${prefixo}posts`, `${prefixo}postmeta`];

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
          { requestId },
        );
      }
      return fail("falha_na_leitura", t("Não foi possível consultar o banco de origem agora."), 500, {
        requestId,
      });
    }

    const metaKeys = linhas.map((l) => l.meta_key);
    const mapeamento = sugerirMapeamentoACF(metaKeys);

    // Deteta JetEngine: se houver tabelas jet_cct_*, o admin deve usar jetengine-imoveis.
    let avisoJetEngine: string | null = null;
    try {
      // Catálogo já filtrado pelas fontes liberadas: sem SQL de catálogo.
      const tabelas = await acesso.dialeto.listarTabelas();
      if (tabelas.some((x) => x.nome.startsWith(`${prefixo}jet_cct_`))) {
        avisoJetEngine =
          "parece JetEngine; use a receita jetengine-imoveis para este tipo de conteúdo";
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

  if (receita === "tabela-direta") {
    const { tabela } = parsed.data;

    // Colunas pelo dialeto, que respeita as fontes liberadas: `null` = a tabela
    // não existe OU não foi liberada.
    const colunasLiberadas = await acesso.dialeto.colunasDaTabela(schema, tabela);
    if (colunasLiberadas === null) {
      return fail(
        "fonte_nao_liberada",
        t("Libere a tabela {tabela} nas fontes da conexão primeiro.").replace("{tabela}", tabela),
        422,
        { requestId },
      );
    }
    const colunasDoBanco = [...colunasLiberadas];
    const mapeamento = sugerirMapeamentoTabelaDireta(colunasDoBanco);

    await audit({
      action: "external_db_recipes.suggested",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "external_db_connection",
      resourceId: id,
      requestId,
      metadata: { receita, tabela, sugestoes: colunasDoBanco.length },
    });

    return ok(
      {
        receita,
        tabela,
        colunas: colunasDoBanco,
        mapeamento_sugerido: mapeamento,
      },
      { requestId },
    );
  }

  if (receita === "jetengine-imoveis") {
    const { prefixo } = parsed.data;

    // Catálogo já filtrado pelas fontes liberadas; fica só o que é CCT do prefixo.
    const todas = await acesso.dialeto.listarTabelas();
    const ccts = todas
      .filter((x) => x.nome.startsWith(`${prefixo}jet_cct_`))
      .slice(0, 50)
      .map((x) => {
        const colunas = x.colunas.map((c) => c.nome);
        return { tabela: x.nome, colunas, mapeamento: sugerirMapeamentoJetEngine(colunas) };
      });

    await audit({
      action: "external_db_recipes.suggested",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "external_db_connection",
      resourceId: id,
      requestId,
      metadata: { receita, prefixo, ccts: ccts.length },
    });

    return ok(
      {
        receita,
        prefixo,
        ccts,
      },
      { requestId },
    );
  }

  // Não chega aqui: a união discriminada cobre todos os casos.
  return fail("validation_failed", t("Receita não suportada para sugestão."), 422, {
    requestId,
  });
}
