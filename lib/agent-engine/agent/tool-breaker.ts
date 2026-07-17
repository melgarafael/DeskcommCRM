/**
 * Circuit breaker de tools do agente (F2-15) — port em TS do padrão
 * `tool_guardrails.py` do Hermes (blueprint D2 item 2.1): defesa determinística
 * contra o failure mode nº 1 de agentes unattended, o loop de repetição.
 *
 * Assinatura de chamada = (tool, sha256(args canônicos — JSON com chaves
 * ordenadas)). Três modos, todos com thresholds em knob (env TOOL_BREAKER_*):
 *   - exact_failure: MESMA tool + MESMOS args falhando → warn (aviso anexado ao
 *     resultado) → block (a chamada NÃO executa; resultado sintético de erro);
 *   - same_tool_failure: MESMA tool falhando com args DIFERENTES → warn → halt
 *     (todas as chamadas seguintes DESSA tool no run são bloqueadas);
 *   - idempotent_no_progress: tool READ-ONLY devolvendo o MESMO hash de resultado
 *     repetidamente → warn → block. Tools MUTANTES ficam FORA deste modo por
 *     registro EXPLÍCITO (`readOnlyTools`), nunca por heurística.
 *
 * Escopo do estado: POR RUN — o wrapper é criado dentro do closure do handler
 * (sessão fresca por job); entre runs a fila/attempts já protege. Nada persiste.
 * "Falha" segue a convenção do repo: resultado de tool com `ok === false` (as
 * tools do run nunca lançam — erro vira mensagem de ensino). PII: args/resultados
 * NUNCA vão a log — só o hash e contadores.
 */
import { createHash } from 'node:crypto';

import type { Logger } from '../obs/logger';
import type { ToolSet } from '../edge/llm/run-model-call';

/** Thresholds dos 3 modos — knobs (env TOOL_BREAKER_*), nunca constantes. */
export interface ToolBreakerThresholds {
  /** exact_failure: falhas com MESMOS args ≥ warn anexam aviso ao resultado. */
  exactFailureWarn: number;
  /** exact_failure: falhas com MESMOS args ≥ block → chamada não executa. */
  exactFailureBlock: number;
  /** same_tool_failure: falhas da MESMA tool (args variados) ≥ warn → aviso. */
  sameToolFailureWarn: number;
  /** same_tool_failure: falhas ≥ halt → tool desativada pelo resto do run. */
  sameToolFailureHalt: number;
  /** no_progress: resultado idêntico repetido ≥ warn (tool read-only) → aviso. */
  noProgressWarn: number;
  /** no_progress: resultado idêntico repetido ≥ block → próxima chamada não executa. */
  noProgressBlock: number;
}

export interface ToolBreakerOptions {
  thresholds: ToolBreakerThresholds;
  /**
   * Registro EXPLÍCITO das tools sem efeito colateral (modo no_progress).
   * Tool fora desta lista é tratada como MUTANTE e nunca entra no modo.
   */
  readOnlyTools: readonly string[];
  log: Logger;
  /** campos estruturados dos warns (tenant/lead/job) — args crus jamais. */
  logFields?: Record<string, unknown>;
}

/** Resultado sintético de bloqueio — mesma convenção de ensino das tools do run. */
export interface BreakerBlockedResult {
  ok: false;
  error: {
    code: 'circuit_breaker_exact_failure' | 'circuit_breaker_same_tool' | 'circuit_breaker_no_progress';
    message: string;
  };
}

/** JSON canônico: chaves de objeto ordenadas recursivamente (arrays mantêm ordem). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex do JSON canônico — ordenação de chaves diferente ⇒ MESMO hash. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)) ?? 'undefined').digest('hex');
}

/** Convenção do repo: toda tool do run devolve `{ ok: boolean, ... }`. */
function isFailureResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
}

type AnyExecute = (input: unknown, options: unknown) => unknown;
interface WrappableTool {
  execute?: AnyExecute;
}

/**
 * Envolve as tools do run com o breaker. Estado 100% no closure desta chamada —
 * criar o wrapper por run é o que zera o breaker entre runs (por construção).
 */
export function wrapToolsWithBreaker(tools: ToolSet, opts: ToolBreakerOptions): ToolSet {
  const { thresholds: t, log } = opts;
  const readOnly = new Set(opts.readOnlyTools);

  // Estado por run.
  const exactFailures = new Map<string, number>(); // `${tool}:${argsHash}` → falhas
  const toolFailures = new Map<string, number>(); // tool → falhas (args variados)
  const halted = new Set<string>(); // tools desativadas (same_tool_failure)
  const progress = new Map<string, { lastResultHash: string; repeats: number }>(); // read-only

  const logWarn = (msg: string, fields: Record<string, unknown>): void => {
    log.warn(msg, { ...opts.logFields, ...fields });
  };

  const blocked = (
    code: BreakerBlockedResult['error']['code'],
    message: string,
  ): BreakerBlockedResult => ({ ok: false, error: { code, message } });

  const wrapExecute = (toolName: string, execute: AnyExecute): AnyExecute => {
    return async (input: unknown, options: unknown): Promise<unknown> => {
      const argsHash = canonicalHash(input);
      const exactKey = `${toolName}:${argsHash}`;

      // ---- pré-execução: bloqueios ------------------------------------------
      if (halted.has(toolName)) {
        const n = toolFailures.get(toolName) ?? 0;
        logWarn('breaker: chamada bloqueada (same_tool_failure halt)', {
          tool: toolName,
          mode: 'same_tool_failure',
          failures: n,
          args_hash: argsHash,
        });
        return blocked(
          'circuit_breaker_same_tool',
          `a tool ${toolName} foi DESATIVADA pelo circuit breaker neste turno: acumulou ${n} falhas com argumentos variados. ` +
            'Não a chame de novo neste turno — siga com o que você já tem ou encerre o turno explicando o impasse.',
        );
      }
      const exactCount = exactFailures.get(exactKey) ?? 0;
      if (exactCount >= t.exactFailureBlock) {
        logWarn('breaker: chamada bloqueada (exact_failure)', {
          tool: toolName,
          mode: 'exact_failure',
          failures: exactCount,
          args_hash: argsHash,
        });
        return blocked(
          'circuit_breaker_exact_failure',
          `chamada BLOQUEADA pelo circuit breaker: ${toolName} já falhou ${exactCount}x com exatamente estes mesmos argumentos neste turno — repetir não vai funcionar. ` +
            'Mude a abordagem (argumentos diferentes ou outra tool) ou encerre o turno explicando o impasse.',
        );
      }
      const prog = readOnly.has(toolName) ? progress.get(exactKey) : undefined;
      if (prog !== undefined && prog.repeats >= t.noProgressBlock) {
        logWarn('breaker: chamada bloqueada (idempotent_no_progress)', {
          tool: toolName,
          mode: 'idempotent_no_progress',
          repeats: prog.repeats,
          args_hash: argsHash,
        });
        return blocked(
          'circuit_breaker_no_progress',
          `chamada BLOQUEADA pelo circuit breaker: ${toolName} já devolveu o MESMO resultado ${prog.repeats}x seguidas — reler não traz informação nova. ` +
            'Use a informação que você já tem ou encerre o turno.',
        );
      }

      // ---- execução real -----------------------------------------------------
      const result = await execute(input, options);
      const warnings: string[] = [];

      if (isFailureResult(result)) {
        const exact = exactCount + 1;
        exactFailures.set(exactKey, exact);
        const perTool = (toolFailures.get(toolName) ?? 0) + 1;
        toolFailures.set(toolName, perTool);

        if (perTool >= t.sameToolFailureHalt) {
          halted.add(toolName);
          logWarn('breaker: tool desativada pelo resto do run (same_tool_failure halt)', {
            tool: toolName,
            mode: 'same_tool_failure',
            failures: perTool,
          });
        }
        if (exact >= t.exactFailureWarn) {
          warnings.push(
            `${toolName} já falhou ${exact}x com estes mesmos argumentos neste turno; ` +
              `a partir de ${t.exactFailureBlock} falhas iguais a chamada será bloqueada — mude a abordagem.`,
          );
          logWarn('breaker: warn (exact_failure)', {
            tool: toolName,
            mode: 'exact_failure',
            failures: exact,
            args_hash: argsHash,
          });
        }
        if (perTool >= t.sameToolFailureWarn && !halted.has(toolName)) {
          warnings.push(
            `${toolName} acumulou ${perTool} falhas neste turno; com ${t.sameToolFailureHalt} falhas a tool será desativada.`,
          );
          logWarn('breaker: warn (same_tool_failure)', {
            tool: toolName,
            mode: 'same_tool_failure',
            failures: perTool,
          });
        }
      } else if (readOnly.has(toolName)) {
        const resultHash = canonicalHash(result);
        const prev = progress.get(exactKey);
        const repeats = prev !== undefined && prev.lastResultHash === resultHash ? prev.repeats + 1 : 1;
        progress.set(exactKey, { lastResultHash: resultHash, repeats });
        if (repeats >= t.noProgressWarn) {
          warnings.push(
            `${toolName} devolveu o mesmo resultado ${repeats}x seguidas — você não está progredindo; não repita esta leitura sem necessidade.`,
          );
          logWarn('breaker: warn (idempotent_no_progress)', {
            tool: toolName,
            mode: 'idempotent_no_progress',
            repeats,
            args_hash: argsHash,
          });
        }
      }

      // ponytail: aviso só anexa em resultado-objeto (toda tool do run devolve
      // objeto); outro shape passa intocado — anexar mudaria o tipo do resultado.
      if (warnings.length > 0 && typeof result === 'object' && result !== null && !Array.isArray(result)) {
        return { ...(result as Record<string, unknown>), breaker_warning: warnings.join(' ') };
      }
      return result;
    };
  };

  const wrapped: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    const tool = def as WrappableTool;
    if (tool.execute === undefined) {
      wrapped[name] = def;
      continue;
    }
    wrapped[name] = { ...def, execute: wrapExecute(name, tool.execute.bind(def) as AnyExecute) } as typeof def;
  }
  return wrapped;
}
