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
}

export interface LoadedRouter {
  id: string;
  name: string;
  /**
   * `null` = sem override — `classifyIntent` não passa `model` ao seam, que
   * herda `defaultModel` da própria organização (sempre pareado com o
   * provider dela, nunca inventado). Ver `classifierProvider` para o porquê
   * de model e provider serem lidos como PAR, nunca soltos.
   */
  classifierModel: string | null;
  /**
   * Provedor do classificador, quando o roteador escolhe um diferente do da org.
   *
   * Modelo e provider viajam sempre do MESMO lugar (mesma regra de
   * `lib/agent-engine/agent/aux-model-args.ts`, PR #151): `resolveOrgLlmConfig`
   * decide o provider por `organizations.settings.llm.provider`, então um
   * `classifier_model` sem `classifier_provider` par é um id que pode não
   * existir no catálogo do provider errado — ex.: o default de banco
   * `'claude-haiku-4-5'` só existe no catálogo `anthropic`; numa org OpenRouter
   * ele não bate com nenhuma linha de `ai_models` e o classificador falha
   * SEMPRE, silenciosamente (confidence 0 em toda mensagem). Por isso
   * `classifierModel` só é honrado abaixo quando vem PAREADO com
   * `classifierProvider` — sem os dois, os dois viram `null` e o seam herda
   * o par (provider + modelo) já validado da organização.
   *
   * `null` = usa o provedor (e o modelo) da organização.
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
    `select agent_id, intent_name, intent_description, examples
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
  const classifierProvider =
    typeof cfg.classifier_provider === 'string' && cfg.classifier_provider.trim() !== ''
      ? cfg.classifier_provider
      : null;
  // Só honra o modelo quando ele vem PAREADO com o provider (ver doc-comment
  // de classifierProvider acima) — sem par, os dois ficam null e o seam herda
  // modelo+provider já consistentes da organização.
  const classifierModel =
    classifierProvider !== null &&
    typeof cfg.classifier_model === 'string' &&
    cfg.classifier_model.trim() !== ''
      ? cfg.classifier_model
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
    })),
  };
}
