import { createHash } from "node:crypto";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { createMcpAgentDraft } from "@/lib/ai/agents/create-draft";
import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { escolherModeloDoProvedor } from "@/lib/ai/agents/escolher-modelo";
import { capacidadesPadraoDoOnboarding } from "@/lib/ai/agents/capacidades-padrao";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import { lockRouter, writeRouterMembers } from "@/lib/ai/agents/router-members";
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { PROVIDERS } from "@/lib/ai/agents/validation";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { prospectingAgentSetupSchema, type ProspectingAgentSetupInput } from "./agent-setup-schema";
import { agentSessionLock, agentSetupSessionSchema } from "./agent-session-schema";

export class AgentSetupError extends Error {
  constructor(
    message: string,
    public status = 422,
    public agentId?: string,
  ) {
    super(message);
  }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function setupProposalHash(input: ProspectingAgentSetupInput) {
  return hash({ ...input, enable_router_continuity: false });
}
export function setupAgentId(orgId: string, campaignId: string, requestId: string) {
  const h = hash(["prospecting-agent", orgId, campaignId, requestId]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function prospectingAgentPrompt(input: ProspectingAgentSetupInput) {
  const tone = {
    cordial: "cordial e acolhedor",
    professional: "profissional e consultivo",
    direct: "direto e objetivo",
  }[input.tone];
  return `Você é ${input.name}, assistente de IA comercial. Converse em português do Brasil, em tom ${tone}, com mensagens curtas e uma pergunta por vez.
Identifique-se com transparência. A origem do contato é uma pesquisa de informações comerciais públicas; nunca alegue cadastro, pedido ou consentimento que a pessoa não confirmou.
Oferta e objetivo definidos pelo responsável:
${input.instruction}
Critérios de qualificação:
${input.qualification}
Descubra a necessidade antes de propor a solução. Não invente preços, benefícios, resultados, disponibilidade nem informações sobre a empresa. Quando faltar informação, diga isso e encaminhe para uma pessoa.
Respeite recusa e pedido para parar: não insista e encaminhe para atendimento humano. Pedido de humano deve ser atendido imediatamente.
O contato e a oportunidade desta campanha já estão no CRM. Consulte a oportunidade existente, anote apenas fatos confirmados e não crie duplicatas. Use somente o funil ${input.pipeline_id}. A etapa inicial é ${input.stage_id}; mova para ${input.qualified_stage_id} SOMENTE quando a conversa comprovar os critérios acima. Mensagem enviada ou resposta recebida, sozinhas, não significam qualificação.
Use as ferramentas disponíveis para registrar fatos e mover a oportunidade; nunca afirme que registrou algo se a ferramenta não confirmou. As instruções da campanha no contexto da conversa detalham a abordagem atual.`;
}

export interface ModelChoice {
  provider: string;
  model: string;
  credential_id: string | null;
  label: string;
}
export async function resolveSetupModel(
  db: pg.PoolClient,
  orgId: string,
  channelId: string | null = null,
): Promise<ModelChoice> {
  const published = await db.query(
    `select v.provider,v.model,v.credential_id,m.display_name from ai_agents a
     join ai_agent_versions v on v.organization_id=a.organization_id and v.id=a.published_version_id
     join ai_models m on m.provider=v.provider and m.model_id=v.model and m.supports_tools and m.deprecated_at is null
     left join ai_provider_credentials c on c.organization_id=a.organization_id and c.id=v.credential_id and c.provider=v.provider
     where a.organization_id=$1 and a.archived_at is null and a.paused_at is null and v.status='published'
     and (v.credential_id is null or (c.is_active and c.validated_at is not null))
     order by (v.channel_session_id=$2) desc,a.priority desc,a.created_at`,
    [orgId, channelId],
  );
  for (const row of published.rows) {
    if (PROVIDERS.includes(row.provider) && (row.credential_id || chaveDePlataforma(row.provider)))
      return {
        provider: row.provider,
        model: row.model,
        credential_id: row.credential_id,
        label: `${row.provider} · ${row.display_name ?? row.model}`,
      };
  }
  const org = await db.query("select settings from organizations where id=$1", [orgId]);
  const credentials = await db.query(
    "select id,provider from ai_provider_credentials where organization_id=$1 and is_active and validated_at is not null order by created_at,id",
    [orgId],
  );
  const preferred = org.rows[0]?.settings?.llm?.provider;
  const providers = [
    ...new Set([preferred, ...credentials.rows.map((c) => c.provider), ...PROVIDERS]),
  ];
  for (const provider of providers) {
    if (!PROVIDERS.includes(provider)) continue;
    const credential = credentials.rows.find((c) => c.provider === provider);
    if (!credential && !chaveDePlataforma(provider)) continue;
    const models = await db.query(
      "select model_id,display_name,is_default_for_provider,supports_tools,input_price_per_million_cents,output_price_per_million_cents from ai_models where provider=$1 and deprecated_at is null",
      [provider],
    );
    const selected = escolherModeloDoProvedor(models.rows);
    if (selected.escolhido)
      return {
        provider,
        model: selected.modelId,
        credential_id: credential?.id ?? null,
        label: `${provider} · ${models.rows.find((m) => m.model_id === selected.modelId)?.display_name ?? selected.modelId}`,
      };
  }
  throw new AgentSetupError(
    "Configure uma chave de IA válida e um modelo com ferramentas em Agente de IA → Provedores.",
  );
}

/** Must run in a transaction: locks channel and router through final membership write. */
async function preflight(
  db: pg.PoolClient,
  orgId: string,
  input: ProspectingAgentSetupInput,
  agentId: string,
  prepareOnly = false,
) {
  const campaign = await db.query(
    "select id from prospecting_campaigns where organization_id=$1 and id=$2",
    [orgId, input.campaign_id],
  );
  if (!campaign.rows.length)
    throw new AgentSetupError("Campanha não encontrada nesta organização.", 404);
  const channel = await db.query(
    "select id,provider,status from channel_sessions where organization_id=$1 and id=$2 and archived_at is null for update",
    [orgId, input.channel_session_id],
  );
  const c = channel.rows[0];
  if (
    !c ||
    c.status !== "WORKING" ||
    !capabilitiesOf(c.provider as ChannelProvider).freeformOutsideWindow
  )
    throw new AgentSetupError("Escolha uma conexão ativa que permita iniciar conversas de texto.");
  const stages = await db.query(
    `select s.id from crm_stages s join crm_pipelines p on p.organization_id=s.organization_id and p.id=s.pipeline_id
     where s.organization_id=$1 and s.pipeline_id=$2 and s.id=any($3::uuid[])
     and not s.is_archived and not s.is_won and not s.is_lost and not p.is_archived`,
    [orgId, input.pipeline_id, [input.stage_id, input.qualified_stage_id]],
  );
  if (input.stage_id === input.qualified_stage_id || stages.rows.length !== 2)
    throw new AgentSetupError("Escolha duas etapas abertas e diferentes do mesmo funil.");
  const routers = await db.query(
    "select id from ai_routers where organization_id=$1 and channel_session_id=$2 and is_active",
    [orgId, input.channel_session_id],
  );
  if (routers.rows[0]) {
    const router = await lockRouter(db, orgId, routers.rows[0].id);
    if (!router.is_active || router.channel_session_id !== input.channel_session_id)
      throw new AgentSetupError("O roteador mudou durante a configuração. Tente novamente.", 409);
    if (!prepareOnly && router.config?.sticky === false && !input.enable_router_continuity)
      throw new AgentSetupError(
        "Ative a continuidade do agente nesta tela para que ele acompanhe as respostas no canal.",
      );
    return router;
  }
  const incumbent = await db.query(
    `select a.id from ai_agents a join ai_agent_versions v on v.organization_id=a.organization_id and v.id=a.published_version_id
     where a.organization_id=$1 and a.archived_at is null and v.status='published' and v.channel_session_id=$2 and a.id<>$3 limit 1`,
    [orgId, input.channel_session_id, agentId],
  );
  if (incumbent.rows.length)
    throw new AgentSetupError(
      "Este canal já tem um agente e não tem roteador. Use o agente existente, escolha outro canal ou configure um roteador em Agente de IA → Roteadores.",
    );
  return null;
}

interface SetupMetadata {
  hash: string;
  version_id: string;
  model_label: string;
  state: "draft" | "ready";
  version_hash: string;
  paused_at: string;
  proposal_hash?: string;
  prepared_only?: boolean;
}
function versionHash(row: Record<string, unknown>) {
  const keys = Object.keys(versionCreateSchema.shape);
  return hash(
    versionCreateSchema.parse(
      Object.fromEntries(
        keys
          .filter(
            (key) => row[key] !== undefined && !(key === "trigger_config" && row[key] === null),
          )
          .map((key) => [key, row[key]]),
      ),
    ),
  );
}

export async function setupProspectingAgent(
  pool: pg.Pool,
  admin: SupabaseClient,
  context: { orgId: string; userId: string; requestId: string },
  raw: unknown,
  options: { prepareOnly?: boolean } = {},
) {
  const input = prospectingAgentSetupSchema.parse(raw);
  const agentId = setupAgentId(context.orgId, input.campaign_id, input.request_id);
  const requestHash = hash(input);
  const db = await pool.connect();
  let saved = false;
  const locked: string[] = [];
  let createdNow = false;
  try {
    // Keep the channel reservation across the canonical publish HTTP call.
    // Otherwise two distinct requests can each publish a paused incumbent and
    // then prevent one another from completing. Fixed order: channel, request.
    for (const key of [
      agentSessionLock(context.orgId, input.campaign_id),
      `prospecting-agent-channel:${context.orgId}:${input.channel_session_id}`,
      `prospecting-agent:${agentId}`,
    ]) {
      await db.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
      locked.push(key);
    }
    const savedSession = await db.query(
      "select agent_setup,agent_setup_revision from prospecting_campaigns where organization_id=$1 and id=$2",
      [context.orgId, input.campaign_id],
    );
    if (Number(savedSession.rows[0]?.agent_setup_revision ?? 0) > 0) {
      const session = agentSetupSessionSchema.parse(savedSession.rows[0].agent_setup);
      if (
        session.attempt_action &&
        session.attempt_action !== (options.prepareOnly ? "prepare" : "publish")
      )
        throw new AgentSetupError(
          "A ação mudou. Salve a confirmação atual antes de continuar.",
          409,
        );
      if (!session.attempt || hash(session.attempt) !== requestHash || session.input.trim())
        throw new AgentSetupError(
          "O resumo mudou. Salve a configuração atual antes de preparar o agente.",
          409,
        );
    }
    await db.query("begin");
    const existing = await db.query(
      "select id,name,config,published_version_id,archived_at from ai_agents where organization_id=$1 and id=$2 for update",
      [context.orgId, agentId],
    );
    let metadata: SetupMetadata;
    if (existing.rows[0]) {
      saved = true;
      const agent = existing.rows[0];
      metadata = agent.config?.prospecting_setup;
      const changedContinuityAfterPreview =
        metadata?.prepared_only &&
        !agent.published_version_id &&
        metadata.proposal_hash === setupProposalHash(input);
      if (
        !metadata ||
        (metadata.hash !== requestHash && !changedContinuityAfterPreview) ||
        agent.archived_at
      )
        throw new AgentSetupError(
          "Esta tentativa já foi usada com outra configuração. Revise o agente existente antes de criar outro.",
          409,
          agentId,
        );
      if (metadata.state === "ready") {
        await db.query("commit");
        return {
          agent: { id: agentId, name: agent.name },
          version_id: metadata.version_id,
          model_label: metadata.model_label,
        };
      }
      const version = await db.query(
        "select * from ai_agent_versions where organization_id=$1 and agent_id=$2 and id=$3",
        [context.orgId, agentId, metadata.version_id],
      );
      if (
        !version.rows[0] ||
        versionHash(version.rows[0]) !== metadata.version_hash ||
        (agent.published_version_id && agent.published_version_id !== metadata.version_id)
      )
        throw new AgentSetupError(
          "O rascunho foi alterado. Revise e publique no editor do agente.",
          409,
          agentId,
        );
      await preflight(db, context.orgId, input, agentId, options.prepareOnly);
      if (metadata.prepared_only && !options.prepareOnly) {
        metadata = { ...metadata, hash: requestHash, prepared_only: false };
        await db.query(
          "update ai_agents set config=jsonb_set(config,'{prospecting_setup}',$3::jsonb) where organization_id=$1 and id=$2",
          [context.orgId, agentId, JSON.stringify(metadata)],
        );
      }
    } else {
      await preflight(db, context.orgId, input, agentId, options.prepareOnly);
      const model = await resolveSetupModel(db, context.orgId, input.channel_session_id);
      const version = versionCreateSchema.parse({
        system_prompt: prospectingAgentPrompt(input),
        provider: model.provider,
        model: model.model,
        credential_id: model.credential_id,
        channel_session_id: input.channel_session_id,
        tool_ids: capacidadesPadraoDoOnboarding().filter((id) =>
          [
            "crm_get_lead",
            "crm_list_leads",
            "crm_list_pipelines",
            "crm_update_lead",
            "crm_move_lead_stage",
          ].includes(id),
        ),
        pipeline_ids: [input.pipeline_id],
        knowledge_source_ids: [],
        handoff_tool_enabled: true,
        trigger_config: {
          events: ["message"],
          filters: {
            ignore_groups: true,
            ignore_self: true,
            keyword_regex: null,
            business_hours: null,
          },
          concurrency: "one_per_conversation",
        },
      });
      metadata = {
        hash: requestHash,
        version_id: setupAgentId(context.orgId, agentId, "version"),
        model_label: model.label,
        state: "draft",
        version_hash: versionHash(version),
        paused_at: new Date().toISOString(),
        proposal_hash: setupProposalHash(input),
        prepared_only: options.prepareOnly === true,
      };
      await createMcpAgentDraft(
        db,
        context,
        { name: input.name, description: "Agente comercial criado pela Prospecção", version },
        {
          agentId,
          versionId: metadata.version_id,
          pausedAt: new Date(metadata.paused_at),
          config: { prospecting_setup: metadata },
        },
      );
      createdNow = true;
    }
    await db.query("commit");
    saved = true;
    if (createdNow)
      await audit({
        action: "ai_agent.created",
        actorUserId: context.userId,
        organizationId: context.orgId,
        resourceType: "ai_agent",
        resourceId: agentId,
        requestId: context.requestId,
        metadata: { source: "prospecting", campaign_id: input.campaign_id, draft: true },
      });
    if (options.prepareOnly)
      return {
        agent: { id: agentId, name: input.name },
        version_id: metadata.version_id,
        model_label: metadata.model_label,
      };
    // Publication is canonical; the agent remains paused until routing commits.
    const current = await db.query(
      "select published_version_id from ai_agents where organization_id=$1 and id=$2",
      [context.orgId, agentId],
    );
    if (
      current.rows[0]?.published_version_id &&
      current.rows[0].published_version_id !== metadata.version_id
    )
      throw new AgentSetupError(
        "Outra versão foi publicada. Revise o agente no editor.",
        409,
        agentId,
      );
    if (current.rows[0]?.published_version_id !== metadata.version_id) {
      const result = await publishAgentVersion(admin, {
        orgId: context.orgId,
        agentId,
        versionId: metadata.version_id,
      });
      if (!result.ok)
        throw new AgentSetupError(
          "O rascunho foi salvo, mas a publicação não foi concluída. Verifique a chave de IA e a conexão; tente novamente ou abra o editor do agente.",
          422,
          agentId,
        );
    }
    await db.query("begin");
    const router = await preflight(db, context.orgId, input, agentId);
    await db.query("select id from ai_agents where organization_id=$1 and id=$2 for update", [
      context.orgId,
      agentId,
    ]);
    const finalVersion = await db.query(
      "select * from ai_agent_versions where organization_id=$1 and agent_id=$2 and id=$3",
      [context.orgId, agentId, metadata.version_id],
    );
    if (!finalVersion.rows[0] || versionHash(finalVersion.rows[0]) !== metadata.version_hash)
      throw new AgentSetupError(
        "O conteúdo do agente mudou. Revise a versão no editor antes de ativá-la.",
        409,
        agentId,
      );
    let continuityChanged = false;
    if (router) {
      if (router.config?.sticky === false) {
        await db.query(
          "update ai_routers set config=config || '{\"sticky\":true}'::jsonb where organization_id=$1 and id=$2",
          [context.orgId, router.id],
        );
        continuityChanged = true;
      }
      await writeRouterMembers(
        db,
        context.orgId,
        router.id,
        [
          {
            agent_id: agentId,
            intent_name: `prospeccao_${agentId}`,
            intent_description: `Respostas à abordagem comercial: ${input.instruction}`.slice(
              0,
              2000,
            ),
            examples: [],
          },
        ],
        "append",
      );
    }
    const activated = await db.query(
      `update ai_agents set paused_at=null,operation_mode='automatic',config=jsonb_set(config,'{prospecting_setup,state}','"ready"'::jsonb)
       where organization_id=$1 and id=$2 and archived_at is null and published_version_id=$3
       and paused_at=$4::timestamptz and operation_mode='automatic' and config->'prospecting_setup'->>'hash'=$5 returning id`,
      [context.orgId, agentId, metadata.version_id, metadata.paused_at, requestHash],
    );
    if (!activated.rows.length)
      throw new AgentSetupError(
        "O agente mudou durante a configuração. Revise o rascunho no editor.",
        409,
        agentId,
      );
    await db.query(
      `insert into event_log(organization_id,event_type,entity_kind,payload)
      values($1,'ai_agent.published','ai_agent',$2::jsonb)`,
      [
        context.orgId,
        JSON.stringify({
          agent_id: agentId,
          version_id: metadata.version_id,
          previous_version_id: null,
          source: "prospecting",
        }),
      ],
    );
    await db.query("commit");
    await audit({
      action: "ai_agent.published",
      actorUserId: context.userId,
      organizationId: context.orgId,
      resourceType: "ai_agent",
      resourceId: agentId,
      requestId: context.requestId,
      metadata: { version_id: metadata.version_id },
    });
    if (router)
      await audit({
        action: "ai.router_members_updated",
        actorUserId: context.userId,
        organizationId: context.orgId,
        resourceType: "ai_router",
        resourceId: router.id,
        requestId: context.requestId,
        metadata: { added_agent_id: agentId },
      });
    if (continuityChanged)
      await audit({
        action: "ai.router_updated",
        actorUserId: context.userId,
        organizationId: context.orgId,
        resourceType: "ai_router",
        resourceId: router.id,
        requestId: context.requestId,
        metadata: { patch: ["config.sticky"], sticky: true },
      });
    return {
      agent: { id: agentId, name: input.name },
      version_id: metadata.version_id,
      model_label: metadata.model_label,
    };
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    if (error instanceof AgentSetupError) {
      if (saved) error.agentId = agentId;
      throw error;
    }
    throw new AgentSetupError(
      saved
        ? "A configuração do agente foi salva. Tente concluir novamente ou revise a configuração no editor."
        : "Não foi possível preparar o agente. Confira a configuração e tente novamente.",
      500,
      saved ? agentId : undefined,
    );
  } finally {
    let destroy = false;
    for (const key of locked.reverse()) {
      try {
        await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
      } catch {
        destroy = true;
        break;
      }
    }
    db.release(destroy);
  }
}
