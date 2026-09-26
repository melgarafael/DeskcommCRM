/**
 * Extração DIRIGIDA de critérios (mecanismo do motor, não tool-use da IA).
 *
 * ─── O problema ─────────────────────────────────────────────────────────────
 * Quando o cliente pede uma moto que NÃO temos (modelo, marca, cilindrada…), o
 * motor precisa saber "o que essa moto é" (segmento/categoria, marca, cc) para
 * oferecer as parecidas. O modelo lite NÃO faz o 2º passo de tool sozinho.
 *
 * ─── A solução ──────────────────────────────────────────────────────────────
 * O motor faz UMA pergunta FECHADA à IA — "olhando o ESTOQUE e o pedido do
 * cliente (que pode estar errado/incompleto), quais motos têm configurações
 * parecidas?" — e SALVA a resposta como critérios do turno. Depois consulta/
 * ordena com eles. Vale para QUALQUER coluna de critério (marca, categoria,
 * cilindrada, cor, ano…), não só marca.
 *
 * ─── Por que mandar o ESTOQUE no prompt (decisão do dono, 2026-09-26) ────────
 * "Consultar a internet" traria centenas de possibilidades. O dono quer o
 * contrário: a IA recebe as motos REAIS do estoque (colunas marcadas "Enviar à
 * IA") e responde QUAIS DELAS têm configuração parecida com o que o cliente
 * quis — na dúvida, TODAS as que poderiam ser. O formato devolvido traz
 * `hipoteses` (configs concretas) + `faixas` (intervalos) juntas, e o motor
 * aplica isso como FILTRO (com fallback para as mais próximas).
 *
 * É o padrão do `intent-classifier`: o classificador SUGERE, o motor decide; a
 * saída do modelo é não-confiável e o parse NUNCA lança.
 */
import type pg from 'pg';

import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { Logger } from '../obs/logger';
import type { MotoDoCatalogo } from './fotos-do-catalogo';

const JSON_INSTRUCTION =
  'Responda SOMENTE o JSON, no MESMO formato do exemplo, sem texto antes ou depois.';

/** Uma hipótese de configuração de moto (parecida com o que o cliente quis). */
export interface HipoteseDeMoto {
  /** Nome/modelo provável (ex.: "CB 250"), como o cliente quis. */
  nome?: string;
  marca?: string;
  categoria?: string;
  cilindrada?: string;
  preco?: string;
  [coluna: string]: string | undefined;
}

/** Faixa/intervalo aceitável por coluna (ex.: cilindrada 125–300). */
export interface FaixasDoPedido {
  cilindrada?: { min?: number; max?: number };
  preco?: { min?: number; max?: number };
  [coluna: string]: unknown;
}

/** Resultado da pergunta dirigida: INTENÇÃO + hipóteses + faixas + critérios. */
export interface CriteriosExtraidos {
  /** 'pedido' = cliente pede uma moto; 'alternativa' = quer algo DIFERENTE da atual. */
  intencao: 'pedido' | 'alternativa' | null;
  criterios: Record<string, string>;
  /** Configurações concretas de motos parecidas (na dúvida, várias). */
  hipoteses: HipoteseDeMoto[];
  /** Intervalos aceitáveis por coluna (cilindrada/preço/categoria/marca…). */
  faixas: FaixasDoPedido;
}

/** Formato vazio (nunca lança). */
export function criteriosVazios(): CriteriosExtraidos {
  return { intencao: null, criterios: {}, hipoteses: [], faixas: {} };
}

/** Quantas motos do estoque entram no prompt (evita estourar o contexto). */
const MAX_MOTOS_NO_PROMPT = 60;

/**
 * A linha de UMA moto do estoque, só com as colunas visíveis à IA.
 * Ex.: `- HONDA CB 300 (marca: HONDA; categoria: Street, Naked; cilindrada: 293.5 cc; preco: 14990.00)`.
 */
function linhaDaMoto(moto: MotoDoCatalogo, colunas: readonly string[]): string {
  const partes: string[] = [];
  for (const coluna of colunas) {
    const v = moto.valores?.[coluna];
    if (typeof v === 'string' && v.trim() !== '') partes.push(`${coluna}: ${v.trim()}`);
  }
  return `- ${moto.nome}${partes.length > 0 ? ` (${partes.join('; ')})` : ''}`;
}

/**
 * Monta a pergunta fechada: o ESTOQUE (motos reais) + as colunas de critério e
 * um EXEMPLO PREENCHIDO no formato novo (hipóteses + faixas + criterios).
 * O exemplo é essencial: sem ele o modelo lite devolvia `{}` (medido).
 */
export function buildCriteriosPrompt(
  mensagem: string,
  colunas: readonly string[],
  valores?: Record<string, readonly string[]>,
  estoque?: readonly MotoDoCatalogo[],
): string {
  const lista = colunas
    .map((c) => {
      const vs = valores?.[c];
      return vs !== undefined && vs.length > 0
        ? `- ${c} (valores possíveis: ${vs.slice(0, 12).join(', ')})`
        : `- ${c}`;
    })
    .join('\n');
  const exemplo = JSON.stringify({
    intencao: 'pedido',
    hipoteses: [
      Object.fromEntries(colunas.slice(0, 3).map((c) => [c, valores?.[c]?.[0] ?? `<valor de ${c}>`])),
    ],
    faixas: { cilindrada: { min: 125, max: 300 }, preco: { min: 9000, max: 20000 } },
  });
  const estoqueBlock =
    estoque !== undefined && estoque.length > 0
      ? [
          '',
          `ESTOQUE DISPONÍVEL (${estoque.length} motos reais — escolha entre ELAS):`,
          ...estoque.slice(0, MAX_MOTOS_NO_PROMPT).map((m) => linhaDaMoto(m, colunas)),
        ].join('\n')
      : '';
  return [
    'Você é um classificador auxiliar (NÃO responde ao cliente).',
    'O cliente pode ter digitado ERRADO ou INCOMPLETO. Sua tarefa é entender o que ele QUER e',
    'dizer quais motos do ESTOQUE abaixo têm configuração PARECIDA com o pedido.',
    'NA DÚVIDA, inclua TODAS as motos que POSSAM ser — é melhor oferecer demais do que zerar.',
    'Intenções possíveis:',
    '- "pedido": o cliente pede/quer uma moto (por nome, marca, cilindrada, estilo…).',
    '- "alternativa": o cliente está falando de uma moto e quer algo DIFERENTE dela (ex.: achou caro, quer outra cor/ano/marca, quer mais barata).',
    'Devolva TRÊS blocos:',
    '- "hipoteses": lista de configurações concretas prováveis (ex.: {"nome":"CB 250","marca":"HONDA","categoria":"Naked","cilindrada":"250"}). Inclua variações plausíveis (o cliente pode ter errado a cilindrada/modelo).',
    '- "faixas": intervalos aceitáveis (ex.: {"cilindrada":{"min":125,"max":300},"preco":{"min":9000,"max":20000}}). Use quando o pedido for vago.',
    'Para uma PREFERÊNCIA de ordem numa coluna (mais barata, mais nova, menos km), use o valor "menor" ou "maior" em "criterios" (ex.: {"preco":"menor"} = mais barata que a atual).',
    'Colunas de critério:',
    lista,
    'IMPORTANTE: use SOMENTE estas colunas e valores que façam sentido para o ESTOQUE. NUNCA copie',
    'a moto atual da conversa como se fosse o pedido do cliente.',
    estoqueBlock,
    '',
    `EXEMPLO de resposta (formato exato, preenchido): ${exemplo}`,
    '',
    'Mensagem do cliente:',
    mensagem,
    '',
    'Agora responda com o JSON preenchido (mesmo formato do exemplo): "intencao", "hipoteses" e "faixas".',
    'NUNCA devolva vazio: se não tiver certeza do modelo, preencha "faixas" com um intervalo amplo.',
    JSON_INSTRUCTION,
  ].join('\n');
}

/** Lê um número de um valor (aceita string, número e objeto {min}/{max}). */
function comoNumero(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  if (typeof valor === 'string') {
    const n = Number(valor.replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Normaliza as faixas: só colunas permitidas; min/max numéricos. */
function parseFaixas(bruto: unknown, colunasPermitidas: readonly string[]): FaixasDoPedido {
  const saida: FaixasDoPedido = {};
  if (typeof bruto !== 'object' || bruto === null) return saida;
  for (const [coluna, valor] of Object.entries(bruto as Record<string, unknown>)) {
    if (!colunasPermitidas.includes(coluna)) continue;
    if (valor === null || valor === undefined) continue;
    if (typeof valor === 'object') {
      const obj = valor as Record<string, unknown>;
      const min = comoNumero(obj.min ?? obj.de ?? obj.minimo);
      const max = comoNumero(obj.max ?? obj.ate ?? obj.maximo);
      if (min !== null || max !== null) {
        saida[coluna] = { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
      }
      continue;
    }
    const n = comoNumero(valor);
    if (n !== null) saida[coluna] = { min: n, max: n };
  }
  return saida;
}

/**
 * Parse tolerante (nunca lança). Aceita o formato novo (`hipoteses`/`faixas` +
 * `criterios`) E o antigo (só `criterios`). Só colunas permitidas; valores
 * string/número; ignora o resto. Saída inesperada vira o formato vazio.
 */
export function parseCriterios(
  text: string,
  colunasPermitidas: readonly string[],
): CriteriosExtraidos {
  const vazio = criteriosVazios();
  const inicio = text.indexOf('{');
  const fim = text.lastIndexOf('}');
  if (inicio === -1 || fim <= inicio) return vazio;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(inicio, fim + 1));
  } catch {
    return vazio;
  }
  if (typeof parsed !== 'object' || parsed === null) return vazio;
  const obj = parsed as Record<string, unknown>;
  const intencaoBruta = obj.intencao;
  const intencao =
    intencaoBruta === 'pedido' || intencaoBruta === 'alternativa' ? intencaoBruta : null;

  // Critérios: aceita `{criterios:{...}}` OU o objeto plano `{categoria:"...", ...}`
  // (o modelo lite às vezes esquece o envelope). Mantido por retrocompatibilidade.
  const brutoCriterios =
    typeof obj.criterios === 'object' && obj.criterios !== null
      ? (obj.criterios as Record<string, unknown>)
      : obj;
  const criterios: Record<string, string> = {};
  for (const [coluna, valor] of Object.entries(brutoCriterios)) {
    if (coluna === 'intencao' || coluna === 'hipoteses' || coluna === 'faixas') continue;
    if (!colunasPermitidas.includes(coluna)) continue;
    if (typeof valor === 'string' && valor.trim() !== '') criterios[coluna] = valor.trim();
    else if (typeof valor === 'number' && Number.isFinite(valor)) criterios[coluna] = String(valor);
  }

  // Hipóteses: lista de objetos; mantém só as colunas permitidas.
  const hipoteses: HipoteseDeMoto[] = [];
  if (Array.isArray(obj.hipoteses)) {
    for (const item of obj.hipoteses) {
      if (typeof item !== 'object' || item === null) continue;
      const hip: HipoteseDeMoto = {};
      for (const [coluna, valor] of Object.entries(item as Record<string, unknown>)) {
        if (!colunasPermitidas.includes(coluna)) continue;
        if (typeof valor === 'string' && valor.trim() !== '') hip[coluna] = valor.trim();
        else if (typeof valor === 'number' && Number.isFinite(valor)) hip[coluna] = String(valor);
      }
      if (Object.keys(hip).length > 0) hipoteses.push(hip);
    }
  }

  return { intencao, criterios, hipoteses, faixas: parseFaixas(obj.faixas, colunasPermitidas) };
}

export interface ExtrairCriteriosDeps {
  log: Logger;
  runModelCall?: typeof runModelCall;
}

/**
 * Pergunta à IA quais são os critérios da moto pedida e devolve o mapa
 * `coluna → valor` (+ hipóteses/faixas). Nunca lança: falha do modelo devolve o
 * formato vazio (o turno segue com o que o motor conseguiu inferir sozinho).
 */
export async function extrairCriterios(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string | null;
    jobId: string | null;
    model: string;
    /** Provider do modelo (ex.: 'openrouter'); sem ele o modelo viaja p/ o provider errado. */
    provider?: string | null;
    mensagem: string;
    colunas: readonly string[];
    valores?: Record<string, readonly string[]>;
    /** Motos reais do estoque (colunas "Enviar à IA") — a IA escolhe entre elas. */
    estoque?: readonly MotoDoCatalogo[];
  },
  deps: ExtrairCriteriosDeps,
): Promise<CriteriosExtraidos> {
  if (input.colunas.length === 0 || input.mensagem.trim() === '') {
    return criteriosVazios();
  }
  const call = deps.runModelCall ?? runModelCall;
  try {
    const { result } = await call(
      db,
      llmCfg,
      {
        tenantId: input.tenantId,
        leadId: input.leadId,
        jobId: input.jobId,
        purpose: 'catalog_criteria',
        model: input.model,
        // Sem isto o modelo do agente viaja para o provider DEFAULT da org
        // (openai) e a chamada falha com "modelo inexistente".
        ...(input.provider ? { llmOverride: { provider: input.provider } } : {}),
        messages: [
          {
            role: 'user',
            content: buildCriteriosPrompt(
              input.mensagem,
              input.colunas,
              input.valores,
              input.estoque,
            ),
          },
        ],
      },
      { log: deps.log },
    );
    return parseCriterios(result.text, input.colunas);
  } catch (err) {
    deps.log.warn('extrair-criterios: falha — turno segue sem critérios', {
      error: err instanceof Error ? err.message : String(err),
    });
    return criteriosVazios();
  }
}
