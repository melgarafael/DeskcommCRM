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

export interface RouterMember {
  agentId: string;
  intentName: string;
  intentDescription: string;
  examples: string[];
  /**
   * Fluxo de atendimento que COMEÇA quando esta intenção casa (migration 0394; 0237 na branch do autor).
   * `null`/ausente = só roteia agente, como antes.
   */
  flowPointerId?: string | null;
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
  fallbackAgentId: string | null;
  members: RouterMember[];
}

interface RouterRow {
  id: string;
  name: string;
  config: Record<string, unknown> | null;
  fallback_agent_id: string | null;
}

interface MemberRow {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[] | null;
  flow_pointer_id: string | null;
}

export async function loadActiveRouter(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<LoadedRouter | null> {
  const { rows: routerRows } = await db.query<RouterRow>(
    `select id, name, config, fallback_agent_id
     from ai_routers
     where organization_id = $1
       and channel_session_id = $2
       and is_active`,
    [organizationId, channelSessionId],
  );
  const router = routerRows[0];
  if (router === undefined) return null;

  const { rows: memberRows } = await db.query<MemberRow>(
    `select agent_id, intent_name, intent_description, examples, flow_pointer_id
     from ai_router_members
     where router_id = $1
       and organization_id = $2
     order by position asc, intent_name asc`,
    [router.id, organizationId],
  );

  const cfg = (router.config ?? {}) as {
    classifier_model?: unknown;
    classifier_provider?: unknown;
    sticky?: unknown;
    min_confidence?: unknown;
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

  return {
    id: router.id,
    name: router.name,
    classifierModel,
    classifierProvider,
    sticky,
    minConfidence,
    fallbackAgentId: router.fallback_agent_id,
    members: memberRows.map((m) => ({
      agentId: m.agent_id,
      intentName: m.intent_name,
      intentDescription: m.intent_description,
      examples: m.examples ?? [],
      flowPointerId: m.flow_pointer_id,
    })),
  };
}
