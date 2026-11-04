import { readServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { tentativaDaPassagemSchema } from "../passagem";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";
import { isWithinSchedule } from "@/lib/routing/eligibility";
import { moverLeadParaEtapaDeHandoff } from "@/lib/leads/handoff-stage-move";

import type { Atribuicao, BancoDaEntrega, ClaimAviso, PassagemParaEntrega } from "./passagem";

// Guarda compatível com instalação anterior ao helper global de canais.
const canalDesativado = (metadata: unknown): boolean =>
  metadata !== null &&
  typeof metadata === "object" &&
  (metadata as Record<string, unknown>).disabled === true;
export async function carregarPassagem(
  pool: pg.Pool,
  org: string,
  id: string,
): Promise<PassagemParaEntrega | null> {
  const { rows } = await pool.query(
    `select e.*, p.title, p.notes, p.tentativas, ct.name as contact_name, ct.phone_number as contact_phone
     from handoff_delivery_episodes e
     join passagens_de_atendimento p on p.organization_id=e.organization_id and p.id=e.passage_id
     join contacts ct on ct.organization_id=e.organization_id and ct.id=e.contact_id
     where e.organization_id=$1 and e.id=$2 and ct.anonymized_at is null`,
    [org, id],
  );
  const e = rows[0];
  if (!e) return null;
  // Só campos da passagem atual e identidade do cadastro tenant-scoped.
  // Não buscar transcript/áudio. O formatter saneia campos antes do transporte.
  const tentativas = (Array.isArray(e.tentativas) ? e.tentativas : []).flatMap((raw: unknown) => {
    const t = tentativaDaPassagemSchema.safeParse(raw);
    return t.success ? [`${t.data.o_que}${t.data.desfecho ? ` → ${t.data.desfecho}` : ""}`] : [];
  });
  return {
    organizationId: org,
    episodeId: id,
    conversationId: e.conversation_id,
    leadId: e.lead_id ?? "",
    serviceRevision: Number(e.service_revision),
    resumo: {
      nome: e.contact_name ?? undefined,
      telefone: e.contact_phone ?? undefined,
      interesse: e.title ?? undefined,
      tentativas,
      ultimasPalavras: e.notes ?? undefined,
    },
  };
}
const vigenteSQL = `select e.id from handoff_delivery_episodes e
 join conversations c on c.organization_id=e.organization_id and c.id=e.conversation_id
 join contacts ct on ct.organization_id=e.organization_id and ct.id=e.contact_id
 where e.organization_id=$1 and e.id=$2 and c.service_revision=e.service_revision
 and exists(select 1 from organizations o where o.id=e.organization_id and o.status='active' and o.settings->'handoff_delivery'->>'enabled'='true' and md5((o.settings->'handoff_delivery')::text)=e.config_hash)
 and ct.handoff_delivery_revision=e.handoff_revision and ct.force_human and ct.anonymized_at is null
 and c.bot_silenced_until='infinity'::timestamptz and c.status in('open','pending','claimed','ai_handling')`;
const ownerSQL =
  vigenteSQL +
  ` and c.assigned_to_user_id=$3 and e.owner_user_id=$3
 and exists(select 1 from crm_leads l where l.organization_id=e.organization_id and l.id=e.lead_id and l.owner_user_id=$3 and l.status='open')`;
async function transaction<T>(
  pool: pg.Pool,
  action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local lock_timeout='3s'; set local statement_timeout='5s'");
    const r = await action(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export function criarBancoDaEntrega(pool: pg.Pool, admin: SupabaseClient): BancoDaEntrega {
  return {
    async identidadeDoResponsavel(p, owner) {
      const sql =
        ownerSQL.replace(
          "select e.id",
          `select c.assigned_to_user_name as nome,
        (select o.display_name from organizations o where o.id=e.organization_id) as empresa`,
        ) +
        ` and exists(select 1 from user_organizations u where u.organization_id=e.organization_id
          and u.user_id=$3 and u.revoked_at is null)`;
      const row = (await pool.query(sql, [p.organizationId, p.episodeId, owner])).rows[0];
      return row ? { nome: row.nome ?? undefined, empresa: row.empresa ?? undefined } : null;
    },
    async passagemVigente(p) {
      return (await pool.query(vigenteSQL, [p.organizationId, p.episodeId])).rowCount === 1;
    },
    async responsavelVigente(p, owner) {
      return (await pool.query(ownerSQL, [p.organizationId, p.episodeId, owner])).rowCount === 1;
    },
    async atribuirMesmoResponsavel(p, sellers): Promise<Atribuicao> {
      return transaction(pool, async (c) => {
        // Serializa o pool ANTES de ler histórico/selecionar. Replays não avançam rodízio.
        await c.query(
          "select pg_advisory_xact_lock(hashtextextended($1||':handoff-delivery',594))",
          [p.organizationId],
        );
        const e = (
          await c.query(
            "select * from handoff_delivery_episodes where organization_id=$1 and id=$2 for update",
            [p.organizationId, p.episodeId],
          )
        ).rows[0];
        if (!e) return { status: "stale" };
        await c.query("select fn_service_lock($1,$2)", [p.organizationId, e.contact_id]);
        if ((await c.query(vigenteSQL, [p.organizationId, p.episodeId])).rowCount !== 1)
          return { status: "stale" };
        await c.query(
          "select id from channel_sessions where organization_id=$1 and id=(select channel_session_id from conversations where organization_id=$1 and id=$2) for share",
          [p.organizationId, p.conversationId],
        );
        const conv = (
          await c.query(
            "select * from conversations where organization_id=$1 and id=$2 for no key update",
            [p.organizationId, p.conversationId],
          )
        ).rows[0];
        const leads = (
          await c.query(
            `select l.* from crm_leads l join crm_stages s on s.id=l.stage_id and s.pipeline_id=l.pipeline_id where l.organization_id=$1 and l.contact_id=$2 and l.status='open' and exists(select 1 from crm_stages hs where hs.pipeline_id=l.pipeline_id and hs.slug in('chamar-humano','chamar_humano') and not hs.is_archived) order by l.id for update of l`,
            [p.organizationId, e.contact_id],
          )
        ).rows;
        const lead = e.lead_id
          ? leads.find((l) => l.id === e.lead_id)
          : leads.length === 1
            ? leads[0]
            : null;
        if (!lead) return { status: "missing_lead" };
        if (e.owner_user_id) {
          if (
            conv.assigned_to_user_id !== e.owner_user_id ||
            lead.owner_user_id !== e.owner_user_id
          )
            return { status: "conflict" };
          p.leadId = lead.id;
          return { status: "assigned", userId: e.owner_user_id };
        }
        // Uma devolução explícita libera o Inbox, mas mantém o dono comercial
        // do card. Na segunda passagem, retome ESSE dono — sem novo rodízio.
        // Os locks acima estabilizam episódio, conversa e card; o claim nativo
        // revalida elegibilidade/capacidade e grava a atribuição do Inbox.
        if (conv.assigned_to_user_id) return { status: "conflict" };
        if (lead.owner_user_id) {
          const owner = lead.owner_user_id as string;
          if (!sellers.includes(owner)) return { status: "conflict" };
          const eligible = (
            await c.query(
              `select a.schedule from attendant_availability a
             join user_organizations u on u.organization_id=a.organization_id and u.user_id=a.user_id
             where a.organization_id=$1 and a.user_id=$2 and a.is_available
               and u.revoked_at is null and u.role in('agent','manager','admin')
               and (select count(*) from conversations cc where cc.organization_id=$1
                 and cc.assigned_to_user_id=$2 and cc.status in('open','pending','claimed','ai_handling')) < a.capacity`,
              [p.organizationId, owner],
            )
          ).rows[0];
          if (
            !eligible ||
            !isWithinSchedule(availabilityScheduleSchema.parse(eligible.schedule ?? {}), new Date())
          )
            return { status: "no_eligible" };
          const claimed = (
            await c.query("select fn_channel_routing_claim($1,$2,$3,$4,$5::jsonb,$6) result", [
              p.organizationId,
              p.conversationId,
              conv.channel_session_id,
              owner,
              JSON.stringify(eligible.schedule ?? {}),
              "handoff",
            ])
          ).rows[0]?.result;
          if (claimed === "conversation_changed" || claimed === "already_assigned")
            return { status: "conflict" };
          if (claimed !== "assigned") return { status: "no_eligible" };
          const saved = await c.query(
            `update handoff_delivery_episodes e set lead_id=$3,owner_user_id=$4,updated_at=now()
             where e.organization_id=$1 and e.id=$2 and e.owner_user_id is null
             and exists(select 1 from crm_leads l where l.organization_id=$1 and l.id=$3
               and l.status='open' and l.owner_user_id=$4)
             and exists(select 1 from conversations cv where cv.organization_id=$1
               and cv.id=$5 and cv.assigned_to_user_id=$4) returning e.id`,
            [p.organizationId, p.episodeId, lead.id, owner, p.conversationId],
          );
          if (saved.rowCount !== 1) throw new Error("handoff_return_conflict");
          p.leadId = lead.id;
          return { status: "assigned", userId: owner };
        }
        const { rows: candidates } = await c.query(
          `select a.user_id,a.schedule,
     (select max(ev.created_at) from conversation_assignment_events ev join conversations hc on hc.organization_id=ev.organization_id and hc.id=ev.conversation_id where ev.organization_id=$1 and ev.to_user_id=a.user_id and hc.channel_session_id=$3) last_at
     from attendant_availability a join user_organizations u on u.organization_id=a.organization_id and u.user_id=a.user_id
     where a.organization_id=$1 and a.user_id=any($2::uuid[]) and a.is_available and u.revoked_at is null and u.role in('agent','manager','admin')
     and (select count(*) from conversations cc where cc.organization_id=$1 and cc.assigned_to_user_id=a.user_id and cc.status in('open','pending','claimed','ai_handling')) < a.capacity
     order by last_at nulls first,a.user_id`,
          [p.organizationId, sellers, conv.channel_session_id],
        );
        for (const candidate of candidates) {
          // Reusa jornada publicada; não cria janela própria nem bloqueio depois das22h.
          if (
            !isWithinSchedule(
              availabilityScheduleSchema.parse(candidate.schedule ?? {}),
              new Date(),
            )
          )
            continue;
          const r = (
            await c.query("select fn_channel_routing_claim($1,$2,$3,$4,$5::jsonb,$6) result", [
              p.organizationId,
              p.conversationId,
              conv.channel_session_id,
              candidate.user_id,
              JSON.stringify(candidate.schedule ?? {}),
              "handoff",
            ])
          ).rows[0]?.result;
          if (r === "assigned") {
            const updated = await c.query(
              "update crm_leads set owner_user_id=$3,assigned_at=now() where organization_id=$1 and id=$2 and status='open' and owner_user_id is null returning id",
              [p.organizationId, lead.id, candidate.user_id],
            );
            if (updated.rowCount !== 1) throw new Error("handoff_card_conflict"); // rollback inclui Inbox/native claim
            await c.query(
              "update handoff_delivery_episodes set lead_id=$3,owner_user_id=$4,updated_at=now() where organization_id=$1 and id=$2",
              [p.organizationId, p.episodeId, lead.id, candidate.user_id],
            );
            p.leadId = lead.id;
            return { status: "assigned", userId: candidate.user_id };
          }
          if (r === "conversation_changed" || r === "already_assigned")
            return { status: "conflict" };
        }
        return { status: "no_eligible" };
      });
    },
    async moverParaHumano(p, owner) {
      if (!(await pool.query(ownerSQL, [p.organizationId, p.episodeId, owner])).rowCount)
        return false;
      const valid = (
        await pool.query(
          "select 1 from crm_leads l join crm_stages s on s.pipeline_id=l.pipeline_id and s.organization_id=l.organization_id where l.organization_id=$1 and l.id=$2 and s.slug in('chamar-humano','chamar_humano') and not s.is_archived and not s.is_won and not s.is_lost",
          [p.organizationId, p.leadId],
        )
      ).rowCount;
      if (!valid) return false;
      const boundary = await readServiceBoundarySupabase(admin, p.organizationId, p.conversationId);
      if (!boundary || boundary.service_revision !== p.serviceRevision) return false;
      const r = await moverLeadParaEtapaDeHandoff(admin, {
        serviceBoundary: boundary,
        organizationId: p.organizationId,
        leadId: p.leadId,
        reason: "handoff_delivery",
        expectedOwnerId: owner,
      });
      return r.moveu || r.motivo === "ja_esta_la";
    },
    async canalDaConversa(p) {
      const row = (
        await pool.query(
          `select s.id,s.status,s.archived_at,s.provider,s.metadata from channel_sessions s join conversations c on c.organization_id=s.organization_id and c.channel_session_id=s.id where c.organization_id=$1 and c.id=$2`,
          [p.organizationId, p.conversationId],
        )
      ).rows[0];
      if (!row) return null;
      const { capabilitiesOf, transportaMensagem } = await import("@/lib/channels/capabilities");
      return {
        id: row.id,
        status: row.status,
        archived_at: row.archived_at,
        desativado: canalDesativado(row.metadata),
        aceitaMensagemLivre:
          transportaMensagem(row.provider) && capabilitiesOf(row.provider).freeformOutsideWindow,
      };
    },
    async destinoDaOrganizacao(org, phone) {
      const digits = phone.replace(/\D/g, "");
      const r = await pool.query(
        "select 1 from channel_sessions where organization_id=$1 and regexp_replace(coalesce(phone_number,''),'[^0-9]','','g')=any($2::text[]) limit 1",
        [
          org,
          [
            digits,
            digits.length === 13
              ? digits.slice(0, 4) + digits.slice(5)
              : digits.length === 12
                ? digits.slice(0, 4) + "9" + digits.slice(4)
                : digits,
          ],
        ],
      );
      return r.rowCount === 1;
    },
    async reivindicarAviso(p, hash): Promise<ClaimAviso> {
      return transaction(pool, async (c) => {
        const owner = (
          await c.query(
            "select owner_user_id from handoff_delivery_episodes where organization_id=$1 and id=$2 for update",
            [p.organizationId, p.episodeId],
          )
        ).rows[0]?.owner_user_id;
        if (
          !owner ||
          (await c.query(ownerSQL, [p.organizationId, p.episodeId, owner])).rowCount !== 1
        )
          return { status: "cancelled" };
        await c.query(
          "insert into handoff_delivery_receipts(organization_id,episode_id,destination_hash) values($1,$2,$3) on conflict do nothing",
          [p.organizationId, p.episodeId, hash],
        );
        const r = (
          await c.query(
            "select * from handoff_delivery_receipts where organization_id=$1 and episode_id=$2 and destination_hash=$3 for update",
            [p.organizationId, p.episodeId, hash],
          )
        ).rows[0];
        if (["delivered", "ambiguous", "cancelled"].includes(r.status)) return { status: r.status };
        if (r.claimed_at && Date.now() - new Date(r.claimed_at).getTime() < 300000)
          return { status: "busy" };
        if (r.status === "requested") {
          await c.query(
            "update handoff_delivery_receipts set status='ambiguous',updated_at=now() where id=$1",
            [r.id],
          );
          return { status: "ambiguous" };
        }
        const token = randomUUID();
        await c.query(
          "update handoff_delivery_receipts set claim_token=$2,claimed_at=now(),updated_at=now() where id=$1",
          [r.id, token],
        );
        return { status: "claimed", claimId: token };
      });
    },
    async marcaTentativa(p, token) {
      const r = await pool.query(
        `update handoff_delivery_receipts r set status='requested',updated_at=now() where r.organization_id=$1 and r.episode_id=$2 and r.claim_token=$3 and r.status='planned' and exists(${ownerSQL.replaceAll("$3", "$4")}) returning r.id`,
        [
          p.organizationId,
          p.episodeId,
          token,
          (
            await pool.query(
              "select owner_user_id from handoff_delivery_episodes where organization_id=$1 and id=$2",
              [p.organizationId, p.episodeId],
            )
          ).rows[0]?.owner_user_id,
        ],
      );
      if (r.rowCount !== 1) throw new Error("handoff_delivery_claim_lost");
    },
    async concluirAviso(p, token, status, external) {
      const r = await pool.query(
        "update handoff_delivery_receipts set status=$4,external_id=$5,updated_at=now() where organization_id=$1 and episode_id=$2 and claim_token=$3 and status='requested' returning id",
        [p.organizationId, p.episodeId, token, status, external],
      );
      if (r.rowCount !== 1) throw new Error("handoff_delivery_receipt_lost");
    },
  };
}
