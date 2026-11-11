/**
 * ÍNDICE DA BASE DE CONHECIMENTO NO CONTEXTO (#4133, item 1) — a lista de
 * materiais que o modelo vê SEM passar por embedding.
 *
 * ─── O problema que este módulo resolve ──────────────────────────────────────
 *
 * Até aqui a base só era alcançável por `searchKnowledge` (embedding). Quem usa
 * a Anthropic direta — que não oferece embedding — precisa de uma segunda conta
 * só para isso, e quando ela fica sem crédito o agente perde a base sem aviso
 * (`knowledge_sem_chave`). O modo `leitura_direta` (escolhido por agente) troca
 * a busca vetorial por duas peças determinísticas:
 *
 *   1. ESTE índice: uma linha por material (`- [id] nome — resumo`);
 *   2. a ferramenta `ler_documento`, que abre o corpo pelo id (`./ler-documento`);
 *
 * nenhuma das duas chama provedor de embedding.
 *
 * ─── O resumo é DERIVADO, não lido de um campo ──────────────────────────────
 *
 * `ai_knowledge_sources` não tem coluna de resumo. A frase de cada material sai,
 * nesta ordem, de UM lugar só (`resumoDoMaterial`):
 *
 *   1. o primeiro par de `ai_faq_items` (a pergunta que a pessoa escreveu é o
 *      melhor resumo possível do material);
 *   2. o primeiro trecho de `ai_chunks` da versão ATIVA (o texto que o agente
 *      já tinha aprendido daquele material);
 *   3. o rótulo canônico do `source_type` (último recurso: material sem par e
 *      sem índice ainda).
 *
 * O blob NÃO é baixado aqui de propósito: a leitura do arquivo é o caminho do
 * `ler_documento` / da tela (`conteudo-do-material.ts`), e baixar N arquivos
 * para montar um índice de N linhas faria o turno pagar o acervo inteiro antes
 * de o modelo pedir UM documento. O critério declarado é: resumo é barato, corpo
 * é sob demanda.
 *
 * ─── Corte DECLARADO, nunca silencioso ──────────────────────────────────────
 *
 * O índice vai no SUFIXO do prompt (por turno), com orçamento fixo
 * (`KNOWLEDGE_INDEX_MAX_TOKENS`). Se não couber, o corte é em degraus — e o
 * último degrau sempre conta o que ficou fora:
 *
 *   1. linha completa: `- [id] nome — resumo` (resumo ≤ `RESUMO_MAX_CHARS`);
 *   2. mesmas linhas, resumo reduzido a `RESUMO_CURTO_MAX_CHARS`;
 *   3. guloso: primeiro a cobertura — `- [id] nome` para todos que couberem —
 *      e, com o que sobrar, o resumo curto das primeiras linhas (o id preserva o
 *      `ler_documento` em toda linha); um aviso diz que aquelas linhas foram
 *      resumidas;
 *   4. rodapé `+N materiais fora do índice — peça pelo nome.` com o total que
 *      não coube nem no degrau 3. Se nem o rodapé couber, ele sai SOZINHO: um
 *      material nunca desaparece sem o modelo saber que existe.
 *
 * ─── Cache ─────────────────────────────────────────────────────────────────
 *
 * A montagem custa 3 consultas (fontes + FAQ + trechos) e é a mesma em TODO turno
 * enquanto o acervo não muda. O cache é um `Map` EM PROCESSO, com:
 *
 *   - chave = (organizationId, ids ordenados, max(updated_at), orçamento);
 *   - TTL curto (`CACHE_TTL_MS`, 60 s) — a invalidação de verdade é a chave:
 *     publicar/editar um material muda `updated_at` e a chave deixa de casar;
 *   - teto de entradas (`CACHE_MAX_ENTRADAS`, 100) com descarte da mais antiga
 *     (ordem de inserção do `Map`) — nada de cache global sem teto.
 *
 * A consulta de FONTES sempre roda (é ela que lê `updated_at` e detecta a
 * invalidação); o que o cache poupa são a derivação dos resumos e a renderização.
 *
 * Isolamento: toda query filtra `organization_id`; material de outra empresa não
 * entra nem por id forjado na lista do agente.
 */
import type { Queryable } from "../queue/queue";
import { countPayloadTokens } from "../edge/crm/get-lead-context";
import { canonizarTipoDeFonte, rotuloDoTipo } from "@/lib/ai/rag/tipos-de-fonte";

/** Cabeçalho do bloco injetado no sufixo do prompt. */
const CABECALHO = "## Base de conhecimento da empresa (índice de documentos)";

/** Instrução que acompanha o índice — é ela que ensina o id do `ler_documento`. */
const INSTRUCAO =
  "Para ler UM documento inteiro, chame ler_documento com o id entre colchetes. " +
  "O resumo não substitui o texto: se a resposta depende do conteúdo, leia o documento — não invente.";

/** Aviso que acompanha as linhas que ficaram sem resumo (degrau 3 do corte). */
const NOTA_SEM_RESUMO =
  "(as últimas linhas vão só com id e nome — o resumo delas não coube no orçamento deste turno)";

/** Sem materiais ativos, o bloco é omitido (ausência não custa token). */
export const SEM_MATERIAIS = "";

/**
 * Orçamento usado quando o knob do env não chegou (`knowledgeIndexMaxTokens`
 * é opcional no `InboundTurnKnobs`). Espelha o default de
 * `KNOWLEDGE_INDEX_MAX_TOKENS` — em runtime quem manda é o env.
 */
export const ORCAMENTO_PADRAO_DO_INDICE = 600;

/** Teto do resumo na primeira tentativa (linha completa). */
export const RESUMO_MAX_CHARS = 140;
/** Teto do resumo quando o orçamento aperta (segunda tentativa). */
export const RESUMO_CURTO_MAX_CHARS = 60;
/** Vida do cache em processo. A invalidação real é a chave (ver cabeçalho). */
export const CACHE_TTL_MS = 60_000;
/** Teto de entradas do cache — descarta a mais antiga por inserção. */
export const CACHE_MAX_ENTRADAS = 100;

/** Uma linha do índice. `id` é o que o modelo cita em `ler_documento`. */
export interface MaterialDoIndice {
  id: string;
  nome: string;
  resumo: string;
}

interface FonteRow {
  id: string;
  name: string;
  source_type: string | null;
  updated_at: string | Date | null;
}

interface EntradaDeCache {
  bloco: string;
  criadaEm: number;
}

const cache = new Map<string, EntradaDeCache>();

/** Só para teste: zera o cache em processo entre casos. */
export function limparCacheDoIndiceDeConhecimento(): void {
  cache.clear();
}

/** Só para teste: quantas entradas o cache guarda hoje (prova do teto). */
export function tamanhoDoCacheDoIndiceDeConhecimento(): number {
  return cache.size;
}

/** Colapsa espaços/quebras e corta em `max` caracteres, com reticências declaradas. */
export function cortarTexto(texto: string, max: number): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.length <= max) return limpo;
  return `${limpo.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Primeira linha com conteúdo de um texto (tira marcador de markdown e corta). */
export function primeiraLinhaUtil(texto: string, max: number): string {
  for (const linha of texto.split(/\r?\n/)) {
    const limpa = linha.replace(/^[\s>#*\-–—•]+/, "").trim();
    if (limpa !== "") return cortarTexto(limpa, max);
  }
  return "";
}

/**
 * O resumo de UM material — a única fonte da frase que vai ao índice. A ordem é
 * FAQ → primeiro trecho indexado → rótulo do tipo (ver cabeçalho do módulo).
 */
export function resumoDoMaterial(entrada: {
  tipo: string | null;
  perguntaDoFaq: string | null | undefined;
  primeiroTrecho: string | null | undefined;
  maxChars?: number;
}): string {
  const max = entrada.maxChars ?? RESUMO_MAX_CHARS;
  const pergunta = entrada.perguntaDoFaq?.trim();
  if (pergunta) return cortarTexto(pergunta, max);
  const trecho = entrada.primeiroTrecho ? primeiraLinhaUtil(entrada.primeiroTrecho, max) : "";
  if (trecho !== "") return trecho;
  return rotuloDoTipo(canonizarTipoDeFonte(entrada.tipo ?? "") ?? "documento");
}

/** Chave do cache: ids ordenados + `max(updated_at)` + orçamento. */
export function chaveDoCacheDoIndice(p: {
  organizationId: string;
  ids: readonly string[];
  maxUpdatedAt: number;
  budgetTokens: number;
}): string {
  return [
    p.organizationId,
    [...p.ids].sort().join(","),
    String(p.maxUpdatedAt),
    String(p.budgetTokens),
  ].join("|");
}

function montarBloco(
  linhas: readonly string[],
  rodape: string | null,
  temLinhasSemResumo: boolean,
): string {
  return [
    CABECALHO,
    INSTRUCAO,
    ...(temLinhasSemResumo ? [NOTA_SEM_RESUMO] : []),
    ...linhas,
    ...(rodape !== null ? [rodape] : []),
  ].join("\n");
}

function tokensDoBloco(bloco: string): number {
  return countPayloadTokens(bloco);
}

function rodapeDeFora(n: number): string {
  return `+${n} ${n === 1 ? "material" : "materiais"} fora do índice — peça pelo nome.`;
}

/**
 * Aplica o orçamento em DEGRAUS e devolve o bloco final (ver cabeçalho). O
 * último degrau nunca esconde um material: as linhas que não couberem nem por
 * nome entram no rodapé, que conta o total — e sai sozinho se não houver espaço
 * para mais nada. Silêncio é a única saída proibida.
 *
 * Custo: O(n) no caminho de estouro (soma incremental por linha; a estimativa é
 * conservadora porque `ceil` por linha ≥ `ceil` do texto inteiro).
 */
export function renderizarIndiceComOrcamento(
  materiais: readonly MaterialDoIndice[],
  budgetTokens: number,
): string {
  if (materiais.length === 0) return SEM_MATERIAIS;

  // 1 e 2 — tentativa inteira, com resumo completo e depois com resumo curto.
  for (const cap of [RESUMO_MAX_CHARS, RESUMO_CURTO_MAX_CHARS]) {
    const bloco = montarBloco(
      materiais.map((m) => `- [${m.id}] ${m.nome} — ${cortarTexto(m.resumo, cap)}`),
      null,
      false,
    );
    if (tokensDoBloco(bloco) <= budgetTokens) return bloco;
  }

  // 3 — guloso: primeiro a COBERTURA (id + nome, o que preserva o
  // `ler_documento` para todo material que couber) e, com o que sobrar, o resumo
  // curto das primeiras linhas. Cobertura antes de resumo: sem o id o modelo não
  // consegue abrir o documento, que é o ponto do modo.
  const reservaDoRodape =
    countPayloadTokens(`${rodapeDeFora(materiais.length)}\n`) +
    countPayloadTokens(`${NOTA_SEM_RESUMO}\n`);
  const custo = (linha: string): number => countPayloadTokens(`${linha}\n`);
  const linhaCurta = (m: MaterialDoIndice): string => `- [${m.id}] ${m.nome}`;
  const linhaComResumo = (m: MaterialDoIndice): string =>
    `- [${m.id}] ${m.nome} — ${cortarTexto(m.resumo, RESUMO_CURTO_MAX_CHARS)}`;

  const linhas: string[] = [];
  const comResumoFlag: boolean[] = [];
  let usado = tokensDoBloco(montarBloco([], null, false));
  for (const material of materiais) {
    const passo = custo(linhaCurta(material));
    if (usado + passo + reservaDoRodape > budgetTokens) break;
    linhas.push(linhaCurta(material));
    comResumoFlag.push(false);
    usado += passo;
  }

  for (let i = 0; i < linhas.length; i += 1) {
    const material = materiais[i]!;
    const extra = custo(linhaComResumo(material)) - custo(linhas[i]!);
    if (usado + extra > budgetTokens) break;
    linhas[i] = linhaComResumo(material);
    comResumoFlag[i] = true;
    usado += extra;
  }

  // O `ceil` por linha é conservador, mas não exato: se ainda assim o bloco
  // passar do orçamento, sai a ÚLTIMA linha (nunca o aviso) até caber. O laço é
  // curto porque a diferença fica em poucos tokens.
  const montarComCorte = (quantas: number): string =>
    montarBloco(
      linhas.slice(0, quantas),
      quantas < materiais.length ? rodapeDeFora(materiais.length - quantas) : null,
      comResumoFlag.slice(0, quantas).some((temResumo) => !temResumo),
    );
  let quantas = linhas.length;
  let bloco = montarComCorte(quantas);
  while (tokensDoBloco(bloco) > budgetTokens && quantas > 0) {
    quantas -= 1;
    bloco = montarComCorte(quantas);
  }
  if (tokensDoBloco(bloco) <= budgetTokens) return bloco;

  // Degrau final — orçamento mínimo: só o aviso, que nunca é omitido.
  return rodapeDeFora(materiais.length);
}

/** Uma consulta para todos os materiais: `distinct on` traz o primeiro de cada. */
async function lerPerguntasDoFaq(
  db: Queryable,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await db.query<{ knowledge_source_id: string; question: string }>(
    `select distinct on (knowledge_source_id) knowledge_source_id, question
       from ai_faq_items
      where organization_id = $1 and knowledge_source_id::text = any($2::text[])
      order by knowledge_source_id, position, id`,
    [organizationId, ids],
  );
  return new Map(rows.map((r) => [r.knowledge_source_id, r.question]));
}

/** Uma consulta para todos os materiais: o primeiro trecho da versão ATIVA de cada. */
async function lerPrimeirosTrechos(
  db: Queryable,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await db.query<{ knowledge_source_id: string; content: string }>(
    `select distinct on (c.knowledge_source_id) c.knowledge_source_id, c.content
       from ai_chunks c
       join ai_knowledge_sources s on s.id = c.knowledge_source_id
      where c.organization_id = $1 and s.organization_id = $1
        and c.knowledge_source_id::text = any($2::text[])
        and c.kb_version_id = s.active_kb_version_id
      order by c.knowledge_source_id, c.position, c.id`,
    [organizationId, ids],
  );
  return new Map(rows.map((r) => [r.knowledge_source_id, r.content]));
}

/** Materiais ATIVOS da organização, na ordem estável do índice (nome, id). */
async function lerFontes(
  db: Queryable,
  organizationId: string,
  ids: readonly string[],
): Promise<FonteRow[]> {
  const { rows } = await db.query<FonteRow>(
    `select id, name, source_type, updated_at
       from ai_knowledge_sources
      where organization_id = $1 and id::text = any($2::text[]) and is_active = true
      order by name, id`,
    [organizationId, ids],
  );
  return [...rows].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1,
  );
}

function maiorUpdatedAt(fontes: readonly FonteRow[]): number {
  let maior = 0;
  for (const fonte of fontes) {
    const ms = fonte.updated_at === null ? Number.NaN : new Date(fonte.updated_at).getTime();
    if (Number.isFinite(ms) && ms > maior) maior = ms;
  }
  return maior;
}

function guardarNoCache(chave: string, bloco: string, agora: number): void {
  cache.delete(chave);
  cache.set(chave, { bloco, criadaEm: agora });
  while (cache.size > CACHE_MAX_ENTRADAS) {
    const maisAntiga = cache.keys().next().value;
    if (maisAntiga === undefined) break;
    cache.delete(maisAntiga);
  }
}

/**
 * O bloco do índice, pronto para o sufixo do prompt. Vazio (`''`) quando o
 * agente não tem material ativo — quem chama não injeta bloco vazio.
 */
export async function buildKnowledgeIndexBlock(
  db: Queryable,
  organizationId: string,
  sourceIds: readonly string[],
  budgetTokens: number,
  opcoes?: { agora?: () => number },
): Promise<string> {
  const ids = [
    ...new Set(
      sourceIds.filter((s) => typeof s === "string" && s.trim() !== "").map((s) => s.trim()),
    ),
  ].sort();
  if (ids.length === 0) return SEM_MATERIAIS;

  const fontes = await lerFontes(db, organizationId, ids);
  if (fontes.length === 0) return SEM_MATERIAIS;

  const chave = chaveDoCacheDoIndice({
    organizationId,
    ids,
    maxUpdatedAt: maiorUpdatedAt(fontes),
    budgetTokens,
  });
  const agora = (opcoes?.agora ?? Date.now)();
  const emCache = cache.get(chave);
  if (emCache !== undefined && agora - emCache.criadaEm < CACHE_TTL_MS) return emCache.bloco;

  const [perguntas, trechos] = await Promise.all([
    lerPerguntasDoFaq(
      db,
      organizationId,
      fontes.map((f) => f.id),
    ),
    lerPrimeirosTrechos(
      db,
      organizationId,
      fontes.map((f) => f.id),
    ),
  ]);
  const materiais = fontes.map<MaterialDoIndice>((fonte) => ({
    id: fonte.id,
    nome: fonte.name,
    resumo: resumoDoMaterial({
      tipo: fonte.source_type,
      perguntaDoFaq: perguntas.get(fonte.id),
      primeiroTrecho: trechos.get(fonte.id),
    }),
  }));
  const bloco = renderizarIndiceComOrcamento(materiais, budgetTokens);
  if (bloco !== SEM_MATERIAIS) guardarNoCache(chave, bloco, agora);
  return bloco;
}
