import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyCaseTaskAction,
  openPaymentTask,
  readCaseTask,
} from "@/lib/agent-engine/agent/case-task";
import { encerrarChamadoPeloAgente } from "@/lib/agent-engine/agent/human-cases";
import {
  seedGov,
  sql,
  GOV_ORG,
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_PIPELINE,
  GOV_STAGE,
} from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const purchase = randomUUID();
let id: string;
const input = {
  task_kind: "payment_details" as const,
  title: "Dados oficiais",
  summary: "Cliente escolheu Pix",
  blocker: "Equipe precisa liberar os dados",
};

beforeAll(async () => {
  seedGov();
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5,'Compra desta cliente')",
    [purchase, GOV_ORG, GOV_PIPELINE, GOV_STAGE, GOV_CONTACT_1],
  );
});
beforeEach(async () => {
  await pool.query("delete from job_queue where organization_id=$1", [GOV_ORG]);
  await pool.query("delete from agent_cases where organization_id=$1", [GOV_ORG]);
  await pool.query("update contacts set is_anonymized=false where id=$1", [GOV_CONTACT_1]);
  id = await openPaymentTask(
    pool,
    { tenantId: GOV_ORG, conversationId: GOV_CONV_UNASSIGNED },
    input,
  );
});
afterAll(async () => {
  await pool.end();
});
const read = () => readCaseTask(pool, GOV_ORG, id);
async function assume(actor = GOV_AGENT_A) {
  const row = (await read())!;
  return applyCaseTaskAction(pool, GOV_ORG, id, actor, {
    action: "assume",
    expected_revision: row.revision,
  });
}

describe("pagamento exige autoridade, compra e decisão duráveis", () => {
  it("liga a compra e protege a tarefa contra alteração direta de membro", async () => {
    expect((await read())?.lead_id).toBe(purchase);
    expect(() =>
      sql(
        `set role authenticated; select set_config('request.jwt.claims','{"sub":"${GOV_AGENT_A}"}',false); update agent_cases set task_state='completed' where id='${id}';`,
      ),
    ).toThrow();
    expect((await read())?.task_state).toBe("awaiting_human");
  });

  it("duas pessoas não conseguem assumir a mesma revisão", async () => {
    const revision = (await read())!.revision;
    const results = await Promise.allSettled(
      [GOV_AGENT_A, GOV_AGENT_B].map((actor) =>
        applyCaseTaskAction(pool, GOV_ORG, id, actor, {
          action: "assume",
          expected_revision: revision,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await read())!.revision).toBe(revision + 1);
  });

  it("gestor pode recuperar a responsabilidade sem reiniciar o prazo", async () => {
    await assume();
    const before = (await read())!;
    await expect(
      applyCaseTaskAction(pool, GOV_ORG, id, GOV_AGENT_B, {
        action: "takeover",
        expected_revision: before.revision,
      }),
    ).rejects.toThrow();
    const after = await applyCaseTaskAction(
      pool,
      GOV_ORG,
      id,
      GOV_MANAGER,
      { action: "takeover", expected_revision: before.revision },
      { canReassign: true },
    );
    expect(after.assignee_user_id).toBe(GOV_MANAGER);
    expect(after.wait_generation).toBe(before.wait_generation);
    expect(after.wait_started_at).toEqual(before.wait_started_at);
  });

  it("liberação registra intenção mas não recebimento nem envio confirmado", async () => {
    const row = await assume();
    await expect(
      applyCaseTaskAction(pool, GOV_ORG, id, GOV_AGENT_A, {
        action: "payment_confirmed",
        expected_revision: row.revision,
        approved_text: "Recebimento confirmado",
      }),
    ).rejects.toThrow();
    const result = await applyCaseTaskAction(pool, GOV_ORG, id, GOV_AGENT_A, {
      action: "details_release",
      expected_revision: row.revision,
      payment_method: "pix",
      approved_text: "Dados oficiais revisados",
    });
    expect(result.task_state).toBe("awaiting_send");
    expect(result.task_payload.decision).toBe("details_release");
    expect((await read())?.status).toBe("awaiting_human");
    const job = await pool.query("select status,payload from job_queue where id=$1", [
      result.delivery_job_id,
    ]);
    expect(job.rows[0].status).toBe("pending");
    expect(job.rows[0].payload.action).toBe("task_delivery");
  });

  it("relato de pagamento continua o caso e vence a aprovação anterior", async () => {
    const row = await assume();
    await applyCaseTaskAction(pool, GOV_ORG, id, GOV_AGENT_A, {
      action: "details_release",
      expected_revision: row.revision,
      payment_method: "pix",
      approved_text: "Dados",
    });
    const before = (await read())!;
    const same = await openPaymentTask(
      pool,
      { tenantId: GOV_ORG, conversationId: GOV_CONV_UNASSIGNED },
      { ...input, task_kind: "payment_review" },
    );
    expect(same).toBe(id);
    const after = (await read())!;
    expect(after.task_kind).toBe("payment_review");
    expect(after.wait_generation).toBe(before.wait_generation + 1);
    expect(after.delivery_job_id).toBeNull();
    expect(
      await encerrarChamadoPeloAgente(pool, GOV_ORG, id, {
        desfecho: "resolvido",
        nota: "Cliente disse que pagou",
      }),
    ).toBe(false);
  });

  it("esgotar fila deixa falha visível e repetir mantém o mesmo ledger", async () => {
    const row = await assume();
    const decision = await applyCaseTaskAction(pool, GOV_ORG, id, GOV_AGENT_A, {
      action: "details_release",
      expected_revision: row.revision,
      payment_method: "pix",
      approved_text: "Dados",
    });
    await pool.query("update job_queue set status='dead' where id=$1", [decision.delivery_job_id]);
    const failed = (await read())!;
    expect(failed.task_state).toBe("send_failed");
    expect(failed.decision_event_id).toBe(decision.decision_event_id);
    const retry = await applyCaseTaskAction(pool, GOV_ORG, id, GOV_AGENT_A, {
      action: "retry_send",
      expected_revision: failed.revision,
    });
    expect(retry.delivery_job_id).toBe(decision.delivery_job_id);
    expect(retry.task_state).toBe("awaiting_send");
  });

  it("anonimização limpa texto aprovado e próximo passo", async () => {
    const row = await assume();
    await applyCaseTaskAction(pool, GOV_ORG, id, GOV_AGENT_A, {
      action: "details_release",
      expected_revision: row.revision,
      payment_method: "pix",
      approved_text: "Dado pessoal sintético",
    });
    await pool.query(
      "update contacts set is_anonymized=true,is_blocked=true,anonymized_at=now(),name=null,display_name=null,phone_number=null,email=null where id=$1",
      [GOV_CONTACT_1],
    );
    expect((await read())?.task_payload).toEqual({});
  });
});
