/**
 * LER UM MATERIAL DO ACERVO — o texto que a pessoa guardou aqui dentro.
 *
 * A tela do acervo só sabia mostrar o que o agente APRENDEU (os pedaços do
 * índice, `components/ai/TrechosDoMaterialDialog.tsx`). Faltava a leitura do
 * material em si: a política que alguém colou, os pares de pergunta e resposta
 * que alguém cadastrou. Sem ela, a equipe mantinha um sistema externo só para
 * consultar o que já estava guardado neste banco.
 *
 * ─── De onde o texto sai, em ordem ─────────────────────────────────────────
 *
 *   1. **FAQ** → os pares de `ai_faq_items`, na ordem cadastrada (`position`).
 *      É o conteúdo que a pessoa escreveu, e não a sua versão fragmentada.
 *   2. **blob guardado** (`source_metadata.blob_path`) → o arquivo é a fonte da
 *      verdade: `app/api/v1/ai/knowledge/sources/route.ts` grava nele o texto
 *      colado como `.md`, e o upload grava o arquivo enviado. A extração reusa
 *      `extrairTextoDoArquivo` — o MESMO caminho que o indexador percorre. Um
 *      segundo extrator divergiria do que o agente leu, e a tela passaria a
 *      mostrar um texto que o agente nunca viu.
 *   3. **índice** (`ai_chunks` da versão ativa) → o que sobra para material
 *      automático (conversas, catálogo) e para arquivo que não pôde ser lido de
 *      novo. É o mesmo recorte da tela de trechos: sem vetor, na ordem de
 *      indexação.
 *
 * Nada aqui reimplementa a busca: não há embedding, não há RPC, não há limiar.
 * O que sai é o que ESTÁ guardado — a pergunta "o que tem neste material?" tem
 * uma resposta factual, e ela não passa por similaridade.
 *
 * ─── Por que a organização entra por parâmetro, e não pelo caminho ──────────
 *
 * Quem chama já resolveu a sessão (rota e página), e o `organization_id` que
 * vale é o da SESSÃO. O id do material vem do caminho justamente porque é o
 * dado que o pedido escolhe — e um id de outra empresa não pode voltar.
 */

import { ErroDeExtracao, extrairTextoDoArquivo } from "@/lib/ai/rag/ingest/documento";
import { canonizarTipoDeFonte, type TipoDeFonteId } from "@/lib/ai/rag/tipos-de-fonte";
import type { createClient } from "@/lib/supabase/server";

/** O cliente com sessão (RLS) — o mesmo tipo que a rota e a página já usam. */
type ClienteComSessao = Awaited<ReturnType<typeof createClient>>;

/**
 * Teto de leitura: uma tela não folheia mil itens nem mil trechos, e o corpo da
 * resposta não precisa carregá-los (mesma régua da rota de trechos).
 */
const TETO = 200;

/** De onde saiu o conteúdo legível que a tela vai mostrar. */
export type OrigemDoConteudo =
  /** Pares de pergunta e resposta cadastrados (`ai_faq_items`). */
  | "faq"
  /** Texto do arquivo guardado (ou do texto colado, que vira arquivo). */
  | "arquivo"
  /** Trechos já indexados — material automático, ou arquivo que não pôde ser lido. */
  | "indice";

export interface ConteudoLegivel {
  nome: string;
  /** Tipo canônico do material (`lib/ai/rag/tipos-de-fonte`). */
  tipo: TipoDeFonteId;
  origem: OrigemDoConteudo;
  /** Pares de pergunta/resposta — presente só quando a origem é `faq`. */
  itens: { question: string; answer: string }[] | null;
  /** Texto legível — presente em `arquivo` e em `indice`. */
  conteudo: string | null;
  /**
   * Quantos itens/trechos o material TEM (1 quando é o texto inteiro do arquivo).
   * É o total do material, e não o que coube na tela: a frase "Mostrando os
   * primeiros trechos de N" é a mesma do diálogo de trechos, que usa `chunks_count`.
   */
  total: number;
  /** Há mais do que a tela mostrou (o material não foi perdido — só não coube). */
  truncado: boolean;
  /**
   * Por que não há o que ler, ou o que impediu de ler o arquivo. Só é nulo
   * quando o conteúdo saiu inteiro. É frase pronta para a tela — a página a
   * mostra como veio, sem passar pelo dicionário (não é texto do código).
   */
  motivo: string | null;
}

export type LeituraDoMaterial =
  | { ok: true; material: ConteudoLegivel }
  /** Não existe nesta organização, ou é de outra. A tela decide 404/não encontrado. */
  | { ok: false; falha: "nao_encontrado" }
  /** O banco falhou: é 500, e não "não existe". */
  | { ok: false; falha: "leitura" };

/** Sem nada guardado e sem nada indexado, a tela precisa dizer POR QUE está vazia. */
const SEM_CONTEUDO =
  "Este material ainda não foi preparado — não há texto guardado dele e nada foi indexado ainda.";

interface FonteRow {
  id: string;
  name: string;
  source_type: string | null;
  source_metadata: Record<string, unknown> | null;
  active_kb_version_id: string | null;
  chunks_count: number | null;
}

export async function lerConteudoDoMaterial(
  supabase: ClienteComSessao,
  p: { orgId: string; sourceId: string },
): Promise<LeituraDoMaterial> {
  const { data, error } = await supabase
    .from("ai_knowledge_sources")
    .select("id, name, source_type, source_metadata, active_kb_version_id, chunks_count")
    .eq("id", p.sourceId)
    .eq("organization_id", p.orgId)
    .maybeSingle();

  if (error) {
    console.error("[conhecimento-conteudo] leitura do material falhou:", error.message);
    return { ok: false, falha: "leitura" };
  }
  if (!data) return { ok: false, falha: "nao_encontrado" };

  const fonte = data as unknown as FonteRow;
  const nome = fonte.name;
  const tipo = canonizarTipoDeFonte(fonte.source_type ?? "") ?? "faq";
  const versaoAtiva = fonte.active_kb_version_id;
  const blobPath =
    typeof fonte.source_metadata?.blob_path === "string" ? fonte.source_metadata.blob_path : null;
  const ext =
    typeof fonte.source_metadata?.ext === "string" ? fonte.source_metadata.ext : undefined;

  const fechar = (parcial: {
    origem: OrigemDoConteudo;
    itens?: ConteudoLegivel["itens"];
    conteudo?: string | null;
    total: number;
    truncado?: boolean;
    motivo?: string | null;
  }): LeituraDoMaterial => ({
    ok: true,
    material: {
      nome,
      tipo,
      origem: parcial.origem,
      itens: parcial.itens ?? null,
      conteudo: parcial.conteudo ?? null,
      total: parcial.total,
      truncado: parcial.truncado ?? false,
      motivo: parcial.motivo ?? null,
    },
  });

  // 1. FAQ: o que a pessoa escreveu, na ordem em que escreveu.
  if (tipo === "faq") {
    const { itens, total } = await lerParesDeFaq(supabase, p);
    if (itens.length > 0) {
      return fechar({
        origem: "faq",
        itens,
        total,
        truncado: total > itens.length,
      });
    }
    // FAQ sem par nenhum não é erro de leitura: pode ter sido indexado por outro
    // caminho. Cair no índice mostra o que existe, em vez de uma tela vazia.
  }

  // 2. O arquivo guardado é a fonte da verdade do conteúdo que a pessoa enviou.
  let motivoDaFalha: string | null = null;
  if (blobPath) {
    try {
      const { texto } = await extrairTextoDoArquivo(blobPath, ext);
      return fechar({ origem: "arquivo", conteudo: texto, total: 1 });
    } catch (err) {
      // Arquivo apagado do Storage, PDF só de imagens, bytes que não são texto:
      // nenhum desses é motivo para abrir uma tela vazia se o índice tem o que
      // o agente aprendeu. A mensagem de `ErroDeExtracao` já é frase de gente.
      motivoDaFalha =
        err instanceof ErroDeExtracao
          ? err.message
          : "Não consegui ler o arquivo guardado deste material.";
      console.error(
        "[conhecimento-conteudo] extração do arquivo falhou:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 3. O que sobrou: o material automático (conversas, catálogo) e o arquivo que
  //    não pôde ser lido agora. É o que o agente já sabe deste material.
  const trechos = await lerTrechosIndexados(supabase, p, versaoAtiva);
  if (trechos.length > 0) {
    // O total é o do material (`chunks_count`), como em `trechos/route.ts`.
    const total = fonte.chunks_count ?? trechos.length;
    return fechar({
      origem: "indice",
      conteudo: trechos.join("\n\n"),
      total,
      truncado: total > trechos.length,
      motivo: motivoDaFalha,
    });
  }

  return fechar({
    origem: blobPath || tipo !== "faq" ? "indice" : "faq",
    total: 0,
    motivo: motivoDaFalha ?? SEM_CONTEUDO,
  });
}

/** Os pares cadastrados (até o teto) e quantos existem. Falha de leitura aqui não é fatal: o índice ainda pode ter texto. */
async function lerParesDeFaq(
  supabase: ClienteComSessao,
  p: { orgId: string; sourceId: string },
): Promise<{ itens: { question: string; answer: string }[]; total: number }> {
  const { data, error, count } = await supabase
    .from("ai_faq_items")
    .select("question, answer", { count: "exact" })
    .eq("organization_id", p.orgId)
    .eq("knowledge_source_id", p.sourceId)
    .order("position", { ascending: true })
    .limit(TETO);

  if (error) {
    console.error("[conhecimento-conteudo] leitura dos pares falhou:", error.message);
    return { itens: [], total: 0 };
  }
  const itens = (data ?? []) as unknown as { question: string; answer: string }[];
  return { itens, total: count ?? itens.length };
}

/** Os trechos da versão ATIVA, na ordem de indexação e sem o vetor. */
async function lerTrechosIndexados(
  supabase: ClienteComSessao,
  p: { orgId: string; sourceId: string },
  versaoAtiva: string | null,
): Promise<string[]> {
  if (!versaoAtiva) return [];

  const { data, error } = await supabase
    .from("ai_chunks")
    .select("content")
    .eq("organization_id", p.orgId)
    .eq("knowledge_source_id", p.sourceId)
    .eq("kb_version_id", versaoAtiva)
    .order("position", { ascending: true })
    .limit(TETO);

  if (error) {
    console.error("[conhecimento-conteudo] leitura dos trechos falhou:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as { content: string }[]).map((t) => t.content);
}
