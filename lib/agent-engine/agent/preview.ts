/** Preview is an execution policy of the real turn, never a simulated queue job. */
import type pg from 'pg';
import { hasOpenCaseForContact } from './human-cases';
import type { ToolSet } from '../edge/llm/run-model-call';
import type { LeadContext, LeadContextResult } from '../edge/crm/get-lead-context';
import type { PublishedAgentConfig } from './agent-config';
import type { LeadCheckpointRow } from './inbound-turn';
import {
  evaluateBeforeSend,
  type GateContext,
  type GateTraceEntry,
  loadChannelProvider,
} from '../guardrails/before-send';
import { loadChannelKnobs, loadPacingState } from '../pacing/store';
import { PACING_DEFAULTS } from '../pacing/defaults';
import { SPINNING_DEFAULTS } from '../spinning/defaults';
import { loadRecentCopies, loadSpinningKnobs } from '../spinning/store';
import { loadPromiseTable } from '../guardrails/promise/table';
import { loadDisclosureTemplate, countPriorAcceptedSends } from '../guardrails/disclosure/template';
import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels/capabilities';
import { getToolByName } from '@/lib/mcp/tools';
import type { Logger } from '../obs/logger';
import type { Citation } from '@/lib/ai/citations/types';
import {
  sinalDeConversaSobreGrade,
  sinalDePedidoComercialDaAcademia,
} from '@/lib/academia/consulta-grade';

export interface TurnPreview {
  kind: 'sandbox' | 'assisted';
  organizationId: string;
  runId: string;
  agent: PublishedAgentConfig;
  context: Extract<LeadContextResult, { ok: true }>;
  previous?: LeadCheckpointRow | null;
  notes?: Array<{ headline: string; body: string }>;
  feedback?: string;
  /** Null means a scenario, never a synthetic identifier passed to SQL. */
  contactId: string | null;
  channelId: string | null;
  gateContext?: GateContext;
  result: PreviewResult;
}
export interface PreviewResult {
  checkpoint?: unknown;
  candidates: Array<{ body: string; citations: Citation[]; trace: GateTraceEntry[] }>;
  proposals: Array<{ tool: string; arguments: unknown }>;
  impediments: Array<{ code: string; message: string }>;
  restrictions: string[];
}
export function newPreviewResult(): PreviewResult {
  return {
    candidates: [],
    proposals: [],
    impediments: [],
    restrictions: [
      'preview_no_client_effects',
      'writes_require_separate_authorization',
      'send_revalidates_live_state',
    ],
  };
}

export async function previewGateContext(
  db: pg.Pool,
  p: TurnPreview,
  log: Logger,
  now: Date,
): Promise<GateContext> {
  if (p.gateContext) return { ...p.gateContext, now };
  const org = p.organizationId,
    channel = p.channelId;
  const cfg = channel
    ? await loadChannelKnobs(db, org, channel, log)
    : { knobs: PACING_DEFAULTS, numberActivatedAt: null };
  const spinning = channel ? await loadSpinningKnobs(db, org, channel, log) : SPINNING_DEFAULTS;
  const promise = await loadPromiseTable(db, org),
    disclosure = await loadDisclosureTemplate(db, org);
  const first = p.contactId ? (await countPriorAcceptedSends(db, org, p.contactId)) === 0 : true;
  let lastInbound: Date | null = null;
  if (p.contactId && channel) {
    const { rows } = await db.query<{ last_inbound_at: Date | null }>(
      'select last_inbound_at from conversations where organization_id=$1 and id=$2 and contact_id=$3 and channel_session_id=$4',
      [org, p.context.context.conversation_id, p.contactId, channel],
    );
    lastInbound = rows[0]?.last_inbound_at ?? null;
  } else {
    const last = p.context.context.messages.filter((m) => m.direction === 'inbound').at(-1);
    lastInbound = last ? new Date(last.sent_at) : null;
    p.result.restrictions.push('contact_state_is_scenario');
  }
  return {
    now,
    body: '',
    optedOut: p.context.context.contact.is_blocked,
    provider: channel ? await loadChannelProvider(db, org, channel) : DEFAULT_CHANNEL_PROVIDER,
    messagingWindow: { lastInboundAt: lastInbound },
    pacing: {
      knobs: cfg.knobs,
      state: channel
        ? await loadPacingState(db, org, channel, {
            now,
            timezone: cfg.knobs.timezone,
            numberActivatedAt: cfg.numberActivatedAt,
          })
        : { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: {
      knobs: spinning,
      window: channel ? await loadRecentCopies(db, org, channel, spinning.windowSize) : [],
    },
    promise: { table: promise?.table ?? null },
    semanticPromise: null,
    disclosure: { template: disclosure?.body ?? null, isFirstOutbound: first, mode: 'inject' },
    lgpd: { ...p.context.lgpd, isFirstOutbound: first },
    casesEnabled: p.agent.casesEnabled,
    hasOpenCase:
      p.contactId && p.agent.casesEnabled
        ? await hasOpenCaseForContact(db, org, p.context.context.conversation_id!)
        : false,
    openedCaseThisTurn: false,
    humanPromiseExtraTargets: p.agent.handoffKeywords,
    agenda: { active: p.agent.toolIds.includes('crm_book_appointment'), toolCalledThisTurn: false },
    academiaGrade: {
      active:
        p.agent.toolIds.includes('crm_find_academia_classes') &&
        sinalDeConversaSobreGrade(p.context.context.messages),
      toolCalledThisTurn: false,
      commercialFollowupAllowed: sinalDePedidoComercialDaAcademia(
        p.context.context.messages.filter((message) => message.direction === 'inbound').at(-1)?.body ?? '',
      ),
    },
    internalVocabularyEnforced: true,
  };
}
const SCENARIO_READS = new Set([
  'crm_list_pipelines',
  'crm_list_stages',
  'crm_list_appointment_types',
  'crm_find_free_slots',
  'crm_find_academia_classes',
]);
/** Unknown tools fail closed. A write proposal never calls its original execute. */
export function applyPreviewPolicy(
  tools: ToolSet,
  p: TurnPreview,
  ctx: GateContext,
  citations: () => Citation[],
  semanticClassifier?: (body: string) => Promise<NonNullable<GateContext['semanticPromise']>>,
  liveContext?: () => Partial<GateContext>,
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const nativeRead = [
        'get_lead_context',
        'get_lead_note',
        'search_knowledge',
        'read_skill_reference',
      ].includes(name);
      const catalog = getToolByName(name);
      if (
        nativeRead ||
        (catalog?.category === 'read' && (p.contactId !== null || SCENARIO_READS.has(name)))
      )
        return [name, definition];
      return [
        name,
        {
          ...definition,
          execute: async (args: unknown) => {
            if (name === 'send_message') {
              const body =
                args && typeof args === 'object' && 'body' in args && typeof args.body === 'string'
                  ? args.body
                  : '';
              const result = evaluateBeforeSend({
                ...ctx,
                ...liveContext?.(),
                body,
                semanticPromise: semanticClassifier ? await semanticClassifier(body) : null,
              });
              if (result.veto) {
                p.result.impediments.push({ code: result.veto.code, message: result.veto.message });
                return {
                  ok: false,
                  error: { code: result.veto.code, message: result.veto.message },
                };
              }
              p.result.candidates.push({
                body: result.body,
                citations: citations(),
                trace: result.trace,
              });
              return {
                ok: true,
                status: p.kind === 'sandbox' ? 'simulated' : 'awaiting_approval',
                message: 'Resposta proposta. Nenhuma mensagem enviada. Encerre o turno.',
              };
            }
            if (catalog?.category === 'read')
              return {
                ok: false,
                error: {
                  code: 'scenario_contact_unavailable',
                  message: 'Esta consulta precisa de um contato real autorizado.',
                },
              };
            if (
              catalog ||
              [
                'send_template',
                'update_lead_state',
                'save_lead_note',
                'request_human_handoff',
                'schedule_followup',
                'open_human_case',
                'provide_case_update',
              ].includes(name)
            ) {
              p.result.proposals.push({ tool: name, arguments: args });
              return {
                ok: true,
                status: 'proposal_only',
                message:
                  'Proposta registrada. A operação não foi executada e exige autorização separada.',
              };
            }
            p.result.impediments.push({ code: 'unknown_preview_tool', message: name });
            return {
              ok: false,
              error: {
                code: 'unknown_preview_tool',
                message: 'Ferramenta não autorizada no teste.',
              },
            };
          },
        },
      ];
    }),
  ) as ToolSet;
}
export function scenarioContext(
  messages: LeadContext['messages'],
  contact?: { name?: string; phone?: string },
): Extract<LeadContextResult, { ok: true }> {
  return {
    ok: true,
    context: {
      lead_id: '',
      contact: {
        name: contact?.name ?? 'Teste',
        phone: contact?.phone ?? null,
        email: null,
        tags: [],
        is_blocked: false,
      },
      conversation_id: null,
      last_human_decision: null,
      messages,
    },
    tokenCount: 0,
    lgpd: {
      isAnonymized: false,
      isProspecting: false,
      legalBasis: { basis: null, consentGranted: false, legalBasisRef: null, dataOrigin: null },
    },
  };
}
