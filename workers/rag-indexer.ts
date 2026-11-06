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

import { embedTexts, SemChaveDeEmbeddingError } from "@/lib/ai/embed";
import {
  FamiliaDaBaseIlegivelError,
  modeloDeEmbedding,
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
  /** Hash do conteúdo indexado por último — base do pulo incremental (0409). */
  content_hash: string | null;
  last_index_status: string | null;
  active_kb_version_id: string | null;
}

/** As colunas de `FonteRow` — um só lugar para as três leituras da fonte. */
const COLUNAS_DA_FONTE =
  "id, organization_id, agent_id, source_type, name, status, is_active, source_metadata, content_hash, last_index_status, active_kb_version_id";

/** Um pedaço pronto para virar vetor. */
interface Pedaco {
  content: string;
  metadata: Record<string, unknown>;
}

type Resultado =
  | { tipo: "ok"; versionId: string; chunks: number; contentHash: string }
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
    .select(COLUNAS_DA_FONTE)
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
async function pedacosDeCatalogo(fonte: FonteRow): Promise<Pedaco[]> {
  // SEMPRE a loja INTEIRA, e isso é o invariante desta fonte: cada indexação
  // publica uma versão nova que substitui a anterior, e a busca só enxerga a
  // ativa. Uma versão montada com um produto só apagaria os outros do acervo,
  // sem erro nenhum. A função nem aceita um produto avulso para que não exista
  // caminho que leve a isso.
  const produtos = await listarCatalogoDaLoja(fonte.organization_id);

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

/**
 * O catálogo inteiro, para a carga inicial de uma loja recém-conectada.
 *
 * Paginado, com teto de propósito. O limite não é a API da loja: é o reaper do
 * drain, que devolve à fila evento em `processing` há mais de 10 minutos.
 * Passar dessa janela não deixa a carga lenta — faz DOIS workers indexarem a
 * mesma fonte, com o embedding pago em dobro e corrida na ativação da versão.
 *
 * A primeira versão deste teto declarava 2 mil produtos e NÃO os entregava: os
 * embeddings saíam um a um, a 200-400 ms por pedaço, e cada produto rende um ou
 * dois pedaços. Dá de 6,7 min (2000 × 1 × 0,2 s) a 26,7 min (2000 × 2 × 0,4 s)
 * contra uma janela de 10. No pior caso a janela só comportava ~750 produtos, e
 * menos que isso contando a ida ao banco por trecho, que o laço antigo também
 * fazia uma a uma.
 *
 * Agora os embeddings vão em lote (`TRECHOS_POR_LOTE`), que é o que faz 2 mil
 * produtos caberem de fato: ~40 chamadas de 100 textos, da ordem de segundos
 * cada (o 200-400 ms era o custo de UM texto), mais ~40 idas ao banco. Sobra
 * folga larga nos 10 minutos.
 *
 * O teto segue em 10 páginas porque a janela não mudou, e o que passar disso
 * FALHA com a conta na mensagem, em vez de virar catálogo pela metade publicado
 * como completo. Loja maior precisa de carga com cursor entre execuções, que é
 * trabalho próprio e está registrado como tal.
 */
/** 10 páginas de 200 = 2 mil produtos. Ver o porquê do teto acima. */
const TETO_DE_PAGINAS = 10;

/**
 * Trechos por chamada de embedding.
 *
 * É o que faz o teto de 2 mil produtos ser verdadeiro em vez de declarado: o
 * `embedMany` do AI SDK divide a lista conforme o limite do provedor e
 * paraleliza as partes, então o lote de 100 troca ~4 mil chamadas HTTP em série
 * por ~40, e isso cabe na janela de 10 minutos do reaper — o limite que o teto
 * pequeno existia para respeitar.
 *
 * 100 não é número redondo: é o `maxEmbeddingsPerCall` do `@ai-sdk/google`
 * (o da OpenAI é 2048). Ou seja, é o maior valor que ainda é UMA chamada HTTP
 * nos dois provedores, e é disso que as ~40 chamadas dependem. Subir daqui não
 * quebra, porque o `embedMany` fatia sozinho, mas invalida a conta acima.
 */
const TRECHOS_POR_LOTE = 100;

async function listarCatalogoDaLoja(organizationId: string): Promise<NuvemshopProduct[]> {
  const creds = await credenciaisDaLoja(organizationId);
  if (!creds) {
    console.warn("[rag-indexer] loja não conectada para a org", organizationId);
    return [];
  }
  const client = new NuvemshopApiClient({
    storeId: creds.storeId,
    accessToken: creds.accessToken,
  });
  const todos: NuvemshopProduct[] = [];
  for (let pagina = 1; pagina <= TETO_DE_PAGINAS; pagina += 1) {
    let lote: NuvemshopProduct[];
    try {
      lote = await client.get<NuvemshopProduct[]>(`/products?per_page=200&page=${pagina}`);
    } catch (err) {
      // ERRO SOBE, e não `break`.
      //
      // O `break` fazia pior do que parecia: com a página 1 falhando (429, 5xx,
      // rede), `[]` é indistinguível de "loja sem produtos" e o evento era
      // marcado consumido para sempre; com uma página do meio falhando, um
      // catálogo truncado era ATIVADO como se estivesse completo, e o
      // `content_hash` do truncado fazia a carga seguinte ser pulada por
      // "sem_mudanca". Não existe "próxima sincronização completa o resto": o
      // único emissor de carga inteira é a conexão.
      //
      // Deixando subir, o drain reagenda com backoff e, no limite, abre aviso
      // crítico. Barulho é o desfecho certo aqui.
      throw new Error(
        `catálogo incompleto: página ${pagina} falhou (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
    if (!Array.isArray(lote) || lote.length === 0) return todos;
    todos.push(...lote);
    if (lote.length < 200) return todos;
  }
  // Chegou ao teto com a página cheia: há mais loja do que esta carga alcança.
  // Devolver o que veio publicaria um catálogo truncado como se fosse a loja
  // inteira, e o `content_hash` do truncado faria a carga seguinte ser pulada
  // por "sem_mudanca" — o erro que se conserta sozinho nunca, porque ninguém vê.
  throw new Error(
    `catálogo maior que o teto desta carga: ${todos.length} produtos em ${TETO_DE_PAGINAS} páginas. ` +
      "Loja desse tamanho precisa de carga com cursor entre execuções.",
  );
}

async function credenciaisDaLoja(
  organizationId: string,
): Promise<{ accessToken: string; storeId: string } | null> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, provider, store_metadata, oauth_access_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", "nuvemshop")
    // `healthy`, e não `active`: o CHECK de `tenant_integrations` aceita
    // connecting | healthy | token_expired | scope_missing | disconnected |
    // rate_limited | error. `active` NUNCA existiu, então este filtro devolvia
    // zero linhas para toda organização — e, com credencial nula, o catálogo
    // não tinha como ser lido nem que todo o resto estivesse certo.
    .eq("status", "healthy")
    .maybeSingle();

  if (error || !data) return null;

  const meta = (data as { store_metadata: Record<string, unknown> | null }).store_metadata ?? {};
  const storeId = String(meta["store_id"] ?? meta["id"] ?? "");
  if (!storeId) return null;

  // `fn_decrypt_oauth(ciphertext bytea)` — UM argumento, e é o texto cifrado.
  //
  // Aqui se pedia `p_organization_id` e `p_integration_id`, que não existem em
  // assinatura nenhuma: o PostgREST devolvia "função não encontrada", a
  // credencial voltava nula e o catálogo ficava vazio pelo mesmo silêncio que
  // esta correção veio matar — um nível abaixo. Quem escondeu isso do
  // compilador foi o `as never`, por isso ele saiu junto.
  //
  // O mesmo padrão está em `webhooks/nuvemshop/[event]/route.ts` e em
  // `lib/webhooks/secrets.ts`.
  const cifrado = (data as { oauth_access_token_encrypted: string | null })
    .oauth_access_token_encrypted;
  if (!cifrado) return null;
  const { data: decrypted, error: decErr } = await admin.rpc("fn_decrypt_oauth", {
    ciphertext: cifrado,
  });

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
        pedacos = await pedacosDeCatalogo(fonte);
        break;
      case "conversas":
        // A ingestão anonimizada tem pipeline próprio (cron
        // `kb-conversations-batch`), que embeda e grava por conta.
        return { tipo: "pulado", motivo: "conversas_tem_pipeline_proprio" };
    }
  } catch (err) {
    if (err instanceof ErroDeExtracao) {
      // A mensagem é a chave estável; a causa mora em `detalhe`. Aqui é o
      // único registro da falha numa reindexação — o cartão da fonte e o aviso
      // da Central mostram este texto como está, sem traduzir —, então gravar
      // só a chave apagaria a causa.
      //
      // Quem preenche `detalhe` hoje é o erro do Storage e a extensão
      // desconhecida (`lib/ai/rag/ingest/documento.ts:78-92`). A mensagem do
      // parser de PDF não chega: `extractPdfText` embrulha toda falha em
      // `PdfExtractError`, e o ramo que casa com ela (`documento.ts:103-108`)
      // não repassa causa — é o #1061 que abre esse ramo, não este código.
      return {
        tipo: "erro",
        detalhe: err.detalhe ? `${err.message} (${err.detalhe})` : err.message,
      };
    }
    return { tipo: "erro", detalhe: err instanceof Error ? err.message : String(err) };
  }

  if (pedacos.length === 0) {
    return { tipo: "pulado", motivo: "sem_conteudo_para_indexar" };
  }

  // ─── Pulo incremental ──────────────────────────────────────────────────────
  // Se o conteúdo NÃO mudou, já está `success` e a versão ativa foi indexada com
  // o MESMO modelo de embedding, não há nada a fazer — e "Preparar tudo" deixa de
  // reembedar o que não mudou. Trocar de modelo cai fora da condição e reindexa:
  // é isto que faz a troca de provedor refazer a base inteira.
  const modelo = modeloDeEmbedding(chave.provedor);
  const hashDoConteudo = computeContentHash(pedacos.map((p) => p.content).join("\n---\n"));
  if (
    fonte.content_hash === hashDoConteudo &&
    fonte.last_index_status === "success" &&
    fonte.active_kb_version_id !== null
  ) {
    const { data: versaoAtiva } = await createAdminClient()
      .from("ai_knowledge_versions")
      .select("embedding_model")
      .eq("id", fonte.active_kb_version_id)
      .eq("organization_id", fonte.organization_id)
      .maybeSingle();
    if ((versaoAtiva as { embedding_model?: string } | null)?.embedding_model === modelo) {
      return { tipo: "pulado", motivo: "sem_mudanca" };
    }
  }

  const { versionId, versionNumber } = await createKnowledgeVersion({
    organizationId: fonte.organization_id,
    knowledgeSourceId: fonte.id,
    agentId: fonte.agent_id,
    sourceType: tipo,
    embeddingModel: modelo,
  });

  console.warn(
    `[rag-indexer] "${fonte.name}" → versão ${versionNumber} (${versionId}), ${pedacos.length} trecho(s)`,
  );

  const admin = createAdminClient();
  let gravados = 0;
  // Trecho que não gravou NÃO pode seguir para a ativação: a versão fica
  // incompleta e a anterior — que funciona — é quem deve continuar no ar.
  const falhas: Array<{ de: number; ate: number; mensagem: string }> = [];

  // EM LOTES, e nao um-a-um. O laco sequencial era o teto real da indexacao:
  // a 200-400 ms por pedaco, mil produtos passavam da janela de 10 minutos que
  // o reaper do drain usa para devolver evento a fila, e o efeito nao era carga
  // lenta — eram DOIS workers na mesma fonte, embedding pago em dobro e corrida
  // na ativacao da versao. `embedTexts` manda o lote numa chamada e o upsert vai
  // junto, com uma ida ao banco por lote em vez de uma por trecho.
  for (let inicio = 0; inicio < pedacos.length; inicio += TRECHOS_POR_LOTE) {
    const lote = pedacos.slice(inicio, inicio + TRECHOS_POR_LOTE);

    let embeddings: number[][];
    try {
      // `chave` ja resolvida: sem isto, um documento de 200 trechos decifraria a
      // credencial 200 vezes.
      const r = await embedTexts(
        lote.map((p) => p.content),
        { organizationId: fonte.organization_id, chave },
      );
      embeddings = r.embeddings;
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      // A FAIXA, não `inicio`: em lote não se sabe qual trecho o provedor
      // recusou, e este texto aparece para o cliente no cartão da fonte.
      // Dizer "trecho 100" quando a culpa pode ser do 173 é mentir com número.
      const faixa = `${inicio}-${inicio + lote.length - 1}`;
      await markVersionFailed(versionId, fonte.organization_id, `embed@lote ${faixa}: ${detalhe}`);
      return { tipo: "erro", detalhe: `embedding falhou no lote ${faixa}: ${detalhe}` };
    }

    const linhas = lote.map((p, j) => ({
      organization_id: fonte.organization_id,
      kb_version_id: versionId,
      knowledge_source_id: fonte.id,
      position: inicio + j,
      content: p.content,
      content_hash: computeContentHash(p.content),
      token_count: estimateTokens(p.content),
      embedding: embeddings[j] as unknown as string,
      metadata: p.metadata,
    }));

    const { error: upErr } = await admin.from("ai_chunks").upsert(
      linhas,
      // A constraint que EXISTE e `ai_chunks_position_unique`
      // (knowledge_source_id, kb_version_id, position). Como cada indexacao cria
      // uma versao nova, na pratica nunca ha conflito — o alvo certo e o que faz
      // o insert passar.
      { onConflict: "knowledge_source_id,kb_version_id,position", ignoreDuplicates: true },
    );

    if (upErr) {
      // O lote e atomico: se deu erro, nenhuma linha dele entrou. Guardar a
      // FAIXA, e nao cada posicao, porque com lote de 100 a mensagem de falha
      // viraria uma lista de cem numeros iguais.
      falhas.push({ de: inicio, ate: inicio + linhas.length - 1, mensagem: upErr.message });
    } else {
      gravados += linhas.length;
    }
  }

  if (gravados === 0) {
    await markVersionFailed(versionId, fonte.organization_id, "nenhum trecho gravado");
    return { tipo: "erro", detalhe: "nenhum_trecho_gravado" };
  }

  if (falhas.length > 0) {
    const quantos = falhas.reduce((soma, f) => soma + (f.ate - f.de + 1), 0);
    await markVersionFailed(
      versionId,
      fonte.organization_id,
      `${quantos} de ${pedacos.length} trechos não gravaram: ${falhas
        .map((f) => `posições ${f.de}-${f.ate} (${f.mensagem})`)
        .join("; ")}`,
    );
    return { tipo: "erro", detalhe: `trechos_nao_gravados:${quantos}` };
  }

  await markVersionReady(versionId, fonte.organization_id, gravados);
  await activateVersion({
    organizationId: fonte.organization_id,
    knowledgeSourceId: fonte.id,
    versionId,
  });

  return { tipo: "ok", versionId, chunks: gravados, contentHash: hashDoConteudo };
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
  motivo?: string;
}> {
  if (row.event_type === "knowledge_source.updated") {
    const sourceId = String(row.payload["knowledge_source_id"] ?? "");
    if (!sourceId) return { fonte: null, motivo: "evento_sem_knowledge_source_id" };
    const fonte = await carregarFonte(row.organization_id, sourceId);
    return { fonte, ...(fonte ? {} : { motivo: "fonte_nao_encontrada" }) };
  }

  // nuvemshop.product_synced — o evento diz O QUE mudou, não o que indexar:
  // a reindexação é sempre da loja inteira (ver `pedacosDeCatalogo`). O
  // `product_id` serve só para separar evento legítimo de evento malformado.
  //
  // `catalogo_inteiro` é a carga inicial, emitida quando a loja acaba de
  // conectar: ali não existe produto nenhum em mãos, e exigir `product_id`
  // deixava a conexão nova com um acervo vazio até alguém editar um produto.
  const catalogoInteiro = row.payload["catalogo_inteiro"] === true;
  const temProduto = String(row.payload["product_id"] ?? "") !== "";
  if (!temProduto && !catalogoInteiro) return { fonte: null, motivo: "evento_sem_product_id" };
  const fonte = await garantirFonteDeCatalogo(row.organization_id);
  // ── A VERSÃO ATIVA DO CATÁLOGO NUNCA PODE ENCOLHER ───────────────────────
  //
  // `indexarFonte` cria uma versão com os pedaços que receber e a ATIVA, e
  // `activateVersion` desliga a anterior; a busca só enxerga o ponteiro ativo
  // (`fn_buscar_trechos_das_fontes` filtra `c.kb_version_id =
  // s.active_kb_version_id`). Indexar UM produto na fonte do catálogo
  // publicaria uma versão com um item só, e os outros ficariam invisíveis ao
  // agente — a loja inteira apagada pela edição de um preço, sem erro nenhum.
  //
  // Por isso todo evento de produto reindexa o catálogo inteiro. O debounce
  // junta a rajada de quem edita vários produtos seguidos. Indexação
  // incremental de verdade (herdar os pedaços da versão ativa e trocar só os do
  // produto tocado) é o desenho que economiza embedding, e é trabalho próprio.
  //
  // `product_id` segue no payload de propósito: o log do turno diz qual edição
  // disparou a carga.
  return { fonte, ...(fonte ? {} : { motivo: "fonte_de_catalogo_indisponivel" }) };
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
    .select(COLUNAS_DA_FONTE)
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
    .select(COLUNAS_DA_FONTE)
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
    const { fonte, motivo } = await fonteDoEvento(row);
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
          "Falta uma chave de embedding para indexar. Cadastre uma chave OpenAI ou OpenRouter " +
          "em IA › Credenciais e este material entra sozinho.",
      });
      await avisarNaCentral(
        row.organization_id,
        fonte,
        `"${fonte.name}" ainda não entrou na base de conhecimento`,
        "Falta uma chave de embedding para preparar o material. Cadastre uma em IA › Credenciais " +
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

    const resultado = await indexarFonte(fonte, chave);

    if (resultado.tipo === "ok") {
      await marcarFonte(row.organization_id, fonte.id, {
        last_index_status: "success",
        last_index_error: null,
        last_indexed_at: new Date().toISOString(),
        chunks_count: resultado.chunks,
        content_hash: resultado.contentHash,
      });
      return {
        consumer_key: consumerKey,
        status: "ok",
        detail: `fonte=${fonte.id} versao=${resultado.versionId} trechos=${resultado.chunks}`,
      };
    }

    if (resultado.tipo === "pulado") {
      // Não é falha. `sem_mudanca` RESTAURA o `success` (o material já estava
      // pronto e continua pronto — limpar para null o faria parecer "nunca
      // indexado"); os demais pulos limpam o `indexando` para a tela não girar.
      await marcarFonte(row.organization_id, fonte.id, {
        last_index_status: resultado.motivo === "sem_mudanca" ? "success" : null,
      });
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
    // Sem saber a família, indexar com qualquer chave pode ativar uma versão da
    // OUTRA família. Nada é indexado; o evento volta quando o banco responder.
    if (err instanceof FamiliaDaBaseIlegivelError) {
      return { consumer_key: consumerKey, status: "retry", detail: "familia_da_base_ilegivel" };
    }
    const detalhe = err instanceof Error ? err.message : String(err);
    console.error("[rag-indexer] erro não tratado:", detalhe);
    return { consumer_key: consumerKey, status: "error", detail: detalhe };
  }
}
