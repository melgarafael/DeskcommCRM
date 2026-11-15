import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/products/feed — a revenda publica o estoque, o catálogo acompanha.
 *
 * ─── O que esta rota é ──────────────────────────────────────────────────────
 *
 * A INTERFACE da fonte de catálogo (issue #3587, fatia 2). Ela recebe o feed de
 * três jeitos, e essa é a diferença entre conferir e sincronizar:
 *
 *  - `url`  — o endereço que a revenda publica. A rota busca, planeja e (se
 *             `dry_run: false`) aplica. É também o que o cron `catalog-feed-sync`
 *             passa a rodar sozinho: a fonte fica gravada em
 *             `catalog_feed_sources`, uma por organização.
 *  - `conteudo` — o texto do feed, colado ou vindo de um teste da integração.
 *  - `itens`    — a lista já parseada, para quem integra pelo ERP.
 *
 * `dry_run` é o PADRÃO (`true`), porque a operação mexe no preço que o agente de
 * IA responde ao cliente: quem chama vê o plano ANTES, e só quem manda
 * `dry_run: false` escreve. No `dry_run` não há INSERT, UPDATE nem DELETE — nem
 * da fonte.
 *
 * ─── O que NUNCA acontece aqui ──────────────────────────────────────────────
 *
 * Nada é APAGADO. O item que saiu do feed vira `ativo = false` (ver
 * `lib/catalogo/feed-aplicacao.ts`): histórico de conversa e proposta apontam
 * para a linha do produto, e apagar deixaria a proposta apontando para o nada.
 *
 * ─── A organização vem do COOKIE ────────────────────────────────────────────
 *
 * `requireRole("manager")` resolve a organização ativa do cookie validado
 * contra o membership — nunca do corpo. Um `organization_id` no corpo é
 * descartado pelo schema (zod), e é assim que tem de ser: aceitar o do corpo
 * seria escrever no catálogo de outra loja com o papel de `manager` da própria.
 *
 * `manager` e não `viewer` porque isto é preço de venda: papel de leitura não
 * altera catálogo (a mesma régua de `POST /api/v1/products` e da planilha).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  FORMATOS_DO_FEED,
  type FormatoDoFeed,
  lerFeed,
  planejarRodada,
  type ProdutoDoCatalogo,
  type PlanoDaRodada,
  resumoDoPlano,
} from "@/lib/catalogo/feed";
import { aplicarPlano, type BancoDoFeed, type CamposDoUpdate, type LinhaDoProduto } from "@/lib/catalogo/feed-aplicacao";
import { buscarFeedDaUrl } from "@/lib/catalogo/feed-remoto";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** O teto de itens de UMA rodada — declarado no PR e coberto pelo schema. */
export const MAXIMO_DE_ITENS = 5_000;

/**
 * Campo do produto → chave do item no feed. Explicitamente listado (e não
 * derivado de `CAMPOS_DO_FEED`) porque o schema é a fronteira: campo novo no
 * domínio não deve entrar na API sem alguém decidir que entra.
 */
const mapeamentoSchema = z
  .object({
    id_externo: z.string().trim().min(1).max(80),
    nome: z.string().trim().min(1).max(80),
    preco: z.string().trim().min(1).max(80),
    descricao: z.string().trim().min(1).max(80),
    fotos: z.string().trim().min(1).max(80),
    quantidade: z.string().trim().min(1).max(80),
  })
  .partial();

const corpoSchema = z
  .object({
    // Olhar antes de escrever é o padrão: a rodada mexe no preço que o agente
    // responde ao cliente.
    dry_run: z.boolean().default(true),
    formato: z.enum(FORMATOS_DO_FEED).default("json"),
    url: z.string().trim().url().max(2000).optional(),
    conteudo: z.string().min(1).max(8 * 1024 * 1024).optional(),
    itens: z.array(z.record(z.string(), z.unknown())).min(1).max(MAXIMO_DE_ITENS).optional(),
    mapeamento: mapeamentoSchema.optional(),
    /** `false` mantém a fonte fora do cron (rodada avulsa pela URL). */
    salvar_fonte: z.boolean().optional(),
  })
  .refine(
    (corpo) => [corpo.url, corpo.conteudo, corpo.itens].filter((v) => v !== undefined).length === 1,
    { message: "Envie `url`, `conteudo` ou `itens` — e só um deles." },
  );

/** Os produtos que já existem na organização, no formato que o plano compara. */
const COLUNAS_DA_COMPARACAO = "id,id_externo,nome,descricao,preco_cents,fotos,quantidade,ativo";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const corpo = parsed.data;
  const formato: FormatoDoFeed = corpo.formato;

  // ─── O TEXTO do feed ──────────────────────────────────────────────────────
  let registros: Record<string, unknown>[];
  if (corpo.itens) {
    registros = corpo.itens;
  } else {
    let conteudo = corpo.conteudo;
    if (corpo.url) {
      const remoto = await buscarFeedDaUrl(corpo.url);
      if (!remoto.ok) {
        // 422 e não 500: quem lê é quem integrou, e o endereço é dele.
        return fail("validation_failed", remoto.motivo, 422, { requestId, details: { url: [remoto.motivo] } });
      }
      conteudo = remoto.texto;
    }
    const leitura = lerFeed(conteudo!, formato);
    if (!leitura.ok) {
      return fail("validation_failed", leitura.motivo, 422, { requestId, details: { feed: [leitura.motivo] } });
    }
    registros = leitura.registros;
  }

  const supabase = await createClient();

  // A organização é a do COOKIE (acima). Este `select` é por ela e só por ela.
  const { data: lidos, error: erroLeitura } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DA_COMPARACAO)
    .eq("organization_id", orgId);
  if (erroLeitura) {
    return fail("internal_error", t("Erro ao ler o catálogo."), 500, { requestId });
  }

  // `id_externo` nulo é produto que não veio de feed (manual, planilha): fica
  // fora da comparação de propósito — a rodada não desativa o que não é dela.
  const existentes = ((lidos ?? []) as unknown as ProdutoDoCatalogo[]).filter(
    (produto) => produto.id_externo !== null,
  );

  const plano: PlanoDaRodada = planejarRodada(registros, {
    existentes,
    mapeamento: corpo.mapeamento,
    t,
  });
  const resumo = resumoDoPlano(plano);

  if (corpo.dry_run) {
    return ok(
      {
        aplicado: false,
        formato,
        resumo,
        plano: {
          criar: plano.criar.map((item) => ({ id_externo: item.id_externo, nome: item.nome, preco_cents: item.preco_cents })),
          atualizar: plano.atualizar.map((item) => ({ id_externo: item.id_externo, mudou: item.mudou })),
          desativar: plano.desativar.map((item) => ({ id_externo: item.id_externo, nome: item.nome })),
          inalterados: plano.inalterados,
          errosPorItem: plano.errosPorItem,
        },
      },
      { requestId },
    );
  }

  const moeda = await moedaDaOrganizacao(supabase, orgId);

  /**
   * O banco da aplicação. Cada método devolve `null` quando deu certo: o
   * desfecho é por ITEM, e um produto que o banco recusou (código repetido numa
   * linha manual, por exemplo) não pode abortar a rodada dos outros.
   */
  const banco: BancoDoFeed = {
    criar: async (linha: LinhaDoProduto) => {
      const { error } = await supabase.from("catalog_products").insert(linha);
      return error ? error.message : null;
    },
    atualizar: async (id: string, campos: CamposDoUpdate) => {
      const { error } = await supabase
        .from("catalog_products")
        .update(campos)
        .eq("id", id)
        .eq("organization_id", orgId);
      return error ? error.message : null;
    },
    desativar: async (ids: readonly string[]) => {
      // UPDATE, nunca DELETE: a linha continua para o histórico e a proposta.
      const { error } = await supabase
        .from("catalog_products")
        .update({ ativo: false })
        .in("id", [...ids])
        .eq("organization_id", orgId);
      return error ? error.message : null;
    },
  };

  const resultado = await aplicarPlano(banco, plano, {
    orgId,
    moeda,
    t,
    requestId,
  });

  const resumoDaAplicacao = {
    ...resumo,
    criados: resultado.criados.length,
    atualizados: resultado.atualizados.length,
    desativados: resultado.desativados.length,
    falhas: resultado.falhas.length,
  };

  // ─── A fonte fica gravada para o cron ─────────────────────────────────────
  // Só quando a rodada APLICOU e só quando veio por URL: um `dry_run` que
  // gravasse a fonte deixaria o cron sincronizando o que ninguém conferiu.
  let fonteSalva: boolean | null = null;
  if (corpo.url && corpo.salvar_fonte !== false) {
    const { error } = await supabase.from("catalog_feed_sources").upsert(
      {
        organization_id: orgId,
        url: corpo.url,
        formato,
        mapeamento: corpo.mapeamento ?? {},
        ativo: true,
        ultima_leitura_em: new Date().toISOString(),
        ultimo_resumo: resumoDaAplicacao,
      },
      { onConflict: "organization_id" },
    );
    fonteSalva = error === null;
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_products.synced_from_feed",
    resourceType: "catalog_products",
    requestId,
    metadata: { origem: corpo.url ? "url" : corpo.itens ? "itens" : "conteudo", ...resumoDaAplicacao },
  });

  return ok(
    {
      aplicado: true,
      formato,
      resumo: resumoDaAplicacao,
      fonte_salva: fonteSalva,
      itens: {
        criados: resultado.criados,
        atualizados: resultado.atualizados,
        desativados: resultado.desativados,
        inalterados: plano.inalterados,
        erros: [...plano.errosPorItem, ...resultado.falhas],
      },
    },
    { requestId },
  );
}
