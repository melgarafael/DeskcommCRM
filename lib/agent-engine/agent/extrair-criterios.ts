/**
 * Extração DIRIGIDA de critérios (mecanismo do motor, não tool-use da IA).
 *
 * ─── O problema ─────────────────────────────────────────────────────────────
 * Quando o cliente pede uma moto que NÃO temos (modelo, marca, cilindrada…), o
 * motor precisa saber "o que essa moto é" (segmento/categoria, marca, cc) para
 * oferecer as parecidas. O modelo lite NÃO faz o 2º passo de tool sozinho.
 *
 * ─── A solução ──────────────────────────────────────────────────────────────
 * O motor faz UMA pergunta FECHADA à IA — "preencha estas colunas para a moto
 * pedida" — e SALVA a resposta como critérios do turno. Depois consulta/ordena
 * com eles. Vale para QUALQUER coluna de critério (marca, categoria, cilindrada,
 * cor, ano…), não só marca.
 *
 * É o padrão do `intent-classifier`: o classificador SUGERE, o motor decide; a
 * saída do modelo é não-confiável e o parse NUNCA lança.
 */
import type pg from 'pg';

import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { Logger } from '../obs/logger';

const JSON_INSTRUCTION =
  'Responda SOMENTE o JSON, no MESMO formato do exemplo, sem texto antes ou depois.';

/** Resultado da pergunta dirigida: a INTENÇÃO + os critérios por coluna. */
export interface CriteriosExtraidos {
  /** 'pedido' = cliente pede uma moto; 'alternativa' = quer algo DIFERENTE da moto atual. */
  intencao: 'pedido' | 'alternativa' | null;
  criterios: Record<string, string>;
}

/**
 * Monta a pergunta fechada: colunas + valores possíveis + um EXEMPLO PREENCHIDO.
 * O exemplo é essencial: sem ele o modelo lite devolvia `{}` (medido).
 */
export function buildCriteriosPrompt(
  mensagem: string,
  colunas: readonly string[],
  valores?: Record<string, readonly string[]>,
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
    criterios: Object.fromEntries(
      colunas.slice(0, 3).map((c) => [c, valores?.[c]?.[0] ?? `<valor de ${c}>`]),
    ),
  });
  return [
    'Você é um classificador auxiliar (NÃO responde ao cliente).',
    'A partir da mensagem do cliente, classifique a INTENÇÃO e descubra o que a moto É.',
    'Intenções possíveis:',
    '- "pedido": o cliente pede/quer uma moto (por nome, marca, cilindrada, estilo…).',
    '- "alternativa": o cliente está falando de uma moto e quer algo DIFERENTE dela (ex.: achou caro, quer outra cor/ano/marca, quer mais barata).',
    'Para uma PREFERÊNCIA de ordem numa coluna (mais barata, mais nova, menos km), use o valor "menor" ou "maior" (ex.: {"preco":"menor"} = mais barata que a atual; {"ano":"maior"} = mais nova).',
    'Colunas de critério:',
    lista,
    '',
    `EXEMPLO de resposta (formato exato, preenchido): ${exemplo}`,
    '',
    'Mensagem do cliente:',
    mensagem,
    '',
    'Agora responda com o JSON preenchido (mesmo formato do exemplo), com a "intencao" e os "criterios".',
    'NUNCA devolva vazio: preencha cada coluna que conseguir deduzir (marca, categoria, cilindrada…).',
    JSON_INSTRUCTION,
  ].join('\n');
}

/**
 * Parse tolerante (nunca lança). Aceita só colunas permitidas e valores
 * string/número; ignora o resto. Saída inesperada vira `{}`.
 */
export function parseCriterios(
  text: string,
  colunasPermitidas: readonly string[],
): CriteriosExtraidos {
  const vazio: CriteriosExtraidos = { intencao: null, criterios: {} };
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
  // Aceita `{criterios:{...}}` OU o objeto plano `{categoria:"...", ...}` — o
  // modelo lite às vezes esquece o envelope.
  const bruto =
    typeof obj.criterios === 'object' && obj.criterios !== null
      ? (obj.criterios as Record<string, unknown>)
      : obj;
  const criterios: Record<string, string> = {};
  for (const [coluna, valor] of Object.entries(bruto)) {
    if (coluna === 'intencao') continue;
    if (!colunasPermitidas.includes(coluna)) continue;
    if (typeof valor === 'string' && valor.trim() !== '') criterios[coluna] = valor.trim();
    else if (typeof valor === 'number' && Number.isFinite(valor)) criterios[coluna] = String(valor);
  }
  return { intencao, criterios };
}

export interface ExtrairCriteriosDeps {
  log: Logger;
  runModelCall?: typeof runModelCall;
}

/**
 * Pergunta à IA quais são os critérios da moto pedida e devolve o mapa
 * `coluna → valor`. Nunca lança: falha do modelo devolve `{}` (o turno segue
 * com o que o motor conseguiu inferir sozinho).
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
  },
  deps: ExtrairCriteriosDeps,
): Promise<CriteriosExtraidos> {
  if (input.colunas.length === 0 || input.mensagem.trim() === '') {
    return { intencao: null, criterios: {} };
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
            content: buildCriteriosPrompt(input.mensagem, input.colunas, input.valores),
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
    return { intencao: null, criterios: {} };
  }
}
