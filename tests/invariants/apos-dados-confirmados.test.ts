import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  iniciarAposDadosConfirmados,
  EVENTO_DADOS_CONFIRMADOS,
} from "@/lib/followup/apos-dados-confirmados";
import { readCurrentServiceBoundary } from "@/lib/atendimento/fronteira-server";
import type { EventRow } from "@/lib/event-log/dispatcher";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const organizations: string[] = [];
let org: string,
  contact: string,
  conversation: string,
  purchase: string,
  pointer: string,
  version: string,
  caseId: string,
  job: string,
  decision: string;
let event: EventRow;
const graph = {
  nodes: [
    { id: "start", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: "end",
      type: "end",
      label: "Fim",
      position: { x: 0, y: 100 },
      config: { outcome: "exhausted" },
    },
  ],
  edges: [{ id: "e", source: "start", target: "end", priority: 0, condition: { type: "always" } }],
};

beforeEach(async () => {
  [org, contact, conversation, purchase, pointer, version, caseId, job, decision] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  organizations.push(org);
  const channel = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Dados confirmados','Dados confirmados')",
    [org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2::uuid,$1::text,'\\x00'::bytea)",
    [channel, org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Contato teste')",
    [contact, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, org, contact, channel],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Vendas','vendas')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Pagamento','pagamento',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5,'Compra teste')",
    [purchase, org, pipeline, stage, contact],
  );
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, org, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,'Após dados','active',$3)",
    [pointer, org, version],
  );
  const boundary = await readCurrentServiceBoundary(pool, org, conversation);
  await pool.query(
    `insert into agent_cases(id,organization_id,conversation_id,lead_id,status,source,title,summary,blocker,task_kind,task_state,wait_generation,context_snapshot,task_payload)
    values($1,$2,$3,$4,'resolved','agent','Dados','Dados enviados','Dados oficiais','payment_details','completed',1,$5,$6)`,
    [
      caseId,
      org,
      conversation,
      purchase,
      { service_boundary: boundary },
      { decision: "details_release", post_delivery_pointer_id: pointer },
    ],
  );
  await pool.query(
    "insert into agent_case_events(id,organization_id,case_id,kind,actor_kind) values($1,$2,$3,'agent_noted','system')",
    [decision, org, caseId],
  );
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,payload,status) values($1,$2,$3,'case_reply_turn',$4,'done')",
    [job, org, contact, { case_id: caseId, action: "task_delivery", service_boundary: boundary }],
  );
  await pool.query(
    "update agent_cases set decision_event_id=$3,delivery_job_id=$4 where organization_id=$1 and id=$2",
    [org, caseId, decision, job],
  );
  await pool.query(
    "insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status) values($1,$2,$3,1,$4,'accepted')",
    [org, contact, job, "a".repeat(64)],
  );
  event = {
    id: randomUUID(),
    organization_id: org,
    event_type: EVENTO_DADOS_CONFIRMADOS,
    entity_kind: "agent_case",
    entity_id: caseId,
    payload: {
      case_id: caseId,
      task_generation: 1,
      decision_event_id: decision,
      delivery_job_id: job,
      post_delivery_pointer_id: pointer,
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
  };
});
afterAll(async () => {
  await pool.query("delete from organizations where id=any($1::uuid[])", [organizations]);
  await pool.end();
});
const consume = () => iniciarAposDadosConfirmados(pool, event);
const count = async () =>
  Number(
    (
      await pool.query(
        "select count(*)::int n from followup_enrollments where organization_id=$1",
        [org],
      )
    ).rows[0].n,
  );

describe("matrícula após entrega oficial confirmada", () => {
  it("pina versão publicada e fronteira; retry após fluxo terminar não rematricula", async () => {
    expect(await consume()).toEqual({
      enrolled: true,
      reason: "matriculado_apos_envio_confirmado",
    });
    const { rows } = await pool.query(
      "select version_id,service_boundary,conversation_id from followup_enrollments where organization_id=$1",
      [org],
    );
    expect(rows[0].version_id).toBe(version);
    expect(rows[0].conversation_id).toBe(conversation);
    expect(rows[0].service_boundary.conversation_id).toBe(conversation);
    await pool.query(
      "update followup_enrollments set status='completed',next_eval_at=null where organization_id=$1",
      [org],
    );
    expect((await consume()).reason).toBe("ja_processado");
    expect(await count()).toBe(1);
    event.id = randomUUID();
    expect((await consume()).reason).toBe("ja_processado");
    expect(await count()).toBe(1);
  });
  it("duas instâncias gravam uma matrícula e um recibo", async () => {
    const results = await Promise.all([consume(), consume()]);
    expect(results.filter((r) => r.enrolled)).toHaveLength(1);
    expect(await count()).toBe(1);
  });
  it.each(["task_generation", "decision_event_id", "delivery_job_id", "post_delivery_pointer_id"])(
    "recusa evento que diverge da fonte: %s",
    async (field) => {
      event.payload[field] = field === "task_generation" ? 2 : randomUUID();
      expect((await consume()).enrolled).toBe(false);
      expect(await count()).toBe(0);
    },
  );
  it("não inicia sem recibo accepted nem com fluxo desativado", async () => {
    await pool.query(
      "update send_ledger set status='requested' where organization_id=$1 and job_id=$2",
      [org, job],
    );
    expect((await consume()).reason).toBe("envio_sem_recibo_confirmado");
    await pool.query(
      "update send_ledger set status='accepted' where organization_id=$1 and job_id=$2",
      [org, job],
    );
    await pool.query(
      "update followup_flow_pointers set status='disabled' where organization_id=$1 and id=$2",
      [org, pointer],
    );
    expect((await consume()).reason).toBe("fluxo_nao_publicado");
    expect(await count()).toBe(0);
  });
  it("resposta da cliente anterior ao consumo cancela a intenção de retomada", async () => {
    const channel = (
      await pool.query(
        "select channel_session_id from conversations where id=$1 and organization_id=$2",
        [conversation, org],
      )
    ).rows[0].channel_session_id;
    await pool.query(
      `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
      values($1,$2,$3,$4,'text','inbound','received','ai','Resposta teste',$5::timestamptz+interval '1 second')`,
      [org, conversation, channel, contact, event.created_at],
    );
    expect((await consume()).reason).toBe("cliente_ja_respondeu");
    expect(await count()).toBe(0);
  });
  it("conferência aberta impede cobrança e compra fechada também", async () => {
    const review = randomUUID();
    await pool.query(
      `insert into agent_cases(id,organization_id,conversation_id,lead_id,status,source,title,summary,blocker,task_kind,task_state)
      values($1,$2,$3,$4,'awaiting_human','agent','Conferência','Conferir','Recebimento','payment_review','awaiting_human')`,
      [review, org, conversation, purchase],
    );
    expect((await consume()).reason).toBe("conferencia_pendente");
    await pool.query(
      "update agent_cases set task_state='completed',status='resolved' where organization_id=$1 and id=$2",
      [org, review],
    );
    await pool.query(
      "update crm_leads set status='won',closed_at=now() where organization_id=$1 and id=$2",
      [org, purchase],
    );
    expect((await consume()).reason).toBe("compra_encerrada");
    expect(await count()).toBe(0);
  });
  it("epoch de atendimento trocado não usa uma fronteira atual inventada", async () => {
    await pool.query(
      "update conversations set service_revision=service_revision+1 where organization_id=$1 and id=$2",
      [org, conversation],
    );
    expect((await consume()).reason).toBe("origem_obsoleta");
    expect(await count()).toBe(0);
  });
  it.each(["completed", "send_failed"])(
    "decisão financeira durável impede evento atrasado mesmo com tarefa %s",
    async (state) => {
      const review = randomUUID();
      await pool.query(
        `insert into agent_cases(id,organization_id,conversation_id,lead_id,status,source,title,summary,blocker,task_kind,task_state,task_payload)
        values($1,$2,$3,$4,$5,'agent','Conferência','Conferir','Recebimento','payment_review',$6,$7)`,
        [
          review,
          org,
          conversation,
          purchase,
          state === "completed" ? "resolved" : "awaiting_human",
          state,
          { decision: "payment_confirmed" },
        ],
      );
      await pool.query(
        `insert into agent_case_events(organization_id,case_id,kind,actor_kind,metadata)
        values($1,$2,'human_replied','human',$3)`,
        [
          org,
          review,
          {
            task_action: "payment_confirmed",
            result: "payment_confirmed",
            lead_id: purchase,
            conversation_id: conversation,
          },
        ],
      );
      if (state === "completed")
        await pool.query(
          "update agent_cases set task_payload='{}'::jsonb where organization_id=$1 and id=$2",
          [org, review],
        );
      expect((await consume()).reason).toBe("pagamento_confirmado_pela_equipe");
      expect(await count()).toBe(0);
    },
  );
  it("confirmação de outra compra não cancela a matrícula desta compra", async () => {
    const unrelated = randomUUID();
    await pool.query(
      `insert into agent_case_events(organization_id,case_id,kind,actor_kind,metadata)
      values($1,$2,'human_replied','human',$3)`,
      [
        org,
        caseId,
        { task_action: "payment_confirmed", lead_id: unrelated, conversation_id: conversation },
      ],
    );
    expect((await consume()).enrolled).toBe(true);
    expect(await count()).toBe(1);
  });
});
