import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { processEvent } from "@/lib/routing/worker";
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => routingPgSupabase(pool).client,
}));
import { Pool } from "pg";
import {
  seedGov,
  GOV_ORG as org,
  GOV_ADMIN as adminUser,
  GOV_AGENT_A as a,
  GOV_AGENT_B as b,
  GOV_PIPELINE as pipeline,
  GOV_STAGE as stage,
  GOV_LEAD as lead,
  GOV_CONTACT_1 as contact,
  GOV_CONTACT_3 as contact2,
  GOV_SESSION as channel,
  GOV_CONV_UNASSIGNED as conv,
  GOV_CONV_CLAIM as conv2,
} from "./gov-helpers";
import { routingPgSupabase } from "../support/routing-pg-supabase";
import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { carregarPassagem, criarBancoDaEntrega } from "@/lib/escalacao/entrega/postgres";
import { consumirEntrega, comLockDoCanal } from "@/lib/escalacao/entrega/handler";
import type { DepsEntrega } from "@/lib/escalacao/entrega/passagem";
import type { EventRow } from "@/lib/event-log/dispatcher";
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 8,
});
const human = "cccccccc-5555-4000-8000-000000000099",
  lead2 = "cccccccc-6666-4000-8000-000000000099";
const config = {
  enabled: true,
  seller_user_ids: [a, b],
  seller_destinations: { [a]: "+5511000000001", [b]: "+5511000000002" },
  supervisor_destinations: ["+5511000000003"],
  retry_seconds: 60,
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
async function handoff(c = conv, ct = contact) {
  await performHumanHandoff(
    pool,
    { tenantId: org, leadId: ct, conversationId: c },
    {
      reason: "requested_human",
      conversationSummary: "Veículo escolhido, troca e pagamento informados",
      log,
      passagem: {
        origem: "ferramenta_do_modelo",
        motivoCodigo: "requested_human",
        briefing: {
          title: "Veículo escolhido",
          body: "Troca: veículo usado; pagamento: financiamento a confirmar",
          notes: null,
          content: null,
          tentativas: [],
        },
      },
    },
  );
}
function deps() {
  const admin = routingPgSupabase(pool);
  const d: DepsEntrega = {
    db: criarBancoDaEntrega(pool, admin.client),
    urlPublica: "https://crm.example.com",
    clock: () => new Date(),
    comLockDoCanal: (_o, ch, f) => comLockDoCanal(pool, ch, f),
    pacing: {
      decide: vi.fn(async () => ({ liberado: true as const })),
      registraEnvio: async (o, ch, n) => {
        await pool.query(
          "insert into pacing_ledger(organization_id,channel_session_id,sent_at) values($1,$2,$3)",
          [o, ch, n],
        );
      },
    },
    transporte: {
      configurado: async () => true,
      resolveDestino: async (_o, _c, p) => p,
      envia: vi.fn(async () => ({ externalId: "synthetic-ack" })),
    },
  };
  return { d, admin };
}
async function event(c = conv): Promise<EventRow> {
  return (
    await pool.query(
      "select ev.* from event_log ev join handoff_delivery_episodes e on e.organization_id=ev.organization_id and ev.entity_id=e.id where ev.organization_id=$1 and ev.event_type='ai.handoff_delivery' and e.conversation_id=$2 order by ev.created_at desc limit 1",
      [org, c],
    )
  ).rows[0];
}
beforeAll(() => seedGov());
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query("delete from handoff_delivery_episodes where organization_id=$1", [org]);
  await pool.query(
    "delete from event_log where organization_id=$1 and event_type='ai.handoff_delivery'",
    [org],
  );
  await pool.query("delete from passagens_de_atendimento where organization_id=$1", [org]);
  await pool.query("delete from conversation_assignment_events where organization_id=$1", [org]);
  await pool.query(
    "update organizations set settings=jsonb_set(settings,'{handoff_delivery}',$2) where id=$1",
    [org, JSON.stringify(config)],
  );
  await pool.query(
    "update contacts set force_human=false,handoff_delivery_revision=0 where organization_id=$1",
    [org],
  );
  await pool.query(
    "update conversations set assigned_to_user_id=null,assignee_kind=null,bot_silenced_until=null,status='ai_handling' where organization_id=$1",
    [org],
  );
  await pool.query("delete from channel_routing_policies where organization_id=$1", [org]);
  await pool.query(
    "update channel_sessions set status='WORKING',provider='waha',metadata='{}',archived_at=null where organization_id=$1 and id=$2",
    [org, channel],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Humano','chamar-humano',2000) on conflict(id) do nothing",
    [human, org, pipeline],
  );
  await pool.query("update crm_pipelines set settings='{}' where organization_id=$1", [org]);
  await pool.query(
    "update crm_leads set owner_user_id=null,status='open',stage_id=$2,contact_id=$3 where id=$1",
    [lead, stage, contact],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,contact_id) values($1,$2,$3,$4,'Outro cliente sintético',$5) on conflict(id) do update set owner_user_id=null,status='open',stage_id=$4",
    [lead2, org, pipeline, stage, contact2],
  );
  for (const user of [a, b])
    await pool.query(
      "insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule) values($1,$2,true,20,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=20,schedule='{}'",
      [org, user],
    );
});
describe("passagem real -> evento -> consumer -> atribuição/card -> recibos", () => {
  it("roteador nativo defere apenas episódio vigente e preserva legado sem episódio", async () => {
    const ev = {
      id: conv,
      organization_id: org,
      payload: { organization_id: org, conversation_id: conv },
      metadata: null,
      consumed_by: [],
      attempts: 0,
      claimed_at: new Date().toISOString(),
    };
    await handoff();
    expect(await processEvent(ev, new Date())).toBe("skipped_handoff_delivery");
    await pool.query("delete from handoff_delivery_episodes where organization_id=$1", [org]);
    expect(await processEvent(ev, new Date())).toBe("skipped_manual");
  });
  it("handoff repetido produz um episódio/evento e preserva pausa", async () => {
    await handoff();
    await handoff();
    expect(
      (
        await pool.query(
          "select count(*)::int n from handoff_delivery_episodes where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query("select force_human from contacts where id=$1", [contact])).rows[0]
        .force_human,
    ).toBe(true);
  });
  it("consumer real atribui Inbox/card, move etapa e entrega dois avisos sem repetir", async () => {
    await handoff();
    const e = await event();
    const { d, admin } = deps();
    expect((await consumirEntrega(pool, e, d)).status).toBe("ok");
    expect((await consumirEntrega(pool, e, d)).status).toBe("skipped");
    expect(d.transporte.envia).toHaveBeenCalledTimes(2);
    const r = (
      await pool.query(
        "select c.assigned_to_user_id,l.owner_user_id,l.stage_id,c.bot_silenced_until::text from conversations c join crm_leads l on l.contact_id=c.contact_id and l.organization_id=c.organization_id where c.id=$1",
        [conv],
      )
    ).rows[0];
    expect(r).toMatchObject({
      assigned_to_user_id: a,
      owner_user_id: a,
      stage_id: human,
      bot_silenced_until: "infinity",
    });
    expect(admin.errors).toEqual([]);
  });
  it("duas passagens concorrentes alternam A/B atomicamente e preservam dois cards", async () => {
    await Promise.all([handoff(), handoff(conv2, contact2)]);
    const db = criarBancoDaEntrega(pool, routingPgSupabase(pool).client);
    const ps = await Promise.all([
      carregarPassagem(pool, org, (await event()).entity_id!),
      carregarPassagem(pool, org, (await event(conv2)).entity_id!),
    ]);
    const rs = await Promise.all(ps.map((p) => db.atribuirMesmoResponsavel(p!, [a, b])));
    expect(rs.map((r) => r.status)).toEqual(["assigned", "assigned"]);
    const rows = (
      await pool.query(
        "select c.assigned_to_user_id,l.owner_user_id from conversations c join crm_leads l on l.organization_id=c.organization_id and l.contact_id=c.contact_id where c.id=any($1)",
        [[conv, conv2]],
      )
    ).rows;
    expect(rows.map((r) => r.owner_user_id).sort()).toEqual([a, b].sort());
    expect(rows.every((r) => r.owner_user_id === r.assigned_to_user_id)).toBe(true);
  });
  it("timeout deixa recibos ambíguos e replay não chama canal", async () => {
    await handoff();
    const e = await event();
    const { d } = deps();
    vi.mocked(d.transporte.envia).mockRejectedValue(new Error("timeout"));
    expect((await consumirEntrega(pool, e, d)).status).toBe("error");
    await consumirEntrega(pool, e, d);
    expect(d.transporte.envia).toHaveBeenCalledTimes(2);
    expect(
      (
        await pool.query(
          "select count(*)::int n from handoff_delivery_receipts where organization_id=$1 and status='ambiguous'",
          [org],
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("retorno explícito à IA invalida episódio velho e cria nova geração", async () => {
    await handoff();
    const old = await event();
    await pool.query("update contacts set force_human=false where id=$1", [contact]);
    await pool.query("update conversations set bot_silenced_until=null where id=$1", [conv]);
    expect((await consumirEntrega(pool, old, deps().d)).status).toBe("skipped");
    await handoff();
    expect(
      (
        await pool.query(
          "select count(*)::int n from handoff_delivery_episodes where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("config desativada não emite evento nem atribui", async () => {
    await pool.query(
      "update organizations set settings=jsonb_set(settings,'{handoff_delivery,enabled}','false') where id=$1",
      [org],
    );
    await handoff();
    expect(
      (
        await pool.query(
          "select count(*)::int n from handoff_delivery_episodes where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("falha do card faz rollback também do Inbox e do rodízio", async () => {
    await handoff();
    const e = await event();
    const p = await carregarPassagem(pool, org, e.entity_id!);
    await pool.query(
      "create function test_db.fail_card() returns trigger language plpgsql as $$begin if new.owner_user_id is distinct from old.owner_user_id then raise exception 'synthetic_card_failure';end if;return new;end;$$; create trigger fail_card before update on crm_leads for each row execute function test_db.fail_card()",
    );
    try {
      await expect(
        criarBancoDaEntrega(pool, routingPgSupabase(pool).client).atribuirMesmoResponsavel(p!, [
          a,
          b,
        ]),
      ).rejects.toThrow("synthetic_card_failure");
      expect(
        (await pool.query("select assigned_to_user_id from conversations where id=$1", [conv]))
          .rows[0].assigned_to_user_id,
      ).toBeNull();
      expect(
        (await pool.query("select owner_user_id from crm_leads where id=$1", [lead])).rows[0]
          .owner_user_id,
      ).toBeNull();
    } finally {
      await pool.query("drop trigger fail_card on crm_leads;drop function test_db.fail_card()");
    }
  });
  it("transferência humana durante resolução cancela aviso ao anterior", async () => {
    await handoff();
    const e = await event();
    const { d } = deps();
    d.transporte.resolveDestino = async (_o, _c, p) => {
      await pool.query("update conversations set assigned_to_user_id=$2 where id=$1", [conv, b]);
      await pool.query("update crm_leads set owner_user_id=$2 where id=$1", [lead, b]);
      return p;
    };
    expect((await consumirEntrega(pool, e, d)).status).toBe("skipped");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("anonimização apaga episódio e recibos sem deixar aviso pronto", async () => {
    await handoff();
    await consumirEntrega(pool, await event(), deps().d);
    await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [
      contact,
    ]);
    expect(
      (
        await pool.query(
          "select count(*)::int n from handoff_delivery_episodes where contact_id=$1",
          [contact],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "select count(*)::int n from handoff_delivery_receipts where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
    await pool.query("update contacts set is_anonymized=false,anonymized_at=null where id=$1", [
      contact,
    ]);
  });
  it("IDs de outra organização não leem nem consomem passagem alheia", async () => {
    const other = "aaaaaaaa-2222-4000-8000-000000000099";
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name,settings) values($1,'handoff-other','Outra sintética','Outra sintética',$2) on conflict(id) do update set settings=$2",
      [other, JSON.stringify(config)],
    );
    await handoff();
    const e = await event();
    expect(await carregarPassagem(pool, other, e.entity_id!)).toBeNull();
    const { d } = deps();
    await consumirEntrega(pool, { ...e, organization_id: other }, d);
    expect(d.transporte.envia).not.toHaveBeenCalled();
    expect(
      (await pool.query("select assigned_to_user_id from conversations where id=$1", [conv]))
        .rows[0].assigned_to_user_id,
    ).toBeNull();
  });
  it("RPC nativa persiste repasse sem telefone e preserva exigência de telefone no default", async () => {
    const c = await pool.connect();
    const cfg = {
      ...config,
      seller_user_ids: [a],
      seller_destinations: {},
      supervisor_destinations: [],
      notifications_enabled: false,
    };
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: adminUser, aal: "aal2" }),
      ]);
      expect(
        (await c.query("select fn_set_handoff_delivery($1,$2) value", [org, JSON.stringify(cfg)]))
          .rows[0].value,
      ).toMatchObject({ notifications_enabled: false, seller_destinations: {} });
      expect(
        (
          await c.query(
            "select settings->'handoff_delivery' value from organizations where id=$1",
            [org],
          )
        ).rows[0].value.notifications_enabled,
      ).toBe(false);
      await c.query("savepoint invalid");
      const { notifications_enabled: ignored, ...legacy } = cfg;
      void ignored;
      await expect(
        c.query("select fn_set_handoff_delivery($1,$2)", [org, JSON.stringify(legacy)]),
      ).rejects.toThrow("handoff_destination_missing");
      await c.query("rollback to savepoint invalid");
      await expect(
        c.query("select fn_set_handoff_delivery($1,$2)", [
          org,
          JSON.stringify({ ...cfg, notifications_enabled: "false" }),
        ]),
      ).rejects.toThrow("handoff_config_invalid");
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
  it("RPC de configuração recusa usuário externo ao tenant sem mudar configuração", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: "00000000-0000-4000-8000-000000000001" }),
      ]);
      await expect(
        c.query("select fn_set_handoff_delivery($1,$2)", [org, JSON.stringify(config)]),
      ).rejects.toThrow();
      await c.query("rollback");
    } finally {
      c.release();
    }
    expect(
      (
        await pool.query(
          "select settings->'handoff_delivery' value from organizations where id=$1",
          [org],
        )
      ).rows[0].value.enabled,
    ).toBe(true);
  });
  it("autenticado não grava episódios/recibos e outsider não lê", async () => {
    await handoff();
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: "00000000-0000-4000-8000-000000000001" }),
      ]);
      expect((await c.query("select * from handoff_delivery_episodes")).rows).toEqual([]);
      await expect(
        c.query("update handoff_delivery_episodes set status='delivered'"),
      ).rejects.toThrow(/permission denied/);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
});

it("atribuição pós-IA sem telefone nem avisos usa consumer real e não toca transporte", async () => {
  const cfg = {
    ...config,
    seller_user_ids: [a],
    seller_destinations: {},
    supervisor_destinations: [],
    notifications_enabled: false,
  };
  await pool.query(
    "update organizations set settings=jsonb_set(settings,'{handoff_delivery}',$2) where id=$1",
    [org, JSON.stringify(cfg)],
  );
  await handoff();
  const e = await event();
  const { d } = deps();
  vi.mocked(d.transporte.envia).mockRejectedValue(Error("external_effect_forbidden"));
  expect(await consumirEntrega(pool, e, d)).toMatchObject({
    status: "ok",
    detail: "notifications_disabled",
  });
  expect((await consumirEntrega(pool, e, d)).status).toBe("skipped");
  expect(d.transporte.envia).not.toHaveBeenCalled();
  const row = (
    await pool.query(
      "select c.assigned_to_user_id,l.owner_user_id,c.bot_silenced_until::text,ct.force_human from conversations c join contacts ct on ct.id=c.contact_id and ct.organization_id=c.organization_id join crm_leads l on l.contact_id=c.contact_id and l.organization_id=c.organization_id where c.organization_id=$1 and c.id=$2",
      [org, conv],
    )
  ).rows[0];
  expect(row).toMatchObject({
    assigned_to_user_id: a,
    owner_user_id: a,
    bot_silenced_until: "infinity",
    force_human: true,
  });
  expect(
    (
      await pool.query(
        "select count(*)::int n from handoff_delivery_receipts where organization_id=$1",
        [org],
      )
    ).rows[0].n,
  ).toBe(0);
});
