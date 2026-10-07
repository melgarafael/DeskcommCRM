/**
 * Classificador + planejador de tempo do sistema de fluxos de follow-up (onda 5,
 * Task 5.1) — os dois `purpose` de `followup_turn` dirigido por fluxo que NÃO
 * rodam o agente inteiro (`classify`/`plan_timing`): uma ÚNICA chamada de
 * modelo pelo seam agnóstico (runModelCall), mesmo padrão de
 * stage-classifier.ts/guardrails/promise/semantic.ts.
 *
 * Quem decide o que fazer com o resultado é a PONTE
 * (lib/followup/turn-bridge.ts, via callback injetado em followup-turn.ts) —
 * este módulo só classifica/propõe, nunca escreve no enrollment.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LeadContext } from '../edge/crm/get-lead-context';
import { extrairObjetoJsonDoTexto } from '@/lib/agent-engine/texto/extrair-json-do-texto';
import { fusoDaOrganizacao } from './fuso-da-org';
import { renderAgora } from '@/lib/tempo/agora';

const CLASSIFY_INSTRUCTION =
  'Você é um classificador auxiliar de follow-up (NÃO responde ao lead). Classifique a ' +
  'ÚLTIMA mensagem do lead abaixo em UMA das classes listadas. Responda SOMENTE com JSON, ' +
  'sem explicação: {"class": "<uma das classes, exatamente como listada>"}.';

function buildClassifyMessage(candidate: string, classes: string[], hint?: string): string {
  return [
    CLASSIFY_INSTRUCTION,
    '',
    '## Classes possíveis',
    classes.map((c) => `- ${c}`).join('\n'),
    ...(hint ? ['', '## Dica adicional do fluxo', hint] : []),
    '',
    '## Mensagem do lead a classificar',
    candidate,
  ].join('\n');
}

/**
 * Extrai `class` do JSON do modelo (tolerante a prosa/cerca em volta). Só aceita
 * uma classe que esteja literalmente em `classes` — saída fora da lista (ou sem
 * JSON parseável) vira `null`, nunca um palpite.
 */
export function parseFollowupClassification(text: string, classes: string[]): string | null {
  const bruto = extrairObjetoJsonDoTexto(text);
  if (bruto === null || typeof bruto !== 'object') return null;
  const obj = bruto as Record<string, unknown>;
  const value = typeof obj.class === 'string' ? obj.class : null;
  return value !== null && classes.includes(value) ? value : null;
}

/**
 * Classifica a última resposta do lead em uma de `classes`. `candidateText` é a
 * resposta do lead ao envio do fluxo, já resolvida pelo chamador
 * (`respostaAoEnvioDoFluxo` em followup-turn.ts) — e só existe chamada quando
 * ela existe. Sem resposta não é classe: `no_reply` é
 * decisão do motor quando a carência do nó vence (node-handlers.ts), nunca
 * deste turno, que rodaria segundos depois do envio. Saída não-parseável/fora
 * de `classes` → erro (o job re-tenta pela fila; nunca adivinha uma classe
 * errada — doutrina "sem preguiça").
 */
export async function classifyFollowupReply(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  args: { candidateText: string; classes: string[]; hint?: string; model?: string },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<string> {
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      jobId: ids.jobId,
      purpose: 'followup_classify',
      ...(args.model !== undefined ? { model: args.model } : {}),
      messages: [{ role: 'user', content: buildClassifyMessage(args.candidateText, args.classes, args.hint) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  const cls = parseFollowupClassification(call.result.text, args.classes);
  if (cls === null) {
    throw new Error(
      'classificador de follow-up: saída do modelo sem classe reconhecível dentre as configuradas — turno re-tentado pela fila',
    );
  }
  return cls;
}

const PLAN_INSTRUCTION =
  'Você é um planejador auxiliar de follow-up (NÃO responde ao lead). Abaixo estão as ESPERAS ' +
  'adaptativas de um fluxo de follow-up, na ordem em que vão acontecer. Escolha quanto tempo ' +
  'esperar em CADA uma, pensando na sequência inteira — o ritmo entre as esperas importa tanto ' +
  'quanto cada uma isolada. Respeite o intervalo (mínimo/máximo) de cada espera. ' +
  'Responda SOMENTE com JSON, sem explicação: ' +
  '{"esperas": [{"node_id": "<id da espera>", "aguardar_ms": <inteiro em milissegundos>, ' +
  '"motivo": "<frase curta em pt-br explicando a escolha para um humano ler>"}]}.';

/** Espera adaptativa como o planejador a enxerga (espelha `EsperaAdaptativa` de
 *  lib/followup/timing-plan.ts — agent-engine não importa followup/*). */
export interface EsperaParaPlanejar {
  node_id: string;
  label: string;
  min_ms: number;
  max_ms: number;
  guidance?: string;
}

/** Proposta crua para UMA espera, antes do clamp — quem grampeia é a ponte. */
export interface PropostaDeEsperaBruta {
  node_id: string;
  aguardar_ms: number;
  motivo: string;
}

function buildPlanMessage(
  context: LeadContext,
  now: Date,
  esperas: EsperaParaPlanejar[],
  fuso: string,
): string {
  return [
    PLAN_INSTRUCTION,
    '',
    // Este bloco era `'## Agora'` seguido de `now.toISOString()` cru — o único
    // relógio que o motor tinha, e meio relógio: sem dia da semana e sem fuso,
    // ele não responde a pergunta que ESTE planejador faz, que é quando é
    // aceitável falar com alguém. Passou a ser o mesmo `renderAgora` do turno,
    // porque dois formatos de "## Agora" no mesmo motor viram dois vocabulários.
    renderAgora(now, fuso),
    '',
    '## Esperas do fluxo, na ordem',
    ...esperas.map((e, i) =>
      [
        `${i + 1}. node_id: ${e.node_id} — "${e.label}"`,
        `   intervalo permitido: de ${e.min_ms}ms a ${e.max_ms}ms`,
        ...(e.guidance ? [`   orientação do fluxo: ${e.guidance}`] : []),
      ].join('\n'),
    ),
    '',
    '## Contexto do lead (contato + últimas mensagens)',
    JSON.stringify(context),
  ].join('\n');
}

/**
 * Extrai as propostas do JSON do modelo (tolerante a prosa/cerca em volta). Só
 * aceita `node_id` que esteja de fato no fluxo e `aguardar_ms` numérico finito —
 * espera com número ilegível fica FORA do plano (o nó cai no máximo, que é o
 * comportamento anterior) em vez de receber um valor inventado.
 *
 * `motivo` ausente NÃO descarta a espera: ele é texto de exibição, e perder o
 * instante escolhido por falta de uma frase seria trocar o essencial pelo
 * acessório. Fica registrado que o modelo não explicou.
 */
export function parsePlanoDeEsperas(text: string, nodeIdsDoFluxo: string[]): PropostaDeEsperaBruta[] {
  const bruto = extrairObjetoJsonDoTexto(text);
  if (bruto === null || typeof bruto !== 'object') return [];
  const obj = bruto as Record<string, unknown>;
  if (!Array.isArray(obj.esperas)) return [];

  const conhecidos = new Set(nodeIdsDoFluxo);
  const vistos = new Set<string>();
  const propostas: PropostaDeEsperaBruta[] = [];
  for (const item of obj.esperas) {
    if (typeof item !== 'object' || item === null) continue;
    const linha = item as Record<string, unknown>;
    const nodeId = typeof linha.node_id === 'string' ? linha.node_id : null;
    if (nodeId === null || !conhecidos.has(nodeId) || vistos.has(nodeId)) continue;
    const ms = typeof linha.aguardar_ms === 'number' ? linha.aguardar_ms : Number(linha.aguardar_ms);
    if (!Number.isFinite(ms)) continue;
    vistos.add(nodeId);
    propostas.push({
      node_id: nodeId,
      aguardar_ms: ms,
      motivo: typeof linha.motivo === 'string' && linha.motivo.trim() !== ''
        ? linha.motivo.trim()
        : 'o modelo não explicou a escolha',
    });
  }
  return propostas;
}

/**
 * Propõe o plano de tempo do fluxo INTEIRO — todas as esperas adaptativas de uma
 * vez, no acionamento do follow-up. Uma chamada de modelo por follow-up, não uma
 * por espera; e o planejador vê a sequência, então pode ritmar as esperas entre
 * si (o motivo de existir o plano, ver lib/followup/timing-plan.ts).
 *
 * A PONTE (lib/followup/turn-bridge.ts) é quem grampeia cada proposta no
 * intervalo do nó e escreve no enrollment — este módulo só propõe.
 *
 * O `purpose` do ponto de IA continua `followup_decide_timing`: é o MESMO ponto
 * do catálogo ("Escolher a hora do follow-up", lib/ai/pontos/registro.ts), e
 * cada organização já pode ter provedor/modelo escolhidos para ele em
 * `ai_purpose_bindings` — renomeá-lo apagaria essa configuração nos clones. O
 * que mudou foi o mecanismo (o fluxo todo de uma vez), não o ponto.
 */
export async function planFollowupTiming(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  args: { context: LeadContext; esperas: EsperaParaPlanejar[]; model?: string },
  deps: { registry?: ProviderRegistry; log: Logger; clock?: () => Date },
): Promise<{ propostas: PropostaDeEsperaBruta[]; modelo: string }> {
  const now = (deps.clock ?? ((): Date => new Date()))();
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      jobId: ids.jobId,
      purpose: 'followup_decide_timing',
      ...(args.model !== undefined ? { model: args.model } : {}),
      messages: [
        {
          role: 'user',
          content: buildPlanMessage(
            args.context,
            now,
            args.esperas,
            await fusoDaOrganizacao(db, ids.tenantId, deps.log),
          ),
        },
      ],
    },
    { registry: deps.registry, log: deps.log },
  );
  const propostas = parsePlanoDeEsperas(call.result.text, args.esperas.map((e) => e.node_id));
  if (propostas.length === 0) {
    throw new Error(
      'planejador de tempo do follow-up: saída do modelo sem nenhuma espera reconhecível — turno re-tentado pela fila',
    );
  }
  return { propostas, modelo: call.model };
}
