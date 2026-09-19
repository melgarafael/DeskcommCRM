import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { createLeadSchema } from "@/lib/schemas/leads";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  campaignConfigSchema,
  normalizeProspect,
  type CampaignConfig,
  type SearchInput,
  type Prospect,
} from "./schema";
import {
  ProspectingError,
  providerRequest,
  readResults,
  readSearch,
  startSearch,
} from "./provider";

export interface Campaign {
  id: string;
  organization_id: string;
  name: string;
  search: SearchInput;
  config: CampaignConfig | null;
  status: string;
  search_status: string;
  run_id: string | null;
  dataset_id: string | null;
  next_send_at: Date;
  created_at: Date;
  error: string | null;
}
export interface Candidate {
  id: string;
  organization_id: string;
  campaign_id: string;
  data: Prospect;
  status: string;
  phone: string | null;
  contact_id: string | null;
  lead_id: string | null;
  conversation_id: string | null;
  service_boundary: unknown;
  message_id: string;
}
/** Session-scoped PostgreSQL lock shared by commands and worker; no process-local lock. */
export async function withProspectingLock<T>(
  pool: pg.Pool,
  org: string,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let locked = false;
  try {
    locked =
      (
        await db.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
          [`prospecting:${org}`],
        )
      ).rows[0]?.locked === true;
    if (!locked)
      throw new ProspectingError(
        "Uma operação está em andamento. Tente novamente em alguns segundos.",
        409,
      );
    return await fn(db);
  } finally {
    try {
      if (locked)
        await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [`prospecting:${org}`]);
    } finally {
      db.release();
    }
  }
}
export async function credential(db: pg.Pool | pg.PoolClient, admin: SupabaseClient, org: string) {
  const { rows } = await db.query<{ credential_encrypted: Buffer }>(
    "select credential_encrypted from prospecting_settings where organization_id=$1",
    [org],
  );
  const encrypted = rows[0]?.credential_encrypted;
  if (!encrypted)
    throw new ProspectingError("Configure a chave de busca antes de extrair empresas.");
  const key = await decryptWebhookSecret(admin, encrypted.toString("hex"));
  if (!key)
    throw new ProspectingError(
      "Não foi possível abrir a chave de busca. Salve a configuração novamente.",
    );
  return key;
}
export async function configureCredential(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  key: string,
) {
  await providerRequest(key, "users/me");
  const encrypted = await encryptWebhookSecret(admin, key);
  if (!encrypted)
    throw new ProspectingError("A cifra de credenciais da instalação não está disponível.");
  await pool.query(
    "insert into prospecting_settings(organization_id,credential_encrypted) values ($1,$2::bytea) on conflict(organization_id) do update set credential_encrypted=excluded.credential_encrypted,updated_at=now()",
    [org, encrypted],
  );
}
export async function createSearch(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  requestId: string,
  search: SearchInput,
) {
  return withProspectingLock(pool, org, async (db) => {
    const prior = await db.query<Campaign>(
      "select * from prospecting_campaigns where organization_id=$1 and request_id=$2",
      [org, requestId],
    );
    if (prior.rows[0]) return prior.rows[0];
    const key = await credential(db, admin, org);
    const { rows } = await db.query<Campaign>(
      "insert into prospecting_campaigns(organization_id,request_id,name,search) values($1,$2,$3,$4) returning *",
      [org, requestId, search.name, search],
    );
    const campaign = rows[0]!;
    try {
      const run = await startSearch(key, search);
      await db.query(
        "update prospecting_campaigns set run_id=$3,dataset_id=$4,search_status='running',updated_at=now() where organization_id=$1 and id=$2",
        [org, campaign.id, run.id, run.defaultDatasetId ?? null],
      );
    } catch (error) {
      await db.query(
        "update prospecting_campaigns set search_status='unknown',error=$3,updated_at=now() where organization_id=$1 and id=$2",
        [
          org,
          campaign.id,
          error instanceof ProspectingError
            ? error.message
            : "Não foi possível confirmar a busca. Confira as execuções no provedor antes de repetir.",
        ],
      );
    }
    return (
      await db.query<Campaign>(
        "select * from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, campaign.id],
      )
    ).rows[0]!;
  });
}
export async function synchronizeSearch(db: pg.PoolClient, admin: SupabaseClient, c: Campaign) {
  if (!c.run_id) return;
  const key = await credential(db, admin, c.organization_id);
  const run = await readSearch(key, c.run_id);
  if (["FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    await db.query(
      "update prospecting_campaigns set search_status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2",
      [c.organization_id, c.id, `A busca terminou com estado ${run.status}.`],
    );
    return;
  }
  if (run.status !== "SUCCEEDED") return;
  const dataset = run.defaultDatasetId ?? c.dataset_id;
  if (!dataset) throw new ProspectingError("Busca concluída sem resultado disponível.");
  const items = await readResults(key, dataset, c.search.limit);
  let inserted = 0;
  await db.query("begin");
  try {
    for (const item of items) {
      const p = normalizeProspect(item);
      if (!p) continue;
      const result = await db.query(
        "insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data) values($1,$2,$3,$4,$5) on conflict do nothing",
        [c.organization_id, c.id, p.key, p.phone, p],
      );
      inserted += result.rowCount ?? 0;
    }
    await db.query(
      "update prospecting_campaigns set search_status='succeeded',dataset_id=$3,cost_usd=$4,result_count=$5,skipped_count=$6,error=null,updated_at=now() where organization_id=$1 and id=$2",
      [
        c.organization_id,
        c.id,
        dataset,
        run.usageTotalUsd ?? null,
        inserted,
        items.length - inserted,
      ],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
export async function validateConfig(db: pg.PoolClient, org: string, input: CampaignConfig) {
  const config = campaignConfigSchema.parse(input);
  const agent = (
    await db.query(
      "select v.tool_ids,v.pipeline_ids from ai_agents a join ai_agent_versions v on v.id=a.published_version_id and v.organization_id=a.organization_id where a.organization_id=$1 and a.id=$2 and v.status='published' and a.archived_at is null and a.paused_at is null and a.operation_mode='automatic'",
      [org, config.agent_id],
    )
  ).rows[0];
  if (!agent) throw new ProspectingError("Escolha um agente publicado e em operação automática.");
  if (
    !agent.tool_ids?.includes("crm_move_lead_stage") ||
    !agent.pipeline_ids?.includes(config.pipeline_id)
  )
    throw new ProspectingError(
      "Publique o agente com a ferramenta de mover negócios e acesso ao funil escolhido.",
    );
  const channel = (
    await db.query<{ provider: ChannelProvider; status: string }>(
      "select provider,status from channel_sessions where organization_id=$1 and id=$2 and archived_at is null",
      [org, config.channel_session_id],
    )
  ).rows[0];
  if (
    !channel ||
    channel.status !== "WORKING" ||
    !capabilitiesOf(channel.provider).freeformOutsideWindow
  )
    throw new ProspectingError(
      "Escolha uma conexão ativa que permita iniciar conversas de texto. Canais que exigem modelo aprovado ainda não participam desta campanha.",
    );
  const router = await loadActiveRouter(db as unknown as pg.Pool, org, config.channel_session_id);
  if (router) {
    if (!router.sticky || !router.members.some((m) => m.agentId === config.agent_id))
      throw new ProspectingError(
        "Inclua o agente no roteador deste canal e ative a continuidade do agente antes de iniciar.",
      );
  } else {
    const bound = await loadPublishedAgentConfig(
      db as unknown as pg.Pool,
      org,
      config.channel_session_id,
    );
    if (bound?.agentId !== config.agent_id)
      throw new ProspectingError(
        "Publique o agente no canal escolhido para que ele também atenda às respostas.",
      );
  }
  const stages = (
    await db.query<{ id: string }>(
      "select id from crm_stages where organization_id=$1 and pipeline_id=$2 and id=any($3::uuid[]) and not is_archived and not is_won and not is_lost",
      [org, config.pipeline_id, [config.stage_id, config.qualified_stage_id]],
    )
  ).rows;
  if (config.stage_id === config.qualified_stage_id || stages.length !== 2)
    throw new ProspectingError(
      "Escolha duas etapas abertas e diferentes do mesmo funil: entrada e qualificados.",
    );
  return config;
}
export async function activateCampaign(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  id: string,
  input: CampaignConfig,
) {
  return withProspectingLock(pool, org, async (db) => {
    const config = await validateConfig(db, org, input);
    const c = (
      await db.query<Campaign>(
        "select * from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, id],
      )
    ).rows[0];
    if (!c) throw new ProspectingError("Campanha não encontrada.", 404);
    if (c.status !== "draft" || c.search_status !== "succeeded")
      throw new ProspectingError(
        "Aguarde a busca terminar; uma campanha já iniciada deve ser retomada.",
        409,
      );
    if (
      (
        await db.query(
          "select id from prospecting_campaigns where organization_id=$1 and status='running'",
          [org],
        )
      ).rows.length
    )
      throw new ProspectingError("Pause a campanha atual antes de iniciar outra.", 409);
    if (c.config && JSON.stringify(campaignConfigSchema.parse(c.config)) !== JSON.stringify(config))
      throw new ProspectingError(
        "A preparação já começou. Retome com a mesma configuração da campanha.",
        409,
      );
    await db.query(
      "update prospecting_campaigns set config=$3 where organization_id=$1 and id=$2",
      [org, id, config],
    );
    // Activation is the authorized origin. A later tick only uses this captured boundary.
    const candidates = (
      await db.query<Candidate>(
        "select * from prospecting_candidates where organization_id=$1 and campaign_id=$2 and status='new' order by created_at,id",
        [org, id],
      )
    ).rows;
    for (const p of candidates) {
      if (!p.phone) {
        await db.query(
          "update prospecting_candidates set status='skipped',error='Sem telefone brasileiro válido.' where organization_id=$1 and id=$2",
          [org, p.id],
        );
        continue;
      }
      const known = await db.query(
        "select id from contacts where organization_id=$1 and phone_number=any($2::text[])",
        [org, phoneLookupVariants(p.phone)],
      );
      if (known.rows.length && !p.contact_id) {
        const owned = await db.query(
          "select id from contacts where organization_id=$1 and id=$2 and source='prospecting' and source_metadata->>'campaign_id'=$3 and source_metadata->>'place_id'=$4",
          [org, known.rows[0].id, id, p.data.key],
        );
        if (owned.rows[0]) p.contact_id = owned.rows[0].id;
      }
      if (known.rows.length && !p.contact_id) {
        await db.query(
          "update prospecting_candidates set status='skipped',error='Contato já existe no CRM; atendimento preservado.' where organization_id=$1 and id=$2",
          [org, p.id],
        );
        continue;
      }
      const ctx = {
        organization_id: org,
        actor: { type: "webhook_source" as const, id },
        requestId: `rule:${id}`,
      };
      let contactId = p.contact_id;
      if (!contactId) {
        const contact = await createContactHandler(admin, ctx, {
          name: p.data.name,
          display_name: p.data.name,
          phone_number: p.phone,
          source: "prospecting",
          source_metadata: { campaign_id: id, place_id: p.data.key, maps_url: p.data.maps_url },
          consent: { legitimate_interest: { ref: config.legal_basis_ref } },
        });
        contactId = String(contact.contact.id);
        await db.query(
          "update prospecting_candidates set contact_id=$3 where organization_id=$1 and id=$2",
          [org, p.id, contactId],
        );
      }
      let leadId = p.lead_id;
      if (!leadId) {
        const existing = await db.query(
          "select id from crm_leads where organization_id=$1 and source='prospecting' and external_id=$2",
          [org, p.id],
        );
        leadId = existing.rows[0]?.id ?? null;
      }
      if (!leadId) {
        const lead = await createLeadHandler(admin, ctx, {
          ...createLeadSchema.parse({
            pipeline_id: config.pipeline_id,
            stage_id: config.stage_id,
            title: p.data.name,
            contact_id: contactId,
            owner_agent_id: config.agent_id,
            source: "prospecting",
            description: `Campanha: ${c.name}\nQualificação: ${config.qualification}`.slice(
              0,
              2000,
            ),
          }),
          external_id: p.id,
        });
        leadId = String(lead.id);
        await db.query(
          "update prospecting_candidates set lead_id=$3 where organization_id=$1 and id=$2",
          [org, p.id, leadId],
        );
      }
      await db.query(
        "update prospecting_candidates set contact_id=$3,lead_id=$4 where organization_id=$1 and id=$2",
        [org, p.id, contactId, leadId],
      );
      const boundary = await beginServiceAtOrigin(admin, org, contactId, config.channel_session_id);
      await db.query(
        "update conversations set active_ai_agent_id=$3,metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('prospecting_campaign_id',$4::text) where organization_id=$1 and id=$2",
        [org, boundary.conversation_id, config.agent_id, id],
      );
      await db.query(
        "update prospecting_candidates set status='queued',conversation_id=$3,service_boundary=$4,error=null,updated_at=now() where organization_id=$1 and id=$2",
        [org, p.id, boundary.conversation_id, boundary],
      );
    }
    await db.query(
      "update prospecting_campaigns set config=$3,status='running',next_send_at=now()+interval '1 minute',error=null,updated_at=now() where organization_id=$1 and id=$2",
      [org, id, config],
    );
    return { started: true };
  });
}
