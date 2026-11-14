/**
 * Loader do Intent Router (Fase 3 do épico harness — spec 2026-07-23,
 * migration 0085). `ai_routers`/`ai_router_members` são tabelas EDITÁVEIS
 * (não versão+ponteiro como ai_agents): mutação vem auditada por trigger.
 *
 * Contrato:
 *   - resolvido no início de CADA turno (zero cache de processo);
 *   - no máximo 1 router ativo por channel_session (índice parcial da 0085);
 *   - sem router ativo para a sessão ⇒ null (fluxo atual, sem router, segue igual);
 *   - leitura DEFENSIVA do `config` jsonb: shape errado cai no default e
 *     nunca derruba o turno.
 */
import type pg from 'pg';
import { CLASSIFIER_CONTEXT_MESSAGES, MAX_CLASSIFIER_CONTEXT_MESSAGES } from '@/lib/ai/classifier-context';

import { lerPublicoDoGatilho, type PublicoDoAgente } from './publico-do-gatilho';

export interface RouterMember {
  agentId: string;
  intentName: string;
  intentDescription: string;
  examples: string[];
  /**
   * Nome do agente (`ai_agents.name`) — só para o rastro do público (#3722).
   * Ausente nos dublês que montam o membro à mão; o rastro cai no `agentId`.
   */
  agentName?: string;
  /**
   * O PÚBLICO que a versão publicada do agente declara no `trigger_config`
   * (#3722, fatia 2). `null`/ausente = atende todo mundo.
   *
   * Lido na MESMA consulta dos membros (o join com a versão publicada), e não
   * numa segunda: quem não declara público não paga consulta extra por turno.
   * Lista torta vira `null` pela régua de `publico-do-gatilho.ts` — a mesma de
   * todo o resto.
   */
  publico?: PublicoDoAgente | null;
  /**
   * Fluxo de atendimento que COMEÇA quando esta intenção casa (migration 0394; 0237 na branch do autor).
   * `null`/ausente = só roteia agente, como antes.
   */
  flowPointerId?: string | null;
  /**
   * Funil/etapa de DESTINO desta intenção (#2155): quando casa, o card sai do
   * funil de entrada e vai para o funil do produto (mesma transferência das
   * automações). `null`/ausente = só roteia o agente, como antes.
   */
  destinationPipelineId?: string | null;
  destinationStageId?: string | null;
}

export interface LoadedRouter {
  id: string;
  name: string;
  /**
   * `null` = "Automático": o seam decide (painel de provedores, senão o padrão
   * da organização). NUNCA um id fixo aqui — o seam trata o modelo do call site
   * como knob de ambiente, que vence o padrão da org, e um `claude-haiku-4-5`
   * fixo ia para o endpoint da OpenAI numa org só-OpenAI: toda classificação
   * falhava com "modelo inexistente".
   */
  classifierModel: string | null;
  /**
   * Provedor do classificador, quando o roteador escolhe um diferente do da org.
   *
   * O modelo sozinho não basta: `resolveOrgLlmConfig` decide o provedor por
   * `organizations.settings.llm.provider`, então gravar só `classifier_model`
   * com um id de outro provedor manda o modelo para a casa errada. Uma
   * organização com provedor Anthropic e crédito só na OpenAI ficava sem saída
   * — o classificador falhava e TODO turno caía no fallback.
   *
   * `null` = usa o provedor da organização (o comportamento de antes).
   */
  classifierProvider: string | null;
  sticky: boolean;
  minConfidence: number;
  contextMessageCount?: number;
  fallbackAgentId: string | null;
  /**
   * A frase que o CLIENTE lê quando o classificador troca quem atende sozinho
   * (#4363, `ai_routers.passagem_ao_cliente`). `null` = desligada, e o turno
   * segue como antes: a troca é silenciosa e quem se apresenta é o agente novo.
   *
   * Vazio depois do `trim` vale como `null`: um PATCH antigo não pode virar
   * mensagem em branco no WhatsApp do cliente. O teto é o mesmo CHECK da
   * coluna (1200), repetido aqui para o dublê que monta o roteador à mão.
   *
   * Opcional no TIPO porque os dublês de teste montam o roteador antes desta
   * coluna existir: ausente lê como desligado, igual a `null`.
   */
  passagemAoCliente?: string | null;
  /** Regras administrativas por remetente; validadas antes de escolher o agente. */
  senderRoutes?: unknown;
  members: RouterMember[];
}

interface RouterRow {
  id: string;
  name: string;
  config: Record<string, unknown> | null;
  fallback_agent_id: string | null;
  /** `null` em roteador criado antes da 9367 — o comportamento é o de antes. */
  passagem_ao_cliente?: string | null;
}

/** Teto da coluna (CHECK da 9367). Texto maior que isto é lixo de escrita, não frase. */
export const LIMITE_DA_PASSAGEM_AO_CLIENTE = 1200;

/**
 * A frase da passagem automática, pronta para uso — ou `null` quando não há
 * frase. Três coisas numa função só, porque cada uma já foi um defeito em
 * outro lugar do produto: `''` e espaço em branco são DESLIGADO (nunca uma
 * mensagem vazia no WhatsApp do cliente), texto acima do teto da coluna é
 * cortado em vez de fazer o turno falhar, e o resto vai como o dono escreveu —
 * sem interpretar `{{nome}}` nem nada: o texto é dele, não um template.
 */
export function normalizarPassagemAoCliente(texto: string | null | undefined): string | null {
  if (typeof texto !== 'string') return null;
  const limpo = texto.trim();
  if (limpo === '') return null;
  return limpo.slice(0, LIMITE_DA_PASSAGEM_AO_CLIENTE);
}

interface MemberRow {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[] | null;
  flow_pointer_id: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  agent_name: string | null;
  trigger_config: unknown;
}

export async function loadActiveRouter(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<LoadedRouter | null> {
  const { rows: routerRows } = await db.query<RouterRow>(
    `select id, name, config, fallback_agent_id, passagem_ao_cliente
     from ai_routers
     where organization_id = $1
       and channel_session_id = $2
       and is_active`,
    [organizationId, channelSessionId],
  );
  const router = routerRows[0];
  if (router === undefined) return null;

  const { rows: memberRows } = await db.query<MemberRow>(
    `select m.agent_id, m.intent_name, m.intent_description, m.examples, m.flow_pointer_id, m.pipeline_id, m.stage_id,
            a.name as agent_name,
            v.trigger_config
     from ai_router_members m
     -- O público (#3722) vem da versão PUBLICADA do agente, na MESMA consulta
     -- dos membros: leitura extra por turno só para quem declarou público, e
     -- nenhuma para quem não declarou. LEFT JOIN de propósito — membro sem
     -- versão publicada continua na lista e cai na reserva no turno, como antes.
     left join ai_agents a
       on a.id = m.agent_id and a.organization_id = m.organization_id and a.archived_at is null
     left join ai_agent_versions v
       on v.id = a.published_version_id and v.status = 'published'
     where m.router_id = $1
       and m.organization_id = $2
     order by m.position asc, m.intent_name asc`,
    [router.id, organizationId],
  );

  const cfg = (router.config ?? {}) as {
    classifier_model?: unknown;
    classifier_provider?: unknown;
    sticky?: unknown;
    min_confidence?: unknown;
    context_message_count?: unknown;
  };
  const classifierModel =
    typeof cfg.classifier_model === 'string' && cfg.classifier_model.trim() !== ''
      ? cfg.classifier_model
      : null;
  const classifierProvider =
    typeof cfg.classifier_provider === 'string' && cfg.classifier_provider.trim() !== ''
      ? cfg.classifier_provider
      : null;
  const sticky = typeof cfg.sticky === 'boolean' ? cfg.sticky : true;
  const minConfidence =
    typeof cfg.min_confidence === 'number' && cfg.min_confidence >= 0 && cfg.min_confidence <= 1
      ? cfg.min_confidence
      : 0.6;
  const contextMessageCount =
    typeof cfg.context_message_count === 'number' && Number.isInteger(cfg.context_message_count) &&
    cfg.context_message_count >= 0 && cfg.context_message_count <= MAX_CLASSIFIER_CONTEXT_MESSAGES
      ? cfg.context_message_count
      : CLASSIFIER_CONTEXT_MESSAGES;

  return {
    id: router.id,
    name: router.name,
    classifierModel,
    classifierProvider,
    sticky,
    minConfidence,
    contextMessageCount,
    fallbackAgentId: router.fallback_agent_id,
    passagemAoCliente: normalizarPassagemAoCliente(router.passagem_ao_cliente),
    senderRoutes: (router.config ?? {}).sender_routes,
    members: memberRows.map((m) => ({
      agentId: m.agent_id,
      intentName: m.intent_name,
      intentDescription: m.intent_description,
      examples: m.examples ?? [],
      // `?? undefined`: a coluna é do join; dublê antigo que não a traz cai no
      // `agentId` do rastro, sem inventar nome.
      agentName: m.agent_name ?? undefined,
      publico: lerPublicoDoGatilho(m.trigger_config),
      flowPointerId: m.flow_pointer_id,
      destinationPipelineId: m.pipeline_id,
      destinationStageId: m.stage_id,
    })),
  };
}
