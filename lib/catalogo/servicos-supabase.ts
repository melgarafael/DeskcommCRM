/**
 * O CATÁLOGO DE SERVIÇOS NO BANCO — o módulo `catalogo_servicos` (ADR-0002).
 *
 * Tudo que lê ou grava `catalog_service_details` passa por aqui. A tabela só
 * existe onde o módulo foi instalado: quem chama confere `moduloLigado` antes, e
 * com o módulo desligado nenhuma função deste arquivo é alcançada.
 *
 * ⚠️ O que este arquivo NÃO decide: a organização. Ela entra por parâmetro,
 * resolvida da sessão pela rota (ou do contexto do agente) — nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  COLUNAS_DO_DETALHE,
  COLUNAS_DO_ITEM,
  linhaDoCatalogo,
  type DetalheDoServico,
  type ItemDoServico,
  type LinhaDoCatalogo,
} from "@/lib/catalogo/servicos";

export const MODULO_SERVICOS = "catalogo_servicos" as const;

export const SERVICOS_POR_PAGINA = 50;

/** O id entra em `.in()`: só UUID chega ao banco. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ponytail: lotes de 100 ids por `.in()` (~4 KB de URL); uma família não chega perto disso.
const LOTE_DE_IDS = 100;

export class LeituraDoServicoFalhou extends Error {}

async function emLotes<T>(ids: readonly string[], ler: (lote: string[]) => Promise<T[]>): Promise<T[]> {
  const saida: T[] = [];
  for (let i = 0; i < ids.length; i += LOTE_DE_IDS) saida.push(...(await ler(ids.slice(i, i + LOTE_DE_IDS))));
  return saida;
}

async function detalhesPor(
  db: SupabaseClient,
  org: string,
  coluna: "product_id" | "pai_product_id",
  ids: readonly string[],
): Promise<DetalheDoServico[]> {
  return emLotes(ids, async (lote) => {
    const { data, error } = await db
      .from("catalog_service_details")
      .select(COLUNAS_DO_DETALHE)
      .eq("organization_id", org)
      .in(coluna, lote);
    if (error) throw new LeituraDoServicoFalhou(error.message);
    return (data ?? []) as unknown as DetalheDoServico[];
  });
}

async function itensPor(db: SupabaseClient, org: string, ids: readonly string[]): Promise<ItemDoServico[]> {
  return emLotes(ids, async (lote) => {
    const { data, error } = await db
      .from("catalog_products")
      .select(COLUNAS_DO_ITEM)
      .eq("organization_id", org)
      .in("id", lote);
    if (error) throw new LeituraDoServicoFalhou(error.message);
    return (data ?? []) as unknown as ItemDoServico[];
  });
}

/**
 * A família INTEIRA de cada principal: ele e todas as variações, com item e
 * detalhe. É o que impede "a partir de" calculado sobre metade das variações —
 * o defeito do `.limit(500)` da versão anterior, que cortava a família no meio.
 */
export async function lerFamilias(
  db: SupabaseClient,
  org: string,
  principais: readonly string[],
): Promise<LinhaDoCatalogo[]> {
  if (principais.length === 0) return [];
  const [proprios, variacoes] = await Promise.all([
    detalhesPor(db, org, "product_id", principais),
    detalhesPor(db, org, "pai_product_id", principais),
  ]);
  const detalhes = [...proprios.filter((d) => d.pai_product_id === null), ...variacoes];
  const itens = new Map((await itensPor(db, org, detalhes.map((d) => d.product_id))).map((i) => [i.id, i]));
  return detalhes.flatMap((d) => {
    const item = itens.get(d.product_id);
    return item ? [linhaDoCatalogo(item, d)] : [];
  });
}

/** O detalhe de um item (principal ou variação), ou `null` se ele não é serviço. */
export async function detalheDoItem(
  db: SupabaseClient,
  org: string,
  id: string,
): Promise<DetalheDoServico | null> {
  return (await detalhesPor(db, org, "product_id", [id]))[0] ?? null;
}

/**
 * Uma página de PRINCIPAIS, na ordem de cadastro, com a família de cada um
 * completa. A página conta serviços, não linhas: variação nunca fica de fora
 * porque o principal dela entrou no fim da página.
 */
export async function listarServicos(
  db: SupabaseClient,
  org: string,
  pagina: number,
): Promise<{ linhas: LinhaDoCatalogo[]; principais: string[]; temMais: boolean }> {
  const de = (pagina - 1) * SERVICOS_POR_PAGINA;
  const { data, error } = await db
    .from("catalog_service_details")
    .select("product_id")
    .eq("organization_id", org)
    .is("pai_product_id", null)
    .order("created_at", { ascending: true })
    .order("product_id", { ascending: true })
    // Um a mais que a página: é ele que diz se há próxima, sem `count`.
    .range(de, de + SERVICOS_POR_PAGINA);
  // Página além do fim: o PostgREST responde 416 (PGRST103), não lista vazia.
  if (error?.code === "PGRST103") return { linhas: [], principais: [], temMais: false };
  if (error) throw new LeituraDoServicoFalhou(error.message);
  const ids = ((data ?? []) as Array<{ product_id: string }>).map((l) => l.product_id);
  const principais = ids.slice(0, SERVICOS_POR_PAGINA);
  return { linhas: await lerFamilias(db, org, principais), principais, temMais: ids.length > SERVICOS_POR_PAGINA };
}

/**
 * TODOS os detalhes da organização, para a busca do agente. Serviço é a minoria
 * do catálogo, então isto costuma ser uma página só.
 *
 * Falha FECHADA: erro de consulta ou varredura que não chegou ao fim lança. Sem
 * a lista inteira não há como saber qual item tem `ia_oferece = false`, e
 * tratar o erro como "não é serviço" devolveria à conversa exatamente o item que
 * a equipe tirou dela.
 */
export async function todosOsDetalhes(
  db: SupabaseClient,
  org: string,
  pagina = 1000,
  paginasMaximas = 10,
): Promise<Map<string, DetalheDoServico>> {
  const saida = new Map<string, DetalheDoServico>();
  for (let n = 0; n < paginasMaximas; n++) {
    const { data, error } = await db
      .from("catalog_service_details")
      .select(COLUNAS_DO_DETALHE)
      .eq("organization_id", org)
      .order("product_id", { ascending: true })
      .range(n * pagina, (n + 1) * pagina - 1);
    if (error) throw new LeituraDoServicoFalhou(error.message);
    const lote = (data ?? []) as unknown as DetalheDoServico[];
    for (const d of lote) saida.set(d.product_id, d);
    if (lote.length < pagina) return saida;
  }
  throw new LeituraDoServicoFalhou("detalhes de serviço além do teto da varredura");
}

/**
 * A PORTA DO NÚCLEO para os escritores de preço que não conhecem serviço
 * (`PATCH /api/v1/products/[id]` e a planilha).
 *
 * Para cada item dado que pertence a uma família com sinal FIXO, devolve esse
 * sinal: o preço novo do item não pode ficar abaixo dele. Item que não é
 * serviço não aparece no mapa.
 *
 * ⚠️ Limite declarado: isto confere e a escrita do núcleo grava DEPOIS, fora da
 * trava da família. Uma edição do sinal no mesmo instante pode passar entre as
 * duas. A leitura cobre esse caso (`sinalEmCents` não diz sinal acima do
 * preço); a escrita do módulo, que trava, é `fn_catalogo_servicos_salvar`.
 */
export async function sinaisFixosQueTravamPreco(
  db: SupabaseClient,
  org: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const validos = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (validos.length === 0) return new Map();
  const deles = await detalhesPor(db, org, "product_id", validos);
  const principalDe = new Map(deles.map((d) => [d.product_id, d.pai_product_id ?? d.product_id]));
  const principais = await detalhesPor(db, org, "product_id", [...new Set(principalDe.values())]);
  const sinal = new Map(
    principais
      .filter((p) => p.sinal_tipo === "fixo" && p.sinal_cents !== null)
      .map((p) => [p.product_id, Number(p.sinal_cents)]),
  );
  const saida = new Map<string, number>();
  for (const [id, principal] of principalDe) {
    const valor = sinal.get(principal);
    if (valor !== undefined) saida.set(id, valor);
  }
  return saida;
}

/**
 * A recusa do banco em campo e frase de quem cadastra. O texto do erro é o
 * nome da regra (`raise exception 'servico_sinal_acima_do_preco'`, ou o nome do
 * CHECK), então o que volta é estável e não vaza SQL.
 */
export function camposDaRecusa(detalhe: string): Record<string, string[]> {
  if (detalhe.includes("servico_sinal_acima_do_preco")) {
    return { sinal: ["o sinal fixo não pode passar do preço da menor variação"] };
  }
  if (detalhe.includes("catalog_service_details_prazo_check")) {
    return { prazo_dias_uteis: ["prazo em dias úteis só existe em projeto"] };
  }
  if (detalhe.includes("catalog_service_details_sinal_check")) {
    return { sinal: ["sinal percentual de 1 a 100, ou fixo maior que zero"] };
  }
  if (detalhe.includes("catalog_service_details_forma_check")) {
    return { tipo: ["tipo e unidade do serviço não combinam, ou a variação trouxe detalhe do principal"] };
  }
  return { banco: ["o cadastro não passou numa regra do banco"] };
}

export interface EscritaDoServico {
  item: Record<string, unknown>;
  detalhe: Record<string, unknown>;
  expectedRevision?: number;
}

export type ResultadoDaEscrita =
  | { ok: true; productId: string; principalId: string; revision: number }
  | { ok: false; motivo: "nao_encontrado" | "revisao_velha" | "codigo_repetido" | "regra"; detalhe: string };

/**
 * Grava item + detalhe pela função do banco, que trava a família e confere o
 * sinal no estado final. A organização vem de quem chama (sessão validada); o
 * cliente é o de serviço, porque a tabela do módulo não aceita escrita de sessão.
 */
export async function salvarServico(
  admin: SupabaseClient,
  org: string,
  id: string | null,
  escrita: EscritaDoServico,
): Promise<ResultadoDaEscrita> {
  const { data, error } = await admin.rpc("fn_catalogo_servicos_salvar", {
    p_org: org,
    p_id: id,
    p_item: escrita.item,
    p_detalhe: escrita.detalhe,
    p_expected_revision: escrita.expectedRevision ?? null,
  });
  if (error) {
    if (error.code === "P0002") return { ok: false, motivo: "nao_encontrado", detalhe: error.message };
    if (error.code === "PT409") return { ok: false, motivo: "revisao_velha", detalhe: error.details ?? "" };
    if (error.code === "23505") return { ok: false, motivo: "codigo_repetido", detalhe: error.message };
    if (error.code === "23514" || error.code === "23503") return { ok: false, motivo: "regra", detalhe: error.message };
    throw new Error(`salvar_servico_falhou: ${error.message}`);
  }
  const r = data as { product_id: string; principal_id: string; revision: number };
  return { ok: true, productId: r.product_id, principalId: r.principal_id, revision: r.revision };
}
