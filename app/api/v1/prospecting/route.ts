import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { ProspectingError } from "@/lib/prospecting/provider";
import { prospectingInputSchema } from "@/lib/prospecting/schema";
import {
  activateCampaign,
  configureCredential,
  createSearch,
  validateConfig,
  withProspectingLock,
  type Campaign,
} from "@/lib/prospecting/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown, requestId: string) {
  return fail(
    "prospecting_unavailable",
    error instanceof ProspectingError
      ? error.message
      : "Não foi possível concluir a operação. Verifique a configuração e tente novamente.",
    error instanceof ProspectingError ? error.status : 500,
    { requestId, headers },
  );
}
export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "prospecting" });
  if (!auth.ok) return auth.response;
  try {
    const db = getRequestPool();
    const org = auth.org.orgId;
    const [settings, campaigns, candidates, agents, channels, stages] = await Promise.all([
      db.query("select organization_id from prospecting_settings where organization_id=$1", [org]),
      db.query(
        "select id,name,search,config,status,search_status,run_id,cost_usd,result_count,skipped_count,error,next_send_at,created_at from prospecting_campaigns where organization_id=$1 order by created_at desc limit 50",
        [org],
      ),
      db.query(
        "select p.id,p.campaign_id,p.data,p.status,p.error,p.lead_id,p.conversation_id,p.attempted_at,m.status as message_status,case when l.stage_id::text=c.config->>'qualified_stage_id' then 'qualified' when v.last_inbound_at is not null then 'replied' else p.status end as progress from prospecting_candidates p join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id left join crm_leads l on l.organization_id=p.organization_id and l.id=p.lead_id left join conversations v on v.organization_id=p.organization_id and v.id=p.conversation_id left join messages m on m.organization_id=p.organization_id and m.id=p.message_id where p.organization_id=$1 order by p.created_at desc limit 5000",
        [org],
      ),
      db.query(
        "select id,name from ai_agents where organization_id=$1 and published_version_id is not null and archived_at is null and paused_at is null and operation_mode='automatic' order by name",
        [org],
      ),
      db.query(
        "select id,display_name,phone_number,provider,status from channel_sessions where organization_id=$1 and archived_at is null order by created_at",
        [org],
      ),
      db.query(
        "select s.id,s.name,s.pipeline_id,p.name as pipeline_name from crm_stages s join crm_pipelines p on p.id=s.pipeline_id and p.organization_id=s.organization_id where s.organization_id=$1 and not s.is_archived and not s.is_won and not s.is_lost order by p.name,s.position",
        [org],
      ),
    ]);
    return ok(
      {
        configured: !!settings.rows.length,
        campaigns: campaigns.rows,
        candidates: candidates.rows,
        agents: agents.rows,
        channels: channels.rows.filter((c) => {
          try {
            return capabilitiesOf(c.provider as ChannelProvider).freeformOutsideWindow;
          } catch {
            return false;
          }
        }),
        stages: stages.rows,
      },
      { requestId, headers },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(req: Request) {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "prospecting" });
  if (!auth.ok) return auth.response;
  const parsed = prospectingInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail(
      "validation_failed",
      "Confira os campos: público, região, limites e configuração da campanha.",
      422,
      { requestId, headers },
    );
  const body = parsed.data;
  const org = auth.org.orgId;
  try {
    const pool = getRequestPool();
    const admin = createAdminClient();
    let result: unknown;
    if (body.action === "configure") {
      await configureCredential(pool, admin, org, body.api_key);
      result = { configured: true };
    } else if (body.action === "search")
      result = await createSearch(pool, admin, org, body.request_id, body.search);
    else if (body.action === "start")
      result = await activateCampaign(pool, admin, org, body.id, body.config);
    else if (body.action === "pause") {
      // Pause does not wait for the worker lock; the delivery guard sees it before sending.
      const changed = await pool.query(
        "update prospecting_campaigns set status='paused',updated_at=now() where organization_id=$1 and id=$2 and status='running' returning id",
        [org, body.id],
      );
      if (!changed.rows.length)
        throw new ProspectingError("Campanha em execução não encontrada.", 404);
      result = { paused: true };
    } else {
      result = await withProspectingLock(pool, org, async (db) => {
        const c = (
          await db.query<Campaign>(
            "select * from prospecting_campaigns where organization_id=$1 and id=$2 and status='paused'",
            [org, body.id],
          )
        ).rows[0];
        if (!c?.config) throw new ProspectingError("Campanha pausada não encontrada.", 404);
        await validateConfig(db, org, c.config);
        if (
          (
            await db.query(
              "select id from prospecting_campaigns where organization_id=$1 and status='running'",
              [org],
            )
          ).rows.length
        )
          throw new ProspectingError("Pause a outra campanha antes de retomar.", 409);
        await db.query(
          "update prospecting_campaigns set status='running',error=null,next_send_at=greatest(next_send_at,now()+interval '1 minute'),updated_at=now() where organization_id=$1 and id=$2",
          [org, body.id],
        );
        return { resumed: true };
      });
    }
    const resourceId = "id" in body ? body.id : null;
    await audit({
      action: "prospecting.changed",
      organizationId: org,
      actorUserId: auth.user.id,
      resourceType: "prospecting",
      resourceId,
      metadata: { operation: body.action },
      requestId,
    });
    return ok(result, { requestId, headers });
  } catch (error) {
    return failure(error, requestId);
  }
}
