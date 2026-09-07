import { registrarRespostaDeCasoObsoleto } from "@/lib/atendimento/aviso-caso-obsoleto";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestCheckpoint } from "@/lib/agent-engine/agent/inbound-turn";
import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { seedGov, GOV_ORG, GOV_SESSION, GOV_AGENT_A } from "./gov-helpers";
import {
  readCurrentServiceBoundary,
  requireCurrentServiceBoundary,
  withServiceJob,
} from "@/lib/atendimento/fronteira-server";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
const contact = randomUUID();
let conversation: string;
async function makeConversation(session = GOV_SESSION) {
  const id = randomUUID();
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [id, GOV_ORG, contact, session],
  );
  return id;
}
async function inbound(id = conversation, at?: string, direction = "inbound") {
  const mid = randomUUID();
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
   values($1,$2,$3,$4,$5,'text',$6,'received','ai','Mensagem de teste',coalesce($7::timestamptz,clock_timestamp()))`,
    [mid, GOV_ORG, id, GOV_SESSION, contact, direction, at ?? null],
  );
  await pool.query(
    "select fn_mark_conversation_message($1,$2,'Mensagem de teste',coalesce($3::timestamptz,clock_timestamp()))",
    [id, direction, at ?? null],
  );
  return mid;
}
async function state(id = conversation) {
  return (await pool.query("select * from conversations where id=$1", [id])).rows[0];
}
async function close(id = conversation) {
  const c = await state(id);
  return (
    await pool.query("select * from fn_service_status($1,$2,'closed',$3)", [
      GOV_ORG,
      id,
      c.service_revision,
    ])
  ).rows[0];
}
beforeAll(async () => {
  seedGov();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
    contact,
    GOV_ORG,
    "Task4",
  ]);
  conversation = await makeConversation();
});
afterAll(async () => {
  await pool.end();
});
describe("transição real de atendimento", () => {
  it("duas entradas concorrentes criam uma única demanda; fechar preserva N:N e exige desfecho CAS", async () => {
    await Promise.all([inbound(), inbound()]);
    const c = await state();
    expect(
      (await pool.query("select count(*)::int n from demandas where contact_id=$1", [contact]))
        .rows[0].n,
    ).toBe(1);
    const session = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)",
      [session, GOV_ORG, session],
    );
    const second = await makeConversation(session);
    await pool.query(
      "insert into demanda_conversas(organization_id,demanda_id,conversation_id,service_revision) values($1,$2,$3,1)",
      [GOV_ORG, c.current_demanda_id, second],
    );
    await close();
    expect(
      (await pool.query("select fechada_em from demandas where id=$1", [c.current_demanda_id]))
        .rows[0].fechada_em,
    ).toBeNull();
    expect((await state(second)).status).toBe("open");
    await pool.query("select fn_demanda_encerrar($1,$2,1,'resolvida',$3)", [
      GOV_ORG,
      c.current_demanda_id,
      GOV_AGENT_A,
    ]);
    await expect(
      pool.query("select fn_demanda_encerrar($1,$2,1,'perdida',$3)", [
        GOV_ORG,
        c.current_demanda_id,
        GOV_AGENT_A,
      ]),
    ).rejects.toMatchObject({ code: "40001" });
  });
  it("antigo/igual/outbound não reabre; nova entrada concorrente reabre uma vez e invalida trabalho antigo", async () => {
    const closed = await state();
    // 0228 coalesce trabalho ativo por org/conversa. Arma backoff futuro para
    // provar que a reabertura acorda a fila, sem exigir evento duplicado.
    const pending = (await pool.query(
      `update event_log set next_attempt_at=now()+interval '1 hour'
       where organization_id=$1 and entity_id=$2
         and event_type='conversation.routing_requested' and status='pending'
       returning id,next_attempt_at`,
      [GOV_ORG, conversation],
    )).rows;
    expect(pending).toHaveLength(1);
    const at = closed.service_closed_at.toISOString();
    await inbound(conversation, at);
    await inbound(conversation, "2000-01-01");
    await inbound(conversation, undefined, "outbound");
    expect((await state()).status).toBe("closed");
    const stillWaiting = (await pool.query(
      "select next_attempt_at from event_log where organization_id=$1 and id=$2",
      [GOV_ORG, pending[0].id],
    )).rows[0];
    expect(stillWaiting.next_attempt_at).toEqual(pending[0].next_attempt_at);
    const old = await readCurrentServiceBoundary(pool, GOV_ORG, conversation);
    await Promise.all([inbound(), inbound()]);
    const reopened = await state();
    expect(reopened.status).toBe("open");
    expect(Number(reopened.service_revision)).toBe(Number(closed.service_revision) + 1);
    expect(reopened.current_demanda_id).not.toBe(closed.current_demanda_id);
    await expect(requireCurrentServiceBoundary(pool, old)).rejects.toThrow(
      "service_boundary_stale",
    );
    const routing = (await pool.query(
      `select id,status,payload,next_attempt_at,
              next_attempt_at<=clock_timestamp() as ready_now
       from event_log where organization_id=$1 and entity_id=$2
         and event_type='conversation.routing_requested'`,
      [GOV_ORG, conversation],
    )).rows;
    expect(routing).toHaveLength(1);
    expect(routing[0]).toMatchObject({
      id: pending[0].id, status: "pending", ready_now: true,
      payload: { organization_id: GOV_ORG, conversation_id: conversation,
        channel_session_id: GOV_SESSION },
    });
    expect(routing[0].next_attempt_at.getTime()).toBeLessThan(pending[0].next_attempt_at.getTime());
  });
  it("CAS de close obsoleto não fecha nova revisão; escopo forjado é recusado", async () => {
    await expect(
      pool.query("select fn_service_status($1,$2,'closed',1)", [GOV_ORG, conversation]),
    ).rejects.toMatchObject({ code: "40001" });
    await expect(
      pool.query("select fn_service_status($1,$2,'closed',null)", [randomUUID(), conversation]),
    ).rejects.toMatchObject({ code: "P0002" });
    const foreign = randomUUID();
    await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
      foreign,
      GOV_ORG,
      "Outro",
    ]);
    await expect(
      pool.query(
        `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,sent_at)
   values($1,$2,$3,$4,'text','inbound','received','ai',clock_timestamp())`,
        [GOV_ORG, conversation, GOV_SESSION, foreign],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("encerrar demanda invalida só o assunto selecionado; a próxima entrada cria outra", async () => {
    const before = await readCurrentServiceBoundary(pool, GOV_ORG, conversation);
    if (!before) throw new Error("boundary");
    await pool.query("select fn_demanda_encerrar($1,$2,$3,'perdida',$4)", [
      GOV_ORG,
      before.demanda_id,
      before.demanda_revision,
      GOV_AGENT_A,
    ]);
    await expect(requireCurrentServiceBoundary(pool, before)).rejects.toThrow(
      "service_boundary_stale",
    );
    await inbound();
    expect((await state()).current_demanda_id).not.toBe(before.demanda_id);
  });
  it("tenant B real não alcança conversa nem pode forjar inbound na conversa A", async () => {
    const org = randomUUID(),
      ct = randomUUID(),
      session = randomUUID();
    await pool.query(
      "insert into organizations(id,display_name,legal_name,slug) values($1,$2,$2,$3)",
      [org, "Tenant B", org],
    );
    await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
      ct,
      org,
      "B",
    ]);
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)",
      [session, org, session],
    );
    expect(await readCurrentServiceBoundary(pool, org, conversation)).toBeNull();
    await expect(
      pool.query(
        `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,sent_at)
   values($1,$2,$3,$4,'text','inbound','received','ai',clock_timestamp())`,
        [org, conversation, session, ct],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("memória operacional deixa checkpoint/diálogo antigo; fatos duráveis permanecem", async () => {
    const old = await state();
    await pool.query(
      "insert into lead_checkpoints(organization_id,contact_id,commitments,objections,next_action,rolling_summary) values($1,$2,'[]','[]','Cobrar pedido antigo','Pendência antiga')",
      [GOV_ORG, contact],
    );
    await pool.query(
      "insert into lead_notes(organization_id,contact_id,headline,body) values($1,$2,'Preferência','Prefere atendimento pela manhã')",
      [GOV_ORG, contact],
    );
    await pool.query("update messages set body='COBRANCA_ANTIGA' where conversation_id=$1", [
      conversation,
    ]);
    await close();
    await inbound();
    const boundary = await readCurrentServiceBoundary(pool, GOV_ORG, conversation);
    if (!boundary) throw new Error("missing");
    const job = {
      kind: "inbound_turn",
      organization_id: GOV_ORG,
      contact_id: contact,
      payload: { service_boundary: boundary },
    } as unknown as JobRow;
    await withServiceJob(pool, job, async () => {
      expect(await latestCheckpoint(pool, GOV_ORG, contact)).toBeNull();
      const result = await getLeadContext(
        pool,
        {} as never,
        {
          tenantId: GOV_ORG,
          leadId: contact,
          conversationId: conversation,
          fuso: "America/Sao_Paulo",
        },
        { historyLimit: 20, maxTokens: 4000 },
      );
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain("COBRANCA_ANTIGA");
      expect(JSON.stringify(result)).toContain("Histórico encerrado");
    });
    expect(
      (
        await pool.query("select body from lead_notes where organization_id=$1 and contact_id=$2", [
          GOV_ORG,
          contact,
        ])
      ).rows[0].body,
    ).toContain("manhã");
    expect((await state()).current_demanda_id).not.toBe(old.current_demanda_id);
  });
  it("origem autorizada usa snapshot CAS: evento antigo não atravessa fechar/reabrir", async () => {
    const { rows } = await pool.query("select fn_service_observe($1,$2) snapshot", [
      GOV_ORG,
      contact,
    ]);
    await close();
    await inbound();
    await expect(
      pool.query("select fn_service_begin($1,$2,null,$3)", [GOV_ORG, contact, rows[0].snapshot]),
    ).rejects.toMatchObject({ code: "40001" });
    const fresh = await pool.query("select fn_service_observe($1,$2) snapshot", [GOV_ORG, contact]);
    const started = await pool.query("select fn_service_begin($1,$2,null,$3) boundary", [
      GOV_ORG,
      contact,
      fresh.rows[0].snapshot,
    ]);
    expect(started.rows[0].boundary.contact_id).toBe(contact);
  });
  it("primeira iniciativa cria sem demanda; legado ganha início sem certificar mensagens antigas", async () => {
    const ct = randomUUID();
    await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
      ct,
      GOV_ORG,
      "Nova iniciativa",
    ]);
    const observed = (await pool.query("select fn_service_observe($1,$2) b", [GOV_ORG, ct])).rows[0]
      .b;
    expect(observed.absent).toBe(true);
    const first = (
      await pool.query("select fn_service_begin($1,$2,null,$3) b", [GOV_ORG, ct, observed])
    ).rows[0].b;
    expect(first.demanda_id).toBeNull();
    expect(first.service_started_at).toBeTruthy();
    await expect(
      pool.query("select fn_service_begin($1,$2,null,$3)", [GOV_ORG, ct, observed]),
    ).rejects.toMatchObject({ code: "40001" });
    await pool.query("update conversations set service_started_at=null where id=$1", [
      first.conversation_id,
    ]);
    await pool.query(
      "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,sent_at,body) select organization_id,id,channel_session_id,contact_id,'text','outbound','sent','ai','2000-01-01','LEGADO_SEM_ORIGEM' from conversations where id=$1",
      [first.conversation_id],
    );
    const next = (await pool.query("select fn_service_begin($1,$2) b", [GOV_ORG, ct])).rows[0].b;
    expect(next.service_revision).toBe(first.service_revision + 1);
    expect(next.demanda_id).toBeNull();
    const result = await getLeadContext(
      pool,
      {} as never,
      {
        tenantId: GOV_ORG,
        leadId: ct,
        conversationId: first.conversation_id,
        fuso: "America/Sao_Paulo",
      },
      { historyLimit: 20, maxTokens: 4000 },
    );
    expect(JSON.stringify(result)).not.toContain("LEGADO_SEM_ORIGEM");
    await pool.query("select fn_service_status($1,$2,'closed',null)", [
      GOV_ORG,
      first.conversation_id,
    ]);
    const terminal = (await pool.query("select fn_service_observe($1,$2) b", [GOV_ORG, ct])).rows[0]
      .b;
    const reopened = (
      await pool.query("select fn_service_begin($1,$2,null,$3) b", [GOV_ORG, ct, terminal])
    ).rows[0].b;
    expect(reopened.status).toBe("open");
    expect(reopened.demanda_id).toBeNull();
  });
  it("grupo coerente persiste sem demanda/reabertura; tenant forjado continua recusado", async () => {
    const group = randomUUID();
    await pool.query(
      "insert into conversations(id,organization_id,channel_session_id,contact_id,is_group,group_chat_id,status) values($1,$2,$3,$4,true,'123@g.us','closed')",
      [group, GOV_ORG, GOV_SESSION, contact],
    );
    const insert = (org: string) =>
      pool.query(
        "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,sent_at) values($1,$2,$3,$4,'text','inbound','received','ai',clock_timestamp())",
        [org, group, GOV_SESSION, contact],
      );
    await insert(GOV_ORG);
    expect((await state(group)).status).toBe("closed");
    expect(
      (await pool.query("select service_revision from messages where conversation_id=$1", [group]))
        .rows[0].service_revision,
    ).toBeNull();
    await expect(insert(randomUUID())).rejects.toMatchObject({ code: "23503" });
  });
  it("colisão de conversas aborta mescla inteira e preserva ambos históricos", async () => {
    const a = randomUUID(),
      b = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$3,'A'),($2,$3,'B')",
      [a, b, GOV_ORG],
    );
    await pool.query(
      "insert into conversations(organization_id,contact_id,channel_session_id,status) values($1,$2,$4,'closed'),($1,$3,$4,'open')",
      [GOV_ORG, a, b, GOV_SESSION],
    );
    await expect(
      pool.query("select fn_mesclar_contatos($1,$2,$3)", [GOV_ORG, a, [b]]),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (
        await pool.query(
          "select count(*)::int n from contacts where id=any($1) and is_merged_into is null",
          [[a, b]],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query("select count(*)::int n from conversations where contact_id=any($1)", [
          [a, b],
        ])
      ).rows[0].n,
    ).toBe(2);
  });
  it("checkpoint vigente sem demanda é recuperado; fechar/reabrir o exclui", async () => {
    await close();
    await pool.query("select fn_service_begin($1,$2,$3)", [GOV_ORG, contact, GOV_SESSION]);
    const current = await readCurrentServiceBoundary(pool, GOV_ORG, conversation);
    if (!current) throw new Error("missing boundary");
    expect(current.demanda_id).toBeNull();
    await pool.query(
      `insert into lead_checkpoints(organization_id,contact_id,conversation_id,service_revision,demanda_id,demanda_revision,commitments,objections,next_action,rolling_summary)
      values($1,$2,$3,$4,null,null,'[]','[]','PASSO_VIGENTE_SEM_DEMANDA','RESUMO_VIGENTE')`,
      [GOV_ORG, contact, conversation, current.service_revision],
    );
    await withServiceJob(
      pool,
      {
        kind: "followup_turn",
        organization_id: GOV_ORG,
        contact_id: contact,
        payload: { service_boundary: current },
      } as unknown as JobRow,
      async () => {
        expect((await latestCheckpoint(pool, GOV_ORG, contact))?.next_action).toBe(
          "PASSO_VIGENTE_SEM_DEMANDA",
        );
      },
    );
    await close();
    await pool.query("select fn_service_begin($1,$2,$3)", [GOV_ORG, contact, GOV_SESSION]);
    const next = await readCurrentServiceBoundary(pool, GOV_ORG, conversation);
    await withServiceJob(
      pool,
      {
        kind: "followup_turn",
        organization_id: GOV_ORG,
        contact_id: contact,
        payload: { service_boundary: next },
      } as unknown as JobRow,
      async () => {
        expect(await latestCheckpoint(pool, GOV_ORG, contact)).toBeNull();
      },
    );
  });
  it("memória inclui duas entradas pós-fechamento fora de ordem, excluindo passado", async () => {
    await close();
    const ended = await state();
    const floor = ended.service_closed_at.getTime();
    const recent = await inbound(conversation, new Date(floor + 2000).toISOString());
    const delayed = await inbound(conversation, new Date(floor + 1000).toISOString());
    await pool.query(
      "update messages set body=case when id=$1 then 'ENTRADA_T2' when id=$2 then 'ENTRADA_T1_ATRASADA' else 'PASSADO_EXCLUIDO' end where conversation_id=$3",
      [recent, delayed, conversation],
    );
    const result = await getLeadContext(
      pool,
      {} as never,
      {
        tenantId: GOV_ORG,
        leadId: contact,
        conversationId: conversation,
        fuso: "America/Sao_Paulo",
      },
      { historyLimit: 50, maxTokens: 4000 },
    );
    expect(JSON.stringify(result)).toContain("ENTRADA_T2");
    expect(JSON.stringify(result)).toContain("ENTRADA_T1_ATRASADA");
    expect(JSON.stringify(result)).not.toContain("PASSADO_EXCLUIDO");
  });
  it("mescla e inbound concorrentes terminam sem inverter FK/mutex e sem mensagem na lápide", async () => {
    const winner = randomUUID();
    await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
      winner,
      GOV_ORG,
      "Principal",
    ]);
    const merge = await pool.connect();
    await merge.query("begin");
    try {
      for (const ct of [winner, contact].sort())
        await merge.query("select fn_service_lock($1,$2)", [GOV_ORG, ct]);
      const pending = inbound().then(
        () => "inserted",
        (e: { code: string }) => e.code,
      );
      let waiting = false;
      for (let n = 0; n < 50; n++) {
        const q = await pool.query(
          "select count(*)::int n from pg_stat_activity where wait_event='advisory' and query like 'insert into messages%'",
        );
        if (q.rows[0].n > 0) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      await merge.query("select fn_mesclar_contatos($1,$2,$3)", [GOV_ORG, winner, [contact]]);
      await merge.query("commit");
      expect(await pending).toBe("23503");
      expect((await state()).contact_id).toBe(winner);
      expect(
        (await pool.query("select count(*)::int n from messages where contact_id=$1", [contact]))
          .rows[0].n,
      ).toBe(0);
    } catch (error) {
      await merge.query("rollback");
      throw error;
    } finally {
      merge.release();
    }
  });
});

it("resposta stale e aviso são atômicos: falha no aviso permite retry sem duplicar", async () => {
  const caseId = randomUUID();
  await pool.query(
    "insert into agent_cases(id,organization_id,conversation_id,title,summary,blocker) values($1,$2,$3,'Caso','Resumo','Humano')",
    [caseId, GOV_ORG, conversation],
  );
  const before = await state();
  const failedPool = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes("insert into agent_inbox_items")) throw new Error("notice unavailable");
          return client.query(sql, params);
        },
        release: () => client.release(),
      };
    },
  } as unknown as pg.Pool;
  await expect(
    registrarRespostaDeCasoObsoleto(
      failedPool,
      GOV_ORG,
      caseId,
      GOV_AGENT_A,
      "Resposta registrada",
    ),
  ).rejects.toThrow("notice unavailable");
  expect(
    (await pool.query("select status from agent_cases where id=$1", [caseId])).rows[0].status,
  ).toBe("awaiting_human");
  expect(
    (await pool.query("select count(*)::int n from agent_case_events where case_id=$1", [caseId]))
      .rows[0].n,
  ).toBe(0);
  expect(
    await registrarRespostaDeCasoObsoleto(
      pool,
      GOV_ORG,
      caseId,
      GOV_AGENT_A,
      "Resposta registrada",
    ),
  ).toBe(true);
  expect(
    await registrarRespostaDeCasoObsoleto(
      pool,
      GOV_ORG,
      caseId,
      GOV_AGENT_A,
      "Resposta registrada",
    ),
  ).toBe(false);
  expect(
    (
      await pool.query(
        "select count(*)::int n from agent_case_events where case_id=$1 and kind='human_replied'",
        [caseId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select count(*)::int n from agent_inbox_items where organization_id=$1 and ref_id=$2 and title='Resposta registrada; atendimento mudou'",
        [GOV_ORG, conversation],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(await state()).toEqual(before);
});
