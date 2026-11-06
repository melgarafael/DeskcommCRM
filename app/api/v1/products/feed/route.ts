/**
 * POST /api/v1/products/feed — a revenda publica o estoque e o catálogo segue.
 *
 * ─── O QUE ESTA ROTA É ──────────────────────────────────────────────────────
 *
 * A interface da FONTE DE CATÁLOGO (#3587, fatia 2): quem chama manda o feed
 * (itens JSON no corpo, texto CSV ou a URL de onde ele é publicado) mais o
 * MAPEAMENTO de campos do feed para os nossos. A rota lê o catálogo da
 * organização, monta o PLANO da rodada com `lib/catalogo/feed.ts` e, só com
 * `dry_run: false`, aplica:
 *
 *   criar      → produto novo (id externo ainda não existe);
 *   atualizar  → mudou nome/preço/descrição/marca/categoria/estoque/fotos;
 *   desativar  → saiu do feed: `ativo = false`, NUNCA `DELETE` (propostas e
 *                histórico de conversas apontam para a linha);
 *   inalterado → nada a fazer.
 *
 * `dry_run` é o DEFAULT: a primeira chamada de quem está integrando serve para
 * ler o plano, e escrever no catálogo sem pedir seria o oposto disso.
 *
 * ─── A ORG VEM DO COOKIE, E SÓ DELE ─────────────────────────────────────────
 *
 * `organization_id` no corpo é ignorado (o Zod nem o declara): escopo não se
 * decide por input de quem chama, pela mesma regra de todo o `/api/v1`. A
 * escrita exige `manager` — preço de venda é decisão de gestão, igual ao POST
 * unitário e à planilha.
 *
 * ─── A URL DO FEED É ENTRADA DE FORA, E O FETCH É DE DENTRO DA REDE ─────────
 *
 * `assertUrlDeMidiaSegura` é a mesma guarda da foto por URL: esquema, host
 * literal privado e IP RESOLVIDO (um hostname público que aponta para
 * 169.254.169.254 entregaria credencial de instância). Redirecionamento é
 * seguido à mão, uma casa por vez, com a guarda rodando de novo em cada
 * `Location` — `redirect: "follow"` deixaria o salto para o endereço interno
 * acontecer DEPOIS da conferência.
 *
 * ─── FOTO: o mesmo caminho da fatia 1 ───────────────────────────────────────
 *
 * `guardarFotosPorUrl` baixa e grava o CAMINHO no bucket `catalog-photos`; a
 * URL não vai para coluna nenhuma (link de anúncio morre quando o item é
 * vendido). Item com foto que não baixa é RECUSADO inteiro, com o motivo — o
 * produto entrar sem a foto anunciada é o defeito que a fatia 1 fechou.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  MAX_ITENS_POR_RODADA,
  ORIGEM_DO_FEED,
  planejarRodadaDoFeed,
  type AcaoDoItem,
  type MapeamentoDoFeed,
  type ProdutoDoFeed,
  type ProdutoExistente,
} from "@/lib/catalogo/feed";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { CSV_MAX_BYTES, decodificarCsv } from "@/lib/contacts/csv";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { assertUrlDeMidiaSegura } from "@/lib/messaging/media/url-de-midia-externa";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** O teto de linhas por resposta do PostgREST (`max_rows` em `supabase/config.toml`). */
const PAGINA = 1000;
/** Prazo do feed publicado. Um cron de catálogo não pode prender a rodada. */
const PRAZO_DO_FEED_MS = 20_000;
/** Os mesmos saltos que a foto aceita: http→https e CDN do feed. */
const MAXIMO_DE_SALTOS = 3;

const mapeamentoSchema = z.object({
  id_externo: z.string().trim().min(1),
  nome: z.string().trim().min(1),
  preco: z.string().trim().min(1),
  descricao: z.string().trim().min(1).nullish(),
  marca: z.string().trim().min(1).nullish(),
  categoria: z.string().trim().min(1).nullish(),
  quantidade: z.string().trim().min(1).nullish(),
  fotos: z.string().trim().min(1).nullish(),
  preco_em_centavos: z.boolean().optional(),
  separador_de_fotos: z.string().min(1).max(3).optional(),
});

const corpoSchema = z
  .object({
    formato: z.enum(["json", "csv"]).default("json"),
    mapeamento: mapeamentoSchema,
    /** JSON: o feed inteiro já no corpo. */
    itens: z.array(z.unknown()).max(MAX_ITENS_POR_RODADA).optional(),
    /** CSV: o texto do feed (ou o do JSON, com `formato: "json"`). */
    conteudo: z.string().min(1).max(CSV_MAX_BYTES).optional(),
    /** Ou de onde ele é publicado — baixado pelo servidor, com guarda de SSRF. */
    url: z.string().trim().url().max(2000).optional(),
    dry_run: z.boolean().default(true),
    desativar_ausentes: z.boolean().default(true),
  })
  .superRefine((corpo, ctx) => {
    const fontes = [corpo.itens, corpo.conteudo, corpo.url].filter((v) => v !== undefined).length;
    if (fontes === 0) {
      ctx.addIssue({ code: "custom", path: ["itens"], message: "envie 'itens', 'conteudo' ou 'url'" });
    }
    if (fontes > 1) {
      ctx.addIssue({ code: "custom", path: ["itens"], message: "envie só UMA fonte: 'itens', 'conteudo' ou 'url'" });
    }
  });

interface ResultadoDoItem {
  linha: number;
  id_externo: string;
  acao: AcaoDoItem;
  resultado: "criado" | "atualizado" | "desativado" | "inalterado" | "erro";
  motivo?: string;
}

/** Baixa o feed publicado seguindo redirecionamento à mão, guarda em cada salto. */
async function baixarFeed(url: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; motivo: string }> {
  let alvo = url;
  for (let salto = 0; salto <= MAXIMO_DE_SALTOS; salto += 1) {
    try {
      await assertUrlDeMidiaSegura(alvo);
    } catch {
      return { ok: false, motivo: `o endereço do feed foi recusado pela guarda de saída: ${alvo}` };
    }
    const resposta = await fetch(alvo, {
      redirect: "manual",
      signal: AbortSignal.timeout(PRAZO_DO_FEED_MS),
    });
    if (resposta.status >= 300 && resposta.status < 400) {
      const proximo = resposta.headers.get("location");
      if (!proximo) return { ok: false, motivo: "o feed respondeu redirecionamento sem endereço de destino" };
      alvo = new URL(proximo, alvo).toString();
      continue;
    }
    if (!resposta.ok) return { ok: false, motivo: `o feed respondeu ${resposta.status}` };
    const bytes = new Uint8Array(await resposta.arrayBuffer());
    if (bytes.byteLength > CSV_MAX_BYTES) {
      return { ok: false, motivo: `o feed passa de ${Math.floor(CSV_MAX_BYTES / 1024 / 1024)}MB — divida a publicação` };
    }
    return { ok: true, bytes };
  }
  return { ok: false, motivo: "o feed redireciona mais vezes do que a guarda segue" };
}

function textoDoFeed(bytes: Uint8Array): string {
  const decodificado = decodificarCsv(bytes);
  return "erro" in decodificado ? new TextDecoder().decode(bytes) : decodificado.texto;
}

/** O catálogo INTEIRO da organização, no recorte que o plano compara. */
async function carregarExistentes(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
): Promise<{ ok: true; existentes: ProdutoExistente[] } | { ok: false; motivo: string }> {
  const existentes: ProdutoExistente[] = [];
  // Avança pelo que VEIO, não pelo que pediu: uma instalação com `max_rows`
  // menor que a página não fica com o catálogo cortado (mesmo laço da planilha).
  for (;;) {
    const { data, error } = await supabase
      .from("catalog_products")
      .select("id, codigo, nome, descricao, preco_cents, marca, categoria, quantidade, fotos, ativo, origem")
      .eq("organization_id", orgId)
      .order("codigo")
      .range(existentes.length, existentes.length + PAGINA - 1);
    if (error) return { ok: false, motivo: error.message };
    if (!data || data.length === 0) break;
    existentes.push(...(data as unknown as ProdutoExistente[]));
  }
  return { ok: true, existentes };
}

/** O patch do UPDATE — só os campos que o feed declara e que mudaram. */
function patchDoItem(produto: ProdutoDoFeed, mudancas: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = { origem: ORIGEM_DO_FEED };
  if (mudancas.includes("nome")) patch.nome = produto.nome;
  if (mudancas.includes("descricao")) patch.descricao = produto.descricao;
  if (mudancas.includes("preco_cents")) patch.preco_cents = produto.preco_cents;
  if (mudancas.includes("marca")) patch.marca = produto.marca;
  if (mudancas.includes("categoria")) patch.categoria = produto.categoria;
  if (mudancas.includes("quantidade")) patch.quantidade = produto.quantidade;
  return patch;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Preço de venda é escrita de gestão: o mesmo piso do POST unitário e da planilha.
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("validation_failed", t("Envie o feed em JSON no corpo."), 422, { requestId });
  }
  const lido = corpoSchema.safeParse(corpo);
  if (!lido.success) {
    return fail("validation_failed", t("O corpo do feed não está no formato esperado."), 422, {
      requestId,
      details: lido.error.issues,
    });
  }
  const entrada = lido.data;
  const mapeamento: MapeamentoDoFeed = entrada.mapeamento;

  // ── A fonte: itens no corpo, texto no corpo, ou a URL publicada ────────────
  let itens: unknown[] | undefined;
  let conteudo: string | undefined;
  if (entrada.itens) {
    itens = entrada.itens;
  } else if (entrada.conteudo !== undefined) {
    conteudo = entrada.conteudo;
  } else if (entrada.url) {
    const baixado = await baixarFeed(entrada.url);
    if (!baixado.ok) return fail("validation_failed", t(baixado.motivo), 422, { requestId });
    const textoBaixado = textoDoFeed(baixado.bytes);
    if (entrada.formato === "json") {
      try {
        const cru = JSON.parse(textoBaixado) as unknown;
        // `{ "produtos": [...] }` é o formato que a maioria dos ERPs publica.
        const lista = Array.isArray(cru) ? cru : (cru as { produtos?: unknown })?.produtos;
        if (!Array.isArray(lista)) {
          return fail("validation_failed", t("O feed em JSON não é uma lista de itens."), 422, { requestId });
        }
        itens = lista;
      } catch {
        return fail("validation_failed", t("O feed publicado não é um JSON válido."), 422, { requestId });
      }
    } else {
      conteudo = textoBaixado;
    }
  }

  const supabase = await createClient();
  const atuais = await carregarExistentes(supabase, orgId);
  if (!atuais.ok) {
    // Sem o catálogo atual não há como distinguir novo de repetido — seguir
    // gravaria exatamente a duplicata que esta rota existe para impedir.
    logger.warn("[produtos/feed] leitura do catálogo falhou", { detalhe: atuais.motivo, requestId });
    return fail(
      "internal_error",
      t("Não consegui conferir o catálogo atual, então nada foi alterado. Tente de novo em instantes."),
      500,
      { requestId },
    );
  }

  const planejado = planejarRodadaDoFeed({
    formato: entrada.formato,
    itens,
    conteudo,
    mapeamento,
    existentes: atuais.existentes,
    desativarAusentes: entrada.desativar_ausentes,
  });
  if (!planejado.ok) return fail("validation_failed", t(planejado.erro), 422, { requestId });
  const plano = planejado.plano;

  const resultados: ResultadoDoItem[] = [];
  const erros = [...plano.errosPorItem];

  if (entrada.dry_run) {
    // O plano SEM tocar no banco: é o que quem está integrando lê primeiro.
    for (const item of [...plano.criar, ...plano.atualizar, ...plano.inalterados]) {
      resultados.push({
        linha: item.linha,
        id_externo: item.produto.id_externo,
        acao: item.acao,
        resultado: item.acao === "criar" ? "criado" : item.acao === "atualizar" ? "atualizado" : "inalterado",
      });
    }
    for (const item of plano.desativar) {
      resultados.push({
        linha: item.linha,
        id_externo: item.produto.id_externo,
        acao: "desativar",
        resultado: "desativado",
      });
    }
    return ok(
      {
        aplicado: false,
        contagem: plano.contagem,
        erros,
        itens: resultados,
      },
      { requestId },
    );
  }

  const moeda = await moedaDaOrganizacao(supabase, orgId);

  // ── criar ────────────────────────────────────────────────────────────────
  for (const item of plano.criar) {
    const produto = item.produto;
    const id = randomUUID();
    let caminhos: string[] | undefined;
    if (produto.fotos && produto.fotos.length > 0) {
      const guardadas = await guardarFotosPorUrl({ orgId, produtoId: id, urls: produto.fotos, t });
      if (!guardadas.ok) {
        erros.push({ linha: item.linha, id_externo: produto.id_externo, motivo: guardadas.motivo });
        resultados.push({ linha: item.linha, id_externo: produto.id_externo, acao: "criar", resultado: "erro", motivo: guardadas.motivo });
        continue;
      }
      caminhos = guardadas.caminhos;
    }
    const { error } = await supabase.from("catalog_products").insert({
      id,
      organization_id: orgId,
      codigo: produto.id_externo,
      nome: produto.nome,
      descricao: produto.descricao,
      marca: produto.marca,
      categoria: produto.categoria,
      preco_cents: produto.preco_cents,
      moeda,
      origem: ORIGEM_DO_FEED,
      ativo: true,
      ...(produto.quantidade !== null ? { quantidade: produto.quantidade } : {}),
      ...(caminhos ? { fotos: caminhos } : {}),
    });
    if (error) {
      // O arquivo já subiu e a linha não existe: sem esta limpeza, um id
      // repetido deixaria foto órfã no bucket, paga por ninguém.
      if (caminhos?.length) await apagarDoBucket(orgId, id, caminhos, requestId);
      erros.push({ linha: item.linha, id_externo: produto.id_externo, motivo: error.message });
      resultados.push({ linha: item.linha, id_externo: produto.id_externo, acao: "criar", resultado: "erro", motivo: error.message });
      continue;
    }
    resultados.push({ linha: item.linha, id_externo: produto.id_externo, acao: "criar", resultado: "criado" });
  }

  // ── atualizar ────────────────────────────────────────────────────────────
  for (const item of plano.atualizar) {
    const produto = item.produto;
    const patch = patchDoItem(produto, item.mudancas);
    if (item.mudancas.includes("fotos") && produto.fotos && produto.fotos.length > 0) {
      const guardadas = await guardarFotosPorUrl({
        orgId,
        produtoId: item.produto_id!,
        urls: produto.fotos,
        t,
      });
      if (!guardadas.ok) {
        erros.push({ linha: item.linha, id_externo: produto.id_externo, motivo: guardadas.motivo });
        resultados.push({ linha: item.linha, id_externo: produto.id_externo, acao: "atualizar", resultado: "erro", motivo: guardadas.motivo });
        continue;
      }
      patch.fotos = guardadas.caminhos;
    }
    const { error } = await supabase
      .from("catalog_products")
      .update(patch)
      .eq("organization_id", orgId)
      .eq("id", item.produto_id);
    if (error) {
      erros.push({ linha: item.linha, id_externo: produto.id_externo, motivo: error.message });
      resultados.push({ linha: item.linha, id_externo: produto.id_externo, acao: "atualizar", resultado: "erro", motivo: error.message });
      continue;
    }
    // As fotos antigas saem do bucket DEPOIS do update: o que o produto aponta
    // agora são os caminhos novos.
    if (Array.isArray(patch.fotos) && item.fotos_antigas && item.fotos_antigas.length > 0) {
      await apagarDoBucket(orgId, item.produto_id!, item.fotos_antigas, requestId);
    }
    resultados.push({ linha: item.linha, id_externo: produto.id_externo, acao: "atualizar", resultado: "atualizado" });
  }

  // ── desativar (NUNCA apagar) ─────────────────────────────────────────────
  for (const item of plano.desativar) {
    const { error } = await supabase
      .from("catalog_products")
      .update({ ativo: false })
      .eq("organization_id", orgId)
      .eq("id", item.produto_id);
    if (error) {
      erros.push({ linha: 0, id_externo: item.produto.id_externo, motivo: error.message });
      resultados.push({ linha: 0, id_externo: item.produto.id_externo, acao: "desativar", resultado: "erro", motivo: error.message });
      continue;
    }
    resultados.push({ linha: 0, id_externo: item.produto.id_externo, acao: "desativar", resultado: "desativado" });
  }

  for (const item of plano.inalterados) {
    resultados.push({ linha: item.linha, id_externo: item.produto.id_externo, acao: "inalterado", resultado: "inalterado" });
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.imported",
    resourceType: "catalog_products",
    resourceId: null,
    requestId,
    metadata: {
      canal: "feed",
      formato: entrada.formato,
      criar: plano.contagem.criar,
      atualizar: plano.contagem.atualizar,
      desativar: plano.contagem.desativar,
      erros: erros.length,
    },
  });

  return ok(
    {
      aplicado: true,
      contagem: plano.contagem,
      erros,
      itens: resultados,
    },
    { requestId },
  );
}
