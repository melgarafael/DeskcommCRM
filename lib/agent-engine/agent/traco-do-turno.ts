/**
 * ═══ O TRAÇO DO TURNO — uma linha por execução do agente, chave `job_id` ═══
 *
 * Issue #2869: hoje o turno real é auditável em pedaços que moram longe um do
 * outro — `llm_calls` guarda cada chamada de modelo, `skill_activations` guarda
 * quais skills entraram, `event_log` guarda a cadeia de eventos — mas *nenhuma
 * linha responde "o que aconteceu NESTE turno"*: quem entrou no prompt, quais
 * fontes de conhecimento foram lidas, quais ferramentas o modelo chamou (e qual
 * falhou) e como o turno terminou. Sem isso, um turno que respondeu errado só se
 * explica lendo o código.
 *
 * Este módulo entrega a fatia mínima e honesta disso:
 *
 *   * o que JÁ existe é AGREGADO na hora de gravar (tokens/custo/latência de
 *     `llm_calls` do job, skills de `skill_activations` do job) — não se copia
 *     nem se duplica escrita;
 *   * o que NÃO existia é COLETADO no turno: cada chamada de ferramenta, com
 *     nome, estado, erro e duração;
 *   * o que a organização tem ligado (fontes de conhecimento, com versão e
 *     hash) é fotografado junto.
 *
 * O que esta fatia AINDA NÃO grava — para não prometer o que não tem: o
 * snapshot/hash da composição do prompt, os trechos de KB efetivamente
 * recuperados, a comparação entre a resposta crua do modelo e o texto final e a
 * lista de decisões que a PRÉVIA pula. São as fatias seguintes; `is_dry_run`
 * já distingue as duas execuções desde já.
 *
 * Duas regras de ouro deste arquivo:
 *
 *   1. **O traço NUNCA derruba o turno.** Gravar é melhor-esforço: qualquer
 *      erro (permissão, coluna, banco fora) vira um `warn` e o turno segue. Um
 *      mecanismo de observabilidade que apaga o atendimento quando falha é pior
 *      do que não existir.
 *   2. **O traço NUNCA muda o resultado.** O envoltório de ferramentas registra
 *      e devolve o MESMO valor (e relança o mesmo erro) que a ferramenta
 *      devolveu — ele observa, não decide.
 */

import type pg from "pg";
import type { ToolSet } from "../edge/llm/run-model-call";
import type { Logger } from "../obs/logger";
import type { TurnAgentResolution } from "./resolve-turn-agent";

/** Como a chamada de uma ferramenta terminou, do ponto de vista de quem lê o traço. */
export type EstadoDaFerramenta = "ok" | "falhou" | "bloqueada";

export interface FerramentaNoTraco {
  nome: string;
  estado: EstadoDaFerramenta;
  /** Mensagem do erro, truncada. `null` quando a chamada deu certo. */
  erro: string | null;
  duracao_ms: number;
}

/**
 * Teto de chamadas registradas por turno. Um turno que entra em laço chama
 * dezenas de ferramentas; o traço é para LEITURA HUMANA e para o teste de
 * regressão, não para reconstituir o histórico inteiro — a partir daqui o
 * `ferramentas_truncadas` avisa que a lista foi cortada, em vez de mentir.
 */
export const LIMITE_DE_FERRAMENTAS = 50;

/** Teto da mensagem de erro guardada. Stack trace inteiro não cabe e não ajuda. */
export const LIMITE_DO_ERRO = 300;

/** O que se sabe do turno no momento de fechar a linha. */
export type StatusDoTurno = "completed" | "failed" | "aborted";

/**
 * O que o próprio turno SABE e o envoltório não: preenchido durante a execução
 * e lido na hora de gravar. Campo ausente significa "o turno não chegou lá" —
 * a linha guarda `null`, e não um zero que passaria por medição.
 */
export interface DesfechoDoTurno {
  messagesSent?: number;
  provider?: string | null;
  model?: string | null;
  abortReason?: string | null;
  /** O agente que o turno RESOLVEU (follow-up e caso não o recebem do chamador). */
  config?: TurnAgentResolution["config"] | null;
}

export interface EntradaDoTraco {
  organizationId: string;
  /** `job_id` do turno real; `null` só na prévia (que não tem job). */
  jobId: string | null;
  /** `run_id` da prévia — chave do traço quando não há job. */
  previewRunId: string | null;
  conversationId: string | null;
  contactId: string | null;
  agentId: string | null;
  agentVersionId: string | null;
  isDryRun: boolean;
  status: StatusDoTurno;
  abortReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  provider: string | null;
  model: string | null;
  messagesSent: number;
  /** Quantas mensagens de histórico o turno carregou (a janela real, não a pedida). */
  historicoMensagens: number | null;
  /** Ids das fontes de conhecimento ligadas ao agente neste turno. */
  knowledgeSourceIds: readonly string[];
  ferramentas: readonly FerramentaNoTraco[];
  /** O coletor descartou chamadas pelo teto (ele já entrega a lista cortada). */
  ferramentasTruncadas?: boolean;
}

/** A linha, já normalizada — o que vai para o banco. */
export interface TracoDoTurno {
  organization_id: string;
  job_id: string | null;
  preview_run_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  agent_id: string | null;
  agent_version_id: string | null;
  is_dry_run: boolean;
  status: StatusDoTurno;
  abort_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  provider: string | null;
  model: string | null;
  messages_sent: number;
  historico_mensagens: number | null;
  knowledge_source_ids: string[];
  ferramentas: FerramentaNoTraco[];
  ferramentas_truncadas: boolean;
}

/**
 * Coletor por turno. O estado vive no closure — como o breaker, ele nasce e
 * morre com o turno, e por isso não há como um turno ler a ferramenta do outro.
 */
export interface ColetorDeFerramentas {
  registrar(chamada: FerramentaNoTraco): void;
  listar(): FerramentaNoTraco[];
  /** `true` quando alguma chamada foi descartada pelo teto — o traço não mente. */
  truncado(): boolean;
}

export interface OpcoesDoColetor {
  /** Teto de chamadas guardadas (default `LIMITE_DE_FERRAMENTAS`). */
  limite?: number;
  /** Teto do texto de erro (default `LIMITE_DO_ERRO`). */
  limiteDoErro?: number;
}

export function criarColetorDeFerramentas(opcoes: OpcoesDoColetor = {}): ColetorDeFerramentas {
  const limite = opcoes.limite ?? LIMITE_DE_FERRAMENTAS;
  const limiteDoErro = opcoes.limiteDoErro ?? LIMITE_DO_ERRO;
  const chamadas: FerramentaNoTraco[] = [];
  let truncou = false;

  return {
    registrar(chamada: FerramentaNoTraco): void {
      if (chamadas.length >= limite) {
        // O corte é AVISADO, não silencioso: quem lê o traço precisa saber que
        // a lista está incompleta em vez de concluir que o turno parou ali.
        truncou = true;
        return;
      }
      chamadas.push({
        nome: chamada.nome,
        estado: chamada.estado,
        erro: chamada.erro === null ? null : chamada.erro.slice(0, limiteDoErro),
        duracao_ms: Math.max(0, Math.round(chamada.duracao_ms)),
      });
    },
    listar(): FerramentaNoTraco[] {
      return chamadas.slice();
    },
    truncado(): boolean {
      return truncou;
    },
  };
}

/** Convenção do repo: toda tool do run devolve `{ ok: boolean, ... }`. */
function ehResultadoDeFalha(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

/**
 * Bloqueio do circuit breaker é uma FALHA para quem lê o traço, mas de outra
 * natureza: não foi a ferramenta que quebrou, foi o próprio turno que a
 * interrompeu. Distinguir os dois é o que permite ler "a ferramenta não foi
 * chamada" da issue #2869 sem confundir com "a ferramenta falhou".
 */
function ehBloqueioDoBreaker(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const erro = (result as { error?: { code?: unknown } }).error;
  const codigo = erro?.code;
  return typeof codigo === "string" && codigo.startsWith("circuit_breaker");
}

function mensagemDoResultado(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const erro = (result as { error?: unknown }).error;
  if (typeof erro === "string") return erro;
  if (typeof erro === "object" && erro !== null) {
    const msg = (erro as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
    const codigo = (erro as { code?: unknown }).code;
    if (typeof codigo === "string") return codigo;
  }
  return null;
}

type AnyExecute = (input: unknown, options: unknown) => unknown;
interface FerramentaEnvolvivel {
  execute?: AnyExecute;
}

/**
 * Envolve as ferramentas do run para REGISTRAR cada chamada no coletor do turno.
 *
 * Fica por FORA do breaker de propósito (`envolverFerramentasComTraco(
 * wrapToolsWithBreaker(...))`): assim o traço enxerga inclusive a chamada que o
 * breaker bloqueou — que é justamente a que mais falta faz numa investigação.
 *
 * Sem coletor, devolve o MESMO objeto: quem chama sem traço não paga nada.
 */
export function envolverFerramentasComTraco(
  tools: ToolSet,
  coletor: ColetorDeFerramentas | undefined,
  agora: () => number = () => Date.now(),
): ToolSet {
  if (coletor === undefined) return tools;

  const envolver = (nome: string, execute: AnyExecute): AnyExecute => {
    return async (input: unknown, options: unknown): Promise<unknown> => {
      const inicio = agora();
      try {
        const resultado = await execute(input, options);
        const estado: EstadoDaFerramenta = ehBloqueioDoBreaker(resultado)
          ? "bloqueada"
          : ehResultadoDeFalha(resultado)
            ? "falhou"
            : "ok";
        coletor.registrar({
          nome,
          estado,
          erro: estado === "ok" ? null : mensagemDoResultado(resultado),
          duracao_ms: agora() - inicio,
        });
        return resultado;
      } catch (erro) {
        coletor.registrar({
          nome,
          estado: "falhou",
          erro: erro instanceof Error ? erro.message : String(erro),
          duracao_ms: agora() - inicio,
        });
        // Relança o MESMO erro: observar não pode engolir a falha do turno.
        throw erro;
      }
    };
  };

  const envolvidas: ToolSet = {};
  for (const [nome, def] of Object.entries(tools)) {
    const ferramenta = def as FerramentaEnvolvivel;
    if (ferramenta.execute === undefined) {
      envolvidas[nome] = def;
      continue;
    }
    envolvidas[nome] = {
      ...def,
      execute: envolver(nome, ferramenta.execute.bind(def) as AnyExecute),
    } as typeof def;
  }
  return envolvidas;
}

/** Coluna uuid com `''` vira `NULL`: a prévia monta ids vazios para "cenário". */
function uuidOuNulo(valor: string | null): string | null {
  return valor === null || valor.trim() === "" ? null : valor;
}

/** Normaliza a entrada na linha do banco — sem I/O, sem relógio, sem closure. */
export function montarTracoDoTurno(entrada: EntradaDoTraco): TracoDoTurno {
  const limiteDoErro = LIMITE_DO_ERRO;
  return {
    organization_id: entrada.organizationId,
    job_id: entrada.jobId,
    preview_run_id: uuidOuNulo(entrada.previewRunId),
    conversation_id: uuidOuNulo(entrada.conversationId),
    contact_id: uuidOuNulo(entrada.contactId),
    agent_id: uuidOuNulo(entrada.agentId),
    agent_version_id: uuidOuNulo(entrada.agentVersionId),
    is_dry_run: entrada.isDryRun,
    status: entrada.status,
    abort_reason: entrada.abortReason,
    error_code: entrada.errorCode,
    error_message:
      entrada.errorMessage === null ? null : entrada.errorMessage.slice(0, limiteDoErro),
    provider: entrada.provider,
    model: entrada.model,
    messages_sent: Math.max(0, entrada.messagesSent),
    historico_mensagens: entrada.historicoMensagens,
    knowledge_source_ids: [...entrada.knowledgeSourceIds],
    ferramentas: entrada.ferramentas.slice(0, LIMITE_DE_FERRAMENTAS).map((f) => ({
      nome: f.nome,
      estado: f.estado,
      erro: f.erro === null ? null : f.erro.slice(0, limiteDoErro),
      duracao_ms: Math.max(0, Math.round(f.duracao_ms)),
    })),
    ferramentas_truncadas:
      entrada.ferramentasTruncadas === true || entrada.ferramentas.length > LIMITE_DE_FERRAMENTAS,
  };
}

/**
 * Grava a linha do turno. Melhor-esforço por contrato: NUNCA lança.
 *
 * Uma única instrução: os agregados saem de `llm_calls` e `skill_activations`
 * do próprio `job_id` (leitura indexada — 0585 e o índice desta migration) e a
 * organização já tem ligadas as fontes de conhecimento por `id`. Assim o turno
 * não paga três idas ao banco para descobrir o que o banco já sabe.
 *
 * Prévia (`job_id` nulo) usa `preview_run_id` como chave: o `on conflict` só
 * vale para o turno real, e a prévia é gravada uma vez por execução.
 */
export async function registrarTracoDoTurno(
  pool: pg.Pool,
  traco: TracoDoTurno,
  log?: Logger,
): Promise<void> {
  try {
    await pool.query(
      `with chamadas as (
         select coalesce(sum(input_tokens), 0)::int as tokens_in,
                coalesce(sum(output_tokens), 0)::int as tokens_out,
                coalesce(sum(cost_cents), 0)::numeric as cost_cents,
                coalesce(max(latency_ms), 0)::int as latency_ms,
                max(model) as model,
                max(provider) as provider
           from public.llm_calls
          where organization_id = $1 and job_id = $2
       ), skills as (
         select coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'nome', skill_name,
                      'versao_id', skill_version_id,
                      'gatilho', trigger
                    ) order by skill_name, created_at
                  ),
                  '[]'::jsonb
                ) as lista
           from public.skill_activations
          where organization_id = $1 and job_id = $2
       ), fontes as (
         select coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'id', id,
                      'versao', active_kb_version_id,
                      'hash', content_hash,
                      'ligada', is_active
                    ) order by id
                  ),
                  '[]'::jsonb
                ) as lista
           from public.ai_knowledge_sources
          where organization_id = $1 and id = any($3::uuid[])
       )
       insert into public.agent_turn_traces (
         organization_id, job_id, preview_run_id, conversation_id, contact_id,
         agent_id, agent_version_id, is_dry_run, status, abort_reason,
         error_code, error_message, provider, model, messages_sent,
         historico_mensagens, tokens_in, tokens_out, cost_cents, latency_ms,
         skills, ferramentas, kb_sources, ferramentas_truncadas
       )
       select $1, $2, $4, $5, $6,
              $7, $8, $9, $10, $11,
              $12, $13, coalesce($14, chamadas.provider), coalesce($15, chamadas.model), $16,
              $17, chamadas.tokens_in, chamadas.tokens_out, chamadas.cost_cents, chamadas.latency_ms,
              skills.lista, $18::jsonb, fontes.lista, $19
         from chamadas, skills, fontes
       on conflict (job_id) where job_id is not null do update set
         agent_id = excluded.agent_id,
         agent_version_id = excluded.agent_version_id,
         provider = excluded.provider,
         model = excluded.model,
         status = excluded.status,
         abort_reason = excluded.abort_reason,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         messages_sent = excluded.messages_sent,
         historico_mensagens = excluded.historico_mensagens,
         tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out,
         cost_cents = excluded.cost_cents,
         latency_ms = excluded.latency_ms,
         skills = excluded.skills,
         ferramentas = excluded.ferramentas,
         kb_sources = excluded.kb_sources,
         ferramentas_truncadas = excluded.ferramentas_truncadas,
         updated_at = now()`,
      [
        traco.organization_id,
        traco.job_id,
        traco.knowledge_source_ids,
        traco.preview_run_id,
        traco.conversation_id,
        traco.contact_id,
        traco.agent_id,
        traco.agent_version_id,
        traco.is_dry_run,
        traco.status,
        traco.abort_reason,
        traco.error_code,
        traco.error_message,
        traco.provider,
        traco.model,
        traco.messages_sent,
        traco.historico_mensagens,
        JSON.stringify(traco.ferramentas),
        traco.ferramentas_truncadas,
      ],
    );
  } catch (erro) {
    // Observabilidade que derruba o atendimento é pior do que não ter
    // observabilidade: aqui se avisa e o turno segue.
    log?.warn("traço do turno não gravado (o turno segue)", {
      job_id: traco.job_id,
      preview_run_id: traco.preview_run_id,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
