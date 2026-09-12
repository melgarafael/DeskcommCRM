/**
 * O INDEXADOR — transforma o material do tenant em trechos buscáveis.
 *
 * ## O que mudou na 0181, e por quê
 *
 * Antes, este worker **resolvia o agente pela ORGANIZAÇÃO**
 * (`resolveAgent(row.organization_id)` → o agente `is_default` mais antigo) e
 * ignorava o `agent_id` que os três emissores já mandavam no payload. Numa
 * organização com dois assistentes, o material do segundo nunca virava trecho e
 * a versão ativada era a do primeiro — em silêncio, sem erro em lugar nenhum.
 *
 * Agora ele indexa **a FONTE que o evento nomeia**. Nem precisa de agente: o
 * acervo é da organização, e quem lê o quê é escolha da versão publicada de
 * cada assistente (`ai_agent_versions.knowledge_source_ids`).
 *
 * Consequência boa e não-óbvia: reindexar a FAQ deixou de derrubar o catálogo.
 * Enquanto a versão era do agente e havia uma ativa por agente, duas rotinas
 * competiam pelo mesmo ponteiro — a que indexasse por último apagava o acervo da
 * outra.
 *
 * ## Falta de chave é ESTADO, não acidente
 *
 * Sem chave de embedding o worker devolvia `skipped: openai_key_missing` para o
 * próprio log. O drain trata `skipped` como sucesso e marca o evento como
 * consumido para sempre — então cadastrar a chave depois não reprocessava nada,
 * e a linha da fonte continuava dizendo `ready`. Agora:
 *
 *   * a fonte fica `last_index_status='sem_credencial'` com o motivo escrito;
 *   * a Central de avisos ganha um item (`conhecimento_nao_indexado`);
 *   * o evento volta como `retry`, para a chave que chegar amanhã encontrar
 *     trabalho esperando.
 *
 * Isolamento: toda query filtra `organization_id` vindo da ROW do evento —
 * fonte confiável — e nunca de conteúdo de usuário (CLAUDE.md §multi-tenancy).
 */

import { embedText, SemChaveDeEmbeddingError } from "@/lib/ai/embed";
import {
  resolverChaveDeEmbedding,
  type ChaveDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { acquireDebounce } from "@/lib/ai/rag/debounce";
import { chunkText, computeContentHash } from "@/lib/ai/rag/chunker";
import { canonizarTipoDeFonte } from "@/lib/ai/rag/tipos-de-fonte";
import { extrairTextoDoArquivo, ErroDeExtracao } from "@/lib/ai/rag/ingest/documento";
import { estimateTokens } from "@/lib/ai/runtime/history";
import { formatProductForRag, type NuvemshopProduct } from "@/lib/ai/rag/format-product";
import {
  createKnowledgeVersion,
  markVersionReady,
  markVersionFailed,
  activateVersion,
} from "@/lib/ai/rag/version";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { NuvemshopApiClient } from "@/lib/nuvemshop/api-client";

const DEBOUNCE_TTL_SEC = 30;
const LAG_WARN_MS = 5 * 60 * 1000;
/** Sem chave, o evento volta daqui a uma hora. Tempo de alguém cadastrar. */
const RETRY_SEM_CHAVE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface FonteRow {
  id: string;
  organization_id: string;
  agent_id: string | null;
  source_type: string;
  name: string;
  status: string;
  is_active: boolean;
  source_metadata: Record<string, unknown> | null;
}

/** Um pedaço pronto para virar vetor. */
interface Pedaco {
  content: string;
  metadata: Record<string, unknown>;
}

type Resultado =
  | { tipo: "ok"; versionId: string; chunks: number }
  | { tipo: "pulado"; motivo: string }
  | { tipo: "erro"; detalhe: string }
  | { tipo: "sem_chave" };

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

async function carregarFonte(
  organizationId: string,
  sourceId: string,
): Promise<FonteRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ai_knowledge_sources")
    .select("id, organization_id, agent_id, source_type, name, status, is_active, source_metadata")
    .eq("id", sourceId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data as FonteRow | null) ?? null;
}

/**
 * Marca o estado da fonte. Fire-and-forget de propósito: perder o carimbo é
 * ruim, abortar a indexação por causa dele seria pior.
 */
async function marcarFonte(
  organizationId: string,
  sourceId: string,
  campos: Record<string, unknown>,
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin
      .from("ai_knowledge_sources")
      .update(campos)
      .eq("id", sourceId)
      .eq("organization_id", organizationId);
  } catch (err) {
    console.warn(
      "[rag-indexer] não consegui carimbar o estado da fonte",
      sourceId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Abre o aviso na Central. Sem `on conflict`: um aviso por tentativa é
 * ruidoso demais, então só abre quando não há um ABERTO para a mesma fonte.
 */
async function avisarNaCentral(
  organizationId: string,
  fonte: FonteRow,
  titulo: string,
  corpo: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "conhecimento_nao_indexado")
      .eq("ref_id", fonte.id)
      .is("resolved_at", null)
      .maybeSingle();
    if (jaAberto) return;

    await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "conhecimento_nao_indexado",
      severity: "warn",
      title: titulo,
      body: corpo,
      ref_kind: "ai_knowledge_source",
      ref_id: fonte.id,
    });
  } catch (err) {
    console.warn(
      "[rag-indexer] não consegui abrir o aviso na Central",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Montagem dos pedaços, por tipo de material
// ---------------------------------------------------------------------------

/**
 * FAQ: **um chunk por par pergunta/resposta**. A unidade de recuperação é a
 * resposta inteira; `chunkText` só entra quando ela é longa demais, para uma
 * FAQ curta nunca ser picada no meio.
 */
async function pedacosDeFaq(fonte: FonteRow): Promise<Pedaco[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_faq_items")
    .select("question, answer, position")
    .eq("organization_id", fonte.organization_id)
    .eq("knowledge_source_id", fonte.id)
    .order("position", { ascending: true });

  if (error) throw new Error(`itens_da_faq: ${error.message}`);

  const pedacos: Pedaco[] = [];
  for (const it of (data ?? []) as Array<{ question: string; answer: string }>) {
    const texto = `Pergunta: ${it.question}\nResposta: ${it.answer}`;
    for (const c of chunkText(texto)) {
      pedacos.push({ content: c, metadata: { source_type: "faq", pergunta: it.question } });
    }
  }
  return pedacos;
}

/**
 * Documento: baixa o arquivo do Storage, extrai o texto e chunka.
 *
 * Antes da 0181, `ingestPolicyFile` fazia exatamente isto na hora do upload,
 * **logava a contagem e descartava os chunks**. O material subia, a fonte
 * nascia, e não havia caminho nenhum que transformasse aquele PDF em trecho —
 * o worker só sabia ler `ai_faq_items`.
 */
async function pedacosDeDocumento(fonte: FonteRow): Promise<Pedaco[]> {
  const meta = (fonte.source_metadata ?? {}) as {
    blob_path?: string;
    filename?: string;
    ext?: string;
  };
  const blobPath = meta.blob_path;
  if (!blobPath) throw new ErroDeExtracao("a fonte não aponta para nenhum arquivo");

  const { texto, extensao } = await extrairTextoDoArquivo(blobPath, meta.ext);
  return chunkText(texto, { maxChars: 1600, overlapChars: 200 }).map((c) => ({
    content: c,
    metadata: {
      source_type: "documento",
      arquivo: meta.filename ?? blobPath.split("/").pop() ?? "documento",
      extensao,
    },
  }));
}

/** Catálogo: os produtos já sincronizados desta organização. */
async function pedacosDeCatalogo(fonte: FonteRow, productId?: string): Promise<Pedaco[]> {
  const produtos = productId
    ? [await buscarProdutoNaLoja(fonte.organization_id, productId)].filter(
        (p): p is NuvemshopProduct => p !== null,
      )
    : [];

  const pedacos: Pedaco[] = [];
  for (const p of produtos) {
    for (const c of chunkText(formatProductForRag(p))) {
      pedacos.push({
        content: c,
        metadata: { source_type: "catalogo", product_id: String((p as { id?: unknown }).id ?? "") },
      });
    }
  }
  return pedacos;
}

async function buscarProdutoNaLoja(
  organizationId: string,
  productId: string,
): Promise<NuvemshopProduct | null> {
  const creds = await credenciaisDaLoja(organizationId);
  if (!creds) {
    console.warn("[rag-indexer] loja não conectada para a org", organizationId);
    return null;
  }
  try {
    const client = new NuvemshopApiClient({
      storeId: creds.storeId,
      accessToken: creds.accessToken,
    });
    return (await client.get<NuvemshopProduct>(`/products/${productId}`)) ?? null;
  } catch (err) {
    console.warn(
      "[rag-indexer] busca do produto falhou",
      productId,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function credenciaisDaLoja(
  organizationId: string,
): Promise<{ accessToken: string; storeId: string } | null> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, provider, store_metadata")
    .eq("organization_id", organizationId)
    .eq("provider", "nuvemshop")
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return null;

  const meta = (data as { store_metadata: Record<string, unknown> | null }).store_metadata ?? {};
  const storeId = String(meta["store_id"] ?? meta["id"] ?? "");
  if (!storeId) return null;

  const { data: decrypted, error: decErr } = await admin.rpc("fn_decrypt_oauth" as never, {
    p_organization_id: organizationId,
    p_integration_id: (data as { id: string }).id,
  } as never);

  if (decErr || !decrypted) return null;
  const accessToken = String(decrypted);
  return accessToken ? { accessToken, storeId } : null;
}

// ---------------------------------------------------------------------------
// O ciclo de uma fonte
// ---------------------------------------------------------------------------

/**
 * Indexa UMA fonte, do zero, numa versão nova.
 *
 * A versão só é ATIVADA depois de todos os trechos entrarem: se algo falhar no
 * meio, a versão anterior continua valendo e o agente segue respondendo com o
 * material antigo em vez de ficar sem material nenhum. E **nunca ativa versão
 * vazia** — trocar um acervo que funcionava por um acervo vazio é pior que a
 * indexação ter falhado.
 *
 * O "se algo falhar" inclui o UPSERT de um trecho: antes, o erro de gravação
 * virava só `console.warn` e, com pelo menos um trecho gravado, a versão era
 * marcada pronta e ativada — um índice com buracos entrava no ar sem ninguém
 * saber. Agora qualquer trecho não gravado derruba a indexação inteira: a
 * versão falha com o motivo e a anterior segue ativa.
 */
export async function indexarFonte(
  fonte: FonteRow,
  chave: ChaveDeEmbedding,
  extra: { productId?: string },
): Promise<Resultado> {
  const tipo = canonizarTipoDeFonte(fonte.source_type);
  if (tipo === null) {
    return { tipo: "erro", detalhe: `tipo_de_material_desconhecido:${fonte.source_type}` };
  }

  let pedacos: Pedaco[];
  try {
    switch (tipo) {
      case "faq":
        pedacos = await pedacosDeFaq(fonte);
        break;
      case "documento":
        pedacos = await pedacosDeDocumento(fonte);
        break;
      case "catalogo":
        pedacos = await pedacosDeCatalogo(fonte, extra.productId);
        break;
      case "conversas":
        // A ingestão anonimizada tem pipeline próprio (cron
        // `kb-conversations-batch`), que embeda e grava por conta.
        return { tipo: "pulado", motivo: "conversas_tem_pipeline_proprio" };
    }
  } catch (err) {
    if (err instanceof ErroDeExtracao) {
      return { tipo: "erro", detalhe: err.message };
    }
    return { tipo: "erro", detalhe: err instanceof Error ? err.message : String(err) };
  }

  if (pedacos.length === 0) {
    return { tipo: "pulado", motivo: "sem_conteudo_para_indexar" };
  }

  const { versionId, versionNumber } = await createKnowledgeVersion({
    organizationId: fonte.organization_id,
    knowledgeSourceId: fonte.id,
    agentId: fonte.agent_id,
    sourceType: tipo,
  });

  console.warn(
    `[rag-indexer] "${fonte.name}" → versão ${versionNumber} (${versionId}), ${pedacos.length} trecho(s)`,
  );

  const admin = createAdminClient();
  let gravados = 0;
  // Trecho que não gravou NÃO pode seguir para a ativação: a versão fica
  // incompleta e a anterior — que funciona — é quem deve continuar no ar.
  const falhas: Array<{ posicao: number; mensagem: string }> = [];

  for (let i = 0; i < pedacos.length; i++) {
    const p = pedacos[i]!;
    let embedding: number[];
    try {
      // `chave` já resolvida: sem isto, um documento de 200 trechos decifraria a
      // credencial 200 vezes.
      const r = await embedText(p.content, {
        organizationId: fonte.organization_id,
        chave,
      });
      embedding = r.embedding;
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      await markVersionFailed(versionId, fonte.organization_id, `embed@${i}: ${detalhe}`);
      return { tipo: "erro", detalhe: `embedding falhou no trecho ${i}: ${detalhe}` };
    }

    const { error: upErr } = await admin.from("ai_chunks").upsert(
      {
        organization_id: fonte.organization_id,
        kb_version_id: versionId,
        knowledge_source_id: fonte.id,
        position: i,
        content: p.content,
        content_hash: computeContentHash(p.content),
        token_count: estimateTokens(p.content),
        embedding: embedding as unknown as string,
        metadata: p.metadata,
      },
      // A constraint que EXISTE é `ai_chunks_position_unique`
      // (knowledge_source_id, kb_version_id, position). Como cada indexação cria
      // uma versão nova, na prática nunca há conflito — o alvo certo é o que faz
      // o insert passar.
      { onConflict: "knowledge_source_id,kb_version_id,position", ignoreDuplicates: true },
    );

    if (upErr) {
      falhas.push({ posicao: i, mensagem: upErr.message });
    } else {
      gravados++;
    }
  }

  if (gravados === 0) {
    await markVersionFailed(versionId, fonte.organization_id, "nenhum trecho gravado");
    return { tipo: "erro", detalhe: "nenhum_trecho_gravado" };
  }

  if (falhas.length > 0) {
    await markVersionFailed(
      versionId,
      fonte.organization_id,
      `${falhas.length} de ${pedacos.length} trechos não gravaram: ${falhas
        .map((f) => `posição ${f.posicao} (${f.mensagem})`)
        .join("; ")}`,
    );
    return { tipo: "erro", detalhe: `trechos_nao_gravados:${falhas.length}` };
  }

  await markVersionReady(versionId, fonte.organization_id, gravados);
  await activateVersion({
    organizationId: fonte.organization_id,
    knowledgeSourceId: fonte.id,
    versionId,
  });

  return { tipo: "ok", versionId, chunks: gravados };
}

// ---------------------------------------------------------------------------
// Entrada do dispatcher
// ---------------------------------------------------------------------------

/**
 * Resolve QUAL fonte o evento nomeia.
 *
 * `knowledge_source.updated` traz `knowledge_source_id` desde sempre — era esse
 * o dado que o worker antigo ignorava. Para o catálogo, o evento é de produto e
 * a fonte é a de catálogo da organização, criada na primeira sincronização.
 */
async function fonteDoEvento(row: EventRow): Promise<{
  fonte: FonteRow | null;
  productId?: string;
  motivo?: string;
}> {
  if (row.event_type === "knowledge_source.updated") {
    const sourceId = String(row.payload["knowledge_source_id"] ?? "");
    if (!sourceId) return { fonte: null, motivo: "evento_sem_knowledge_source_id" };
    const fonte = await carregarFonte(row.organization_id, sourceId);
    return { fonte, ...(fonte ? {} : { motivo: "fonte_nao_encontrada" }) };
  }

  // nuvemshop.product_synced
  const productId = String(row.payload["product_id"] ?? "");
  if (!productId) return { fonte: null, motivo: "evento_sem_product_id" };
  const fonte = await garantirFonteDeCatalogo(row.organization_id);
  return { fonte, productId, ...(fonte ? {} : { motivo: "fonte_de_catalogo_indisponivel" }) };
}

/**
 * A fonte de catálogo da organização, criada na primeira sincronização.
 *
 * Antes da 0181 o caminho de produto gravava `knowledge_source_id: null` numa
 * coluna NOT NULL — todo trecho de catálogo era recusado pelo banco, e o
 * `console.warn` de cada recusa era a única evidência.
 */
async function garantirFonteDeCatalogo(organizationId: string): Promise<FonteRow | null> {
  const admin = createAdminClient();

  const { data: existente } = await admin
    .from("ai_knowledge_sources")
    .select("id, organization_id, agent_id, source_type, name, status, is_active, source_metadata")
    .eq("organization_id", organizationId)
    .eq("source_type", "catalogo")
    .eq("is_active", true)
    .maybeSingle();
  if (existente) return existente as FonteRow;

  const { data: criada, error } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: organizationId,
      agent_id: null,
      source_type: "catalogo",
      name: "Catálogo de produtos",
      status: "ready",
      is_active: true,
      ingested_at: new Date().toISOString(),
      source_metadata: { criada_automaticamente: true, origem: "nuvemshop" },
    })
    .select("id, organization_id, agent_id, source_type, name, status, is_active, source_metadata")
    .single();

  if (error) {
    console.warn("[rag-indexer] não consegui criar a fonte de catálogo:", error.message);
    return null;
  }
  return criada as FonteRow;
}

export async function processRagIndexer(row: EventRow): Promise<HandlerResult> {
  const consumerKey = "rag-indexer.v1";

  const lagMs = Date.now() - new Date(String(row.payload["created_at"] ?? row.created_at)).getTime();
  if (Number.isFinite(lagMs) && lagMs > LAG_WARN_MS) {
    console.warn(
      `[rag-indexer] atraso de ${Math.round(lagMs / 1000)}s no evento ${row.id} (${row.event_type})`,
    );
  }

  if (row.event_type !== "knowledge_source.updated" && row.event_type !== "nuvemshop.product_synced") {
    return { consumer_key: consumerKey, status: "skipped", detail: `evento_nao_tratado:${row.event_type}` };
  }

  try {
    const { fonte, productId, motivo } = await fonteDoEvento(row);
    if (!fonte) {
      return { consumer_key: consumerKey, status: "skipped", detail: motivo ?? "fonte_indisponivel" };
    }
    if (!fonte.is_active || fonte.status === "archived") {
      return { consumer_key: consumerKey, status: "skipped", detail: "fonte_arquivada" };
    }

    // Debounce por FONTE (antes era por agente): duas edições seguidas do mesmo
    // material coalescem, e materiais diferentes não se atrapalham.
    const chaveDebounce = `rag:debounce:${row.organization_id}:${fonte.id}:${row.event_type}`;
    if (!(await acquireDebounce(chaveDebounce, DEBOUNCE_TTL_SEC))) {
      return { consumer_key: consumerKey, status: "skipped", detail: "debounced" };
    }

    // A chave é resolvida UMA vez por indexação — não uma vez por trecho.
    const chave = await resolverChaveDeEmbedding(row.organization_id, "embedding_indexar");
    if (!chave) {
      await marcarFonte(row.organization_id, fonte.id, {
        last_index_status: "sem_credencial",
        last_index_error:
          "Falta uma chave da OpenAI para indexar. Cadastre uma em IA › Credenciais " +
          "(ou defina OPENAI_API_KEY na instalação) e este material entra sozinho.",
      });
      await avisarNaCentral(
        row.organization_id,
        fonte,
        `"${fonte.name}" ainda não entrou na base de conhecimento`,
        "Falta uma chave da OpenAI para preparar o material. Cadastre uma em IA › Credenciais " +
          "e a indexação recomeça sozinha — nada do que você enviou foi perdido.",
      );
      // `retry` e não `skipped`: o drain conta `skipped` como sucesso e marca o
      // evento consumido para sempre. Quem cadastrasse a chave amanhã não teria
      // mais nada esperando.
      return {
        consumer_key: consumerKey,
        status: "retry",
        detail: "sem_chave_de_embedding",
        retry_at: new Date(Date.now() + RETRY_SEM_CHAVE_MS).toISOString(),
      };
    }

    await marcarFonte(row.organization_id, fonte.id, { last_index_status: "indexando" });

    const resultado = await indexarFonte(fonte, chave, productId ? { productId } : {});

    if (resultado.tipo === "ok") {
      await marcarFonte(row.organization_id, fonte.id, {
        last_index_status: "success",
        last_index_error: null,
        last_indexed_at: new Date().toISOString(),
        chunks_count: resultado.chunks,
      });
      return {
        consumer_key: consumerKey,
        status: "ok",
        detail: `fonte=${fonte.id} versao=${resultado.versionId} trechos=${resultado.chunks}`,
      };
    }

    if (resultado.tipo === "pulado") {
      // Não é falha: limpar o `indexando` para a tela não ficar girando.
      await marcarFonte(row.organization_id, fonte.id, { last_index_status: null });
      return { consumer_key: consumerKey, status: "skipped", detail: resultado.motivo };
    }

    if (resultado.tipo === "sem_chave") {
      return { consumer_key: consumerKey, status: "retry", detail: "sem_chave_de_embedding" };
    }

    await marcarFonte(row.organization_id, fonte.id, {
      last_index_status: "failed",
      last_index_error: resultado.detalhe,
    });
    await avisarNaCentral(
      row.organization_id,
      fonte,
      `"${fonte.name}" não entrou na base de conhecimento`,
      `O agente ainda não sabe o que está neste material. Motivo: ${resultado.detalhe}`,
    );
    return { consumer_key: consumerKey, status: "error", detail: resultado.detalhe };
  } catch (err) {
    // O worker NUNCA lança: quem chama é o drain, e uma exceção aqui derrubaria
    // o lote inteiro de eventos.
    if (err instanceof SemChaveDeEmbeddingError) {
      return { consumer_key: consumerKey, status: "retry", detail: "sem_chave_de_embedding" };
    }
    const detalhe = err instanceof Error ? err.message : String(err);
    console.error("[rag-indexer] erro não tratado:", detalhe);
    return { consumer_key: consumerKey, status: "error", detail: detalhe };
  }
}
