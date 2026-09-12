import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { runFollowupTick } from "@/lib/followup/engine";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { seedGov, GOV_ORG, GOV_AGENT_A, GOV_SESSION, GOV_VIEWER } from "./gov-helpers";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());
async function fixture() {
  const contact = randomUUID(),
    conversation = randomUUID(),
    id = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Presença')",
    [contact, GOV_ORG],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,title,starts_at,ends_at,status) values($1,$2,$3,$4,'Consulta',now()-interval '2 hours',now()-interval '1 hour','confirmed')",
    [id, GOV_ORG, contact, conversation],
  );
  return { contact, conversation, id };
}
async function change(
  id: string,
  revision = 1,
  patch: Record<string, unknown> = { status: "no_show" },
  user = GOV_AGENT_A,
) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated" }),
    ]);
    const r = await c.query("select fn_appointment_change($1,$2,$3,$4) result", [
      GOV_ORG,
      id,
      revision,
      patch,
    ]);
    await c.query("commit");
    return r.rows[0].result;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
async function event(id: string) {
  return (
    await pool.query(
      "select id from event_log where organization_id=$1 and entity_id=$2 and event_type='appointment.outcome_confirmed' order by created_at desc limit 1",
      [GOV_ORG, id],
    )
  ).rows[0].id as string;
}
async function recover(id: string) {
  return (
    await pool.query("select fn_appointment_recover($1,$2) result", [GOV_ORG, await event(id)])
  ).rows[0].result;
}
async function inbound(
  a: Awaited<ReturnType<typeof fixture>>,
  sentAt: string,
  db: pg.Pool | pg.PoolClient = pool,
  direction = "inbound",
) {
  const id = randomUUID();
  await db.query(
    "insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at,external_id) values($1::uuid,$2,$3,$4,$5,'text',$6,'received','ai','Resposta',$7,$1::text)",
    [id, GOV_ORG, a.conversation, GOV_SESSION, a.contact, direction, sentAt],
  );
  return id;
}
async function flow() {
  const v = (
    await pool.query(
      "insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id",
      [
        GOV_ORG,
        {
          nodes: [
            { id: "t", type: "trigger", label: "Falta", position: { x: 0, y: 0 }, config: {} },
            {
              id: "end",
              type: "end",
              label: "Fim",
              position: { x: 0, y: 1 },
              config: { outcome: "converted" },
            },
          ],
          edges: [
            { id: "e", source: "t", target: "end", priority: 0, condition: { type: "always" } },
          ],
        },
      ],
    )
  ).rows[0].id;
  const p = (
    await pool.query(
      "insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config) values($1,'Recuperação teste '||gen_random_uuid(),'active',$2,$3) returning id",
      [GOV_ORG, v, { kind: "appointment_no_show", cancel_on_reply: false }],
    )
  ).rows[0].id;
  const agent = (
    await pool.query(
      "insert into ai_agents(organization_id,name,system_prompt) values($1,'Recuperação teste '||gen_random_uuid(),'Prompt') returning id",
      [GOV_ORG],
    )
  ).rows[0].id;
  await pool.query(
    "insert into ai_agent_versions(organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1,$2,1,'Prompt','anthropic','claude-sonnet-4-6',$3,'published',$4)",
    [GOV_ORG, agent, GOV_SESSION, { enabled: true, flow_pointer_ids: [p] }],
  );
  return p;
}
async function stopFlows() {
  await pool.query(
    "update followup_flow_pointers set status='disabled' where organization_id=$1 and trigger_config->>'kind'='appointment_no_show'",
    [GOV_ORG],
  );
}
describe("presença e recuperação transacionais", () => {
  it("exige humano, início real, papel e CAS; metadado técnico não muda revisão", async () => {
    const a = await fixture();
    await expect(
      pool.query('select fn_appointment_change($1,$2,1,\'{"status":"no_show"}\')', [GOV_ORG, a.id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(change(a.id, 1, { status: "no_show" }, GOV_VIEWER)).rejects.toMatchObject({
      code: "42501",
    });
    await pool.query("update calendar_appointments set notes='Metadado' where id=$1", [a.id]);
    const r = await change(a.id);
    expect(r).toMatchObject({
      status: "no_show",
      revision: 2,
      outcome_user_id: GOV_AGENT_A,
      outcome_source_kind: "user",
    });
    await expect(change(a.id, 1, { status: "completed" })).rejects.toMatchObject({ code: "40001" });
    expect(
      (
        await pool.query(
          "select count(*)::int n from event_log where entity_id=$1 and event_type='appointment.outcome_confirmed'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const future = await fixture();
    await pool.query(
      "update calendar_appointments set starts_at=now()+interval '1 hour',ends_at=now()+interval '2 hours' where id=$1",
      [future.id],
    );
    await expect(change(future.id, 2)).rejects.toMatchObject({ code: "22023" });
  });
  it("relógio solicita, deduplica e escala sem converter desconhecido em falta", async () => {
    const a = await fixture();
    await pool.query("select fn_appointment_confirmation_sweep(500,now())");
    await pool.query("select fn_appointment_confirmation_sweep(500,now())");
    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where ref_id=$1 and kind='appointment_outcome_required'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await pool.query("select fn_appointment_confirmation_sweep(500,now()+interval '25 hours')");
    expect(
      (await pool.query("select status from calendar_appointments where id=$1", [a.id])).rows[0]
        .status,
    ).toBe("confirmed");
    expect(
      (await pool.query("select severity from agent_inbox_items where ref_id=$1", [a.id])).rows[0]
        .severity,
    ).toBe("critical");
  });
  it("sem configuração é decisão terminal, inclusive depois de configurar; recibo privado e evento ausente falham fechado", async () => {
    await stopFlows();
    const a = await fixture();
    await change(a.id);
    expect((await recover(a.id)).result).toBe("not_configured");
    await flow();
    expect((await recover(a.id)).result).toBe("not_configured");
    const eid = await event(a.id);
    await pool.query("delete from event_log where id=$1", [eid]);
    expect(
      (
        await pool.query(
          "select source_event_id,result from appointment_recovery_receipts where appointment_id=$1",
          [a.id],
        )
      ).rows[0],
    ).toEqual({ source_event_id: null, result: "not_configured" });
    await expect(
      pool.query("select fn_appointment_recover($1,$2)", [GOV_ORG, eid]),
    ).rejects.toMatchObject({ code: "P0002" });
    expect(
      (
        await pool.query(
          "select has_table_privilege('authenticated','appointment_recovery_receipts','INSERT') i, has_table_privilege('service_role','appointment_recovery_receipts','UPDATE') u",
        )
      ).rows[0],
    ).toEqual({ i: false, u: false });
  });
  it("inicia uma vez, preserva versão, não ressuscita após inbound mesmo pausado/cancel_on_reply=false", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await inbound(a, new Date(Date.now() - 60000).toISOString());
    const outcome = await change(a.id);
    const r = await recover(a.id);
    expect(r.result).toBe("started");
    const e = (
      await pool.query(
        "update followup_enrollments set status='paused_manual' where id=$1 returning revision",
        [r.enrollment_id],
      )
    ).rows[0];
    await inbound(a, outcome.outcome_recorded_at);
    const receipt = await recover(a.id);
    expect(receipt.result).toBe("started");
    expect(receipt.invalidated_at).toBeTruthy();
    expect(
      (await pool.query("select status from followup_enrollments where id=$1", [r.enrollment_id]))
        .rows[0].status,
    ).toBe("cancelled");
    await expect(
      pool.query('select fn_followup_patch($1,$2,$3,\'{"status":"active"}\')', [
        GOV_ORG,
        r.enrollment_id,
        e.revision,
      ]),
    ).rejects.toMatchObject({ code: "40001" });
  });
  it("histórico e saída não cancelam; entrada certificada antes do consumer impede início", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    const r = await change(a.id);
    await inbound(a, new Date(Date.parse(r.outcome_recorded_at) - 60000).toISOString());
    await inbound(a, r.outcome_recorded_at, pool, "outbound");
    expect(
      (
        await pool.query(
          "select count(*)::int n from appointment_recovery_receipts where appointment_id=$1",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(0);
    await inbound(a, r.outcome_recorded_at);
    expect((await recover(a.id)).result).toBe("stale");
  });
  it("transação inbound começa antes do desfecho e certifica depois: created_at antigo não preserva recuperação", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select now()");
      const outcome = await change(a.id);
      const mid = await inbound(a, outcome.outcome_recorded_at, c);
      await c.query("commit");
      const times = (
        await pool.query(
          "select m.created_at<a.outcome_recorded_at older from messages m cross join calendar_appointments a where m.id=$1 and a.id=$2",
          [mid, a.id],
        )
      ).rows[0];
      expect(times.older).toBe(true);
      expect((await recover(a.id)).result).toBe("stale");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
  it("dois retornos pós-desfecho fora de ordem não mantêm recuperação viva", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    const r = await change(a.id);
    await recover(a.id);
    await inbound(a, new Date(Date.parse(r.outcome_recorded_at) + 2000).toISOString());
    await inbound(a, new Date(Date.parse(r.outcome_recorded_at) + 1000).toISOString());
    expect((await recover(a.id)).invalidated_at).toBeTruthy();
  });
  it("múltiplos fluxos resultam em ambiguidade visível sem escolher UUID", async () => {
    await stopFlows();
    await flow();
    await flow();
    const a = await fixture();
    await change(a.id);
    expect((await recover(a.id)).result).toBe("ambiguous");
    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where ref_id=$1 and kind='appointment_recovery_review'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("régua de recuperação esgotada sem resposta abre aviso na Central referenciando o compromisso", async () => {
    await stopFlows();
    // Fluxo mínimo que chega direto ao fim com outcome `exhausted` — o motor
    // conclui num tick só e o hook de `no-show-recuperacao-esgotada` dispara.
    const v = (
      await pool.query(
        "insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id",
        [
          GOV_ORG,
          {
            nodes: [
              { id: "t", type: "trigger", label: "Falta", position: { x: 0, y: 0 }, config: {} },
              { id: "end", type: "end", label: "Fim", position: { x: 0, y: 1 }, config: { outcome: "exhausted" } },
            ],
            edges: [{ id: "e", source: "t", target: "end", priority: 0, condition: { type: "always" } }],
          },
        ],
      )
    ).rows[0].id;
    const p = (
      await pool.query(
        "insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config) values($1,'Recuperação esgotável '||gen_random_uuid(),'active',$2,$3) returning id",
        [GOV_ORG, v, { kind: "appointment_no_show", cancel_on_reply: false }],
      )
    ).rows[0].id;
    const agent = (
      await pool.query(
        "insert into ai_agents(organization_id,name,system_prompt) values($1,'Recuperação esgotável '||gen_random_uuid(),'Prompt') returning id",
        [GOV_ORG],
      )
    ).rows[0].id;
    await pool.query(
      "insert into ai_agent_versions(organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1,$2,1,'Prompt','anthropic','claude-sonnet-4-6',$3,'published',$4)",
      [GOV_ORG, agent, GOV_SESSION, { enabled: true, flow_pointer_ids: [p] }],
    );

    const a = await fixture();
    await change(a.id);
    const rec = await recover(a.id);
    expect(rec.result).toBe("started");

    // O enrollment recém-criado pode estar a alguns ms no futuro para o Postgres
    // (ver followup-relogio.ts) — força-o a devido antes do tick.
    await pool.query(
      "update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1",
      [rec.enrollment_id],
    );

    // ⚠️ DOIS TICKS, e não é folga: o motor avança UM nó por rodada.
    //
    // O primeiro tick tira o enrollment do gatilho e o deixa PARADO no nó
    // `end` (`current_node_id='end'`, ainda `status='active'`); é o SEGUNDO que
    // EXECUTA o `end` e conclui com `outcome='exhausted'`, que é o que dispara
    // o aviso. Em produção o cron roda a cada minuto e isso é invisível.
    //
    // Medido, porque a primeira versão deste teste tinha um tick só e o
    // diagnóstico foi para o lugar errado — a suspeita (minha e do autor) era
    // de que `fn_claim_due_followup_enrollments` estivesse falhando, já que
    // `claimed: 0` é indistinguível de "nada vencido". Sondei a função direto:
    //
    //   SONDA-CLAIM-OK  {"n":1}
    //   SONDA-TICK      {"claimed":1,"advanced":1,"scheduled":0,"failed":0}
    //   SONDA-POS       {"status":"active","current_node_id":"end"}
    //
    // O claim funcionava o tempo todo. Faltava uma rodada.
    for (let rodada = 0; rodada < 2; rodada += 1) {
      await pool.query(
        "update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1 and status = 'active'",
        [rec.enrollment_id],
      );
      await runFollowupTick(
        { db: createPgAdminClient(pool), clock: () => new Date(), enqueueJob: async () => {} },
        { limit: 10 },
      );
    }

    const enr = (
      await pool.query("select status, outcome from followup_enrollments where id = $1", [rec.enrollment_id])
    ).rows[0];
    expect(enr).toMatchObject({ status: "completed", outcome: "exhausted" });

    const aviso = (
      await pool.query(
        "select severity, ref_kind, appointment_revision::int rev from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='appointment_recovery_review'",
        [GOV_ORG, a.id],
      )
    ).rows;
    expect(aviso).toHaveLength(1);
    expect(aviso[0]).toMatchObject({ severity: "warn", ref_kind: "appointment", rev: 2 });

    // Idempotente: reprocessar o mesmo passo não abre um segundo aviso.
    await runFollowupTick(
      { db: createPgAdminClient(pool), clock: () => new Date(), enqueueJob: async () => {} },
      { limit: 10 },
    );
    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='appointment_recovery_review'",
          [GOV_ORG, a.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("outro fluxo ativo gera recibo terminal e retry tardio não inicia", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id);
    const first = await recover(a.id);
    const second = (
      await pool.query(
        "insert into calendar_appointments(organization_id,contact_id,conversation_id,title,starts_at,ends_at,status) values($1,$2,$3,'Segunda consulta',now()-interval '2 hours',now()-interval '1 hour','confirmed') returning id",
        [GOV_ORG, a.contact, a.conversation],
      )
    ).rows[0].id;
    await change(second);
    expect((await recover(second)).result).toBe("other_flow");
    await pool.query("update followup_enrollments set status='completed' where id=$1", [
      first.enrollment_id,
    ]);
    expect((await recover(second)).result).toBe("other_flow");
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollments where appointment_id=$1",
          [second],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("recibo e callback com CAS não deixam evento órfão nem reativam cancelamento", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id);
    const r = await recover(a.id);
    const e = (
      await pool.query("select revision from followup_enrollments where id=$1", [r.enrollment_id])
    ).rows[0];
    await pool.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
      GOV_ORG,
      r.enrollment_id,
      e.revision,
      { current_node_id: "end", steps_taken: 1 },
      { node_id: "t", event_type: "node_advanced", payload: {}, idempotency_key: "t:0" },
    ]);
    const rev = (
      await pool.query("select revision from followup_enrollments where id=$1", [r.enrollment_id])
    ).rows[0].revision;
    await change(a.id, 2, { status: "cancelled", cancellation_reason: "Remarcou" });
    await expect(
      pool.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        GOV_ORG,
        r.enrollment_id,
        rev,
        { status: "active", steps_taken: 2 },
        { node_id: "end", event_type: "node_advanced", payload: {}, idempotency_key: "end:1" },
      ]),
    ).rejects.toMatchObject({ code: "40001" });
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and idempotency_key='end:1'",
          [r.enrollment_id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("evidência precisa ser inbound do contato e com serviço certificado; ator não vem do patch", async () => {
    const a = await fixture(),
      b = await fixture();
    const foreign = await inbound(b, new Date().toISOString());
    await expect(
      change(a.id, 1, { status: "completed", outcome_message_id: foreign }),
    ).rejects.toMatchObject({ code: "42501" });
    const own = await inbound(a, new Date().toISOString());
    const r = await change(a.id, 1, {
      status: "completed",
      outcome_message_id: own,
      outcome_user_id: GOV_VIEWER,
    });
    expect(r).toMatchObject({
      outcome_message_id: own,
      outcome_user_id: GOV_AGENT_A,
      outcome_source_kind: "contact_message",
    });
  });
  it("snooze reabre o mesmo aviso; prazo malformado degrada sem quebrar o sweep", async () => {
    const a = await fixture();
    await pool.query("select fn_appointment_confirmation_sweep(500,now())");
    const r = await change(a.id, 1, {
      confirmation_next_at: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(r.revision).toBe(1);
    expect(
      (await pool.query("select status from agent_inbox_items where ref_id=$1", [a.id])).rows[0]
        .status,
    ).toBe("resolved");
    await pool.query("select fn_appointment_confirmation_sweep(500,now()+interval '61 minutes')");
    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where ref_id=$1 and status='open'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query("select fn_agenda_minutes($1,'confirmation_delay_minutes',10) n", [
          { agenda: { confirmation_delay_minutes: "quebrado", unknown_protection_minutes: -1 } },
        ])
      ).rows[0].n,
    ).toBe(10);
  });
  it("job inline esgotado cria aviso no mesmo commit e lease antigo não duplica", async () => {
    const a = await fixture();
    const j = (
      await pool.query(
        "insert into job_queue(organization_id,contact_id,kind,status,payload,attempts,max_attempts,locked_by,locked_at) values($1,$2,'followup_turn','running','{}',2,2,'inline-test',now()) returning id,locked_at::text as acquired_at",
        [GOV_ORG, a.contact],
      )
    ).rows[0];
    expect(
      (
        await pool.query(
          "select fn_followup_inline_settle($1,$2,'inline-test',false,'message_queued',null,false,$3) ok",
          [GOV_ORG, j.id, j.acquired_at],
        )
      ).rows[0].ok,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "select fn_followup_inline_settle($1,$2,'inline-test',false,'message_queued',null,false,$3) ok",
          [GOV_ORG, j.id, j.acquired_at],
        )
      ).rows[0].ok,
    ).toBe(false);
    expect((await pool.query("select status from job_queue where id=$1", [j.id])).rows[0].status).toBe(
      "dead",
    );
    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where ref_id=$1 and kind='job_dead'",
          [j.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("turno sem envio encerra com motivo visível e retry não repete mutações", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id);
    const r = await recover(a.id);
    const bridge = createPgAdminClient(pool);
    await completeTurnForEnrollment(bridge, GOV_ORG, r.enrollment_id, "t", {
      kind: "skipped",
      reason: "O assistente decidiu encerrar sem mensagem.",
    });
    await completeTurnForEnrollment(bridge, GOV_ORG, r.enrollment_id, "t", {
      kind: "skipped",
      reason: "O assistente decidiu encerrar sem mensagem.",
    });
    expect(
      (
        await pool.query("select status,cancel_reason from followup_enrollments where id=$1", [
          r.enrollment_id,
        ])
      ).rows[0],
    ).toEqual({
      status: "cancelled",
      cancel_reason: "O assistente decidiu encerrar sem mensagem.",
    });
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type='turn_skipped'",
          [r.enrollment_id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("job do mesmo nó pertence ao enqueue original; rechecks passam, loop e callback antigo não", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id);
    const r = await recover(a.id);
    const enr = r.enrollment_id;
    const step = async (node: string, n: number, type: string) =>
      pool.query(
        "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,idempotency_key) values($1,$2,$3,$4,$5)",
        [GOV_ORG, enr, node, type, `${node}:${n}`],
      );
    const job = async (key: string) =>
      (
        await pool.query(
          "insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'followup_turn',$3) returning id",
          [GOV_ORG, a.contact, { followup_enrollment_id: enr, node_id: "t", source_step_key: key }],
        )
      ).rows[0].id;
    const current = async (j: string) =>
      (await pool.query("select fn_followup_job_current($1,$2,$3,'t') ok", [GOV_ORG, j, enr]))
        .rows[0].ok;
    await step("t", 0, "turn_enqueued");
    const old = await job("t:0");
    await step("t", 1, "action_recheck");
    await pool.query("update followup_enrollments set steps_taken=2 where id=$1", [enr]);
    expect(await current(old)).toBe(true);
    await step("t", 2, "action_sent");
    await step("end", 3, "node_advanced");
    await pool.query(
      "update followup_enrollments set current_node_id='t',steps_taken=4 where id=$1",
      [enr],
    );
    // Antes mesmo de outro enqueue, voltar ao mesmo UUID não revalida o job.
    expect(await current(old)).toBe(false);
    await step("t", 4, "turn_enqueued");
    const fresh = await job("t:4");
    expect(await current(fresh)).toBe(true);
    const rev = (await pool.query("select revision from followup_enrollments where id=$1", [enr]))
      .rows[0].revision;
    await expect(
      pool.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        GOV_ORG,
        enr,
        rev,
        { status: "completed" },
        { job_id: old, node_id: "t", event_type: "action_sent", idempotency_key: "t:5" },
      ]),
    ).rejects.toMatchObject({ code: "40001" });
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and idempotency_key='t:5'",
          [enr],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      completeTurnForEnrollment(
        createPgAdminClient(pool),
        GOV_ORG,
        enr,
        "t",
        { kind: "skipped", reason: "velho" },
        undefined,
        old,
      ),
    ).rejects.toThrow();
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: GOV_AGENT_A, role: "authenticated" }),
      ]);
      await expect(
        c.query(
          "update job_queue set payload=jsonb_set(payload,'{source_step_key}',to_jsonb($2::text)) where id=$1",
          [old, "t:4"],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback");
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: GOV_AGENT_A, role: "authenticated" }),
      ]);
      await expect(
        c.query(
          "delete from followup_enrollment_events where enrollment_id=$1 and idempotency_key='t:2'",
          [enr],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback");
      c.release();
    }
    // Retenção do evento não autoriza reconstituir a origem pela posição atual.
    await pool.query(
      "delete from followup_enrollment_events where enrollment_id=$1 and idempotency_key='t:4'",
      [enr],
    );
    expect(await current(fresh)).toBe(false);
  });
  it("origem de recuperação não pode ser apagada para escapar da guarda; FK apagada cancela", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id);
    const r = await recover(a.id);
    await pool.query(
      "update followup_enrollments set appointment_id=null,appointment_revision=null where id=$1",
      [r.enrollment_id],
    );
    expect(
      (
        await pool.query(
          "select appointment_id,appointment_revision::int from followup_enrollments where id=$1",
          [r.enrollment_id],
        )
      ).rows[0],
    ).toMatchObject({ appointment_id: a.id, appointment_revision: 2 });
    await pool.query("delete from calendar_appointments where id=$1", [a.id]);
    expect(
      (
        await pool.query("select status,appointment_id from followup_enrollments where id=$1", [
          r.enrollment_id,
        ])
      ).rows[0],
    ).toEqual({ status: "cancelled", appointment_id: null });
  });
  it("retenção da evidência conserva o desfecho e remove só o ponteiro", async () => {
    const a = await fixture();
    const msg = await inbound(a, new Date().toISOString());
    await change(a.id, 1, { status: "completed", outcome_message_id: msg });
    await pool.query("delete from messages where id=$1", [msg]);
    expect(
      (
        await pool.query(
          "select status,revision::int,outcome_message_id,outcome_user_id from calendar_appointments where id=$1",
          [a.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: "completed",
      revision: 2,
      outcome_message_id: null,
      outcome_user_id: GOV_AGENT_A,
    });
  });
  it("contato ANONIMIZADO não ganha aviso — a régua termina calada", async () => {
    // ═══ POR QUE ESTE CASO EXISTE ═══
    //
    // A cascata de LGPD **não cancela** `followup_enrollments`. Então um contato
    // anonimizado com régua em curso chega ao fim dela DEPOIS da redação, e a
    // porta do aviso reabriria um item apontando para o compromisso que a
    // anonimização tinha desligado.
    //
    // As outras três portas para `appointment_recovery_review` já guardam isso
    // (`fn_appointment_recover` recusa contato anonimizado,
    // `fn_meet_redact_contact` resolve os abertos, e há um bloco de cura no
    // baseline). Esta era a quarta e nascia sem — e nenhum invariante cobrava a
    // guarda de quem escreve o `kind` pelo TypeScript. Por isso ela mora DENTRO
    // do `insert ... select` em `turn-bridge.ts`, e não num `if` antes dele:
    // no `select`, quem mudar a consulta tem de apagar a linha de propósito.
    await stopFlows();
    const v = (
      await pool.query(
        "insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id",
        [
          GOV_ORG,
          {
            nodes: [
              { id: "t", type: "trigger", label: "Falta", position: { x: 0, y: 0 }, config: {} },
              { id: "end", type: "end", label: "Fim", position: { x: 0, y: 1 }, config: { outcome: "exhausted" } },
            ],
            edges: [{ id: "e", source: "t", target: "end", priority: 0, condition: { type: "always" } }],
          },
        ],
      )
    ).rows[0].id;
    const ponteiro = (
      await pool.query(
        "insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config) values($1,'Recuperação anonimizada '||gen_random_uuid(),'active',$2,$3) returning id",
        [GOV_ORG, v, { kind: "appointment_no_show", cancel_on_reply: false }],
      )
    ).rows[0].id;
    const agent = (
      await pool.query(
        "insert into ai_agents(organization_id,name,system_prompt) values($1,'Recuperação anonimizada '||gen_random_uuid(),'Prompt') returning id",
        [GOV_ORG],
      )
    ).rows[0].id;
    await pool.query(
      "insert into ai_agent_versions(organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1,$2,1,'Prompt','anthropic','claude-sonnet-4-6',$3,'published',$4)",
      [GOV_ORG, agent, GOV_SESSION, { enabled: true, flow_pointer_ids: [ponteiro] }],
    );

    const a = await fixture();
    await change(a.id);
    const rec = await recover(a.id);
    expect(rec.result).toBe("started");

    // A redação acontece DEPOIS da matrícula — é exatamente a ordem que cria o
    // problema, e a que a cascata de LGPD produz hoje.
    await pool.query(
      "update contacts set is_anonymized = true, anonymized_at = now(), display_name = 'Cliente Anonimizado #1' where id = $1",
      [a.contact],
    );

    // CONTROLE POSITIVO: o enrollment continua vivo depois da anonimização.
    // Sem isto, "nenhum aviso" poderia ser porque a régua já tinha morrido — e
    // o teste passaria sem medir a guarda.
    expect(
      (await pool.query("select status from followup_enrollments where id = $1", [rec.enrollment_id])).rows[0].status,
      "a cascata de LGPD passou a cancelar o enrollment — se isso mudou de propósito, este caso perdeu o objeto",
    ).toBe("active");

    for (let rodada = 0; rodada < 2; rodada += 1) {
      await pool.query(
        "update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1 and status = 'active'",
        [rec.enrollment_id],
      );
      await runFollowupTick(
        { db: createPgAdminClient(pool), clock: () => new Date(), enqueueJob: async () => {} },
        { limit: 10 },
      );
    }

    // CONTROLE: a régua CHEGOU AO FIM — senão "nenhum aviso" seria trivial.
    expect(
      (await pool.query("select status, outcome from followup_enrollments where id = $1", [rec.enrollment_id])).rows[0],
    ).toMatchObject({ status: "completed", outcome: "exhausted" });

    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='appointment_recovery_review'",
          [GOV_ORG, a.id],
        )
      ).rows[0].n,
      "abriu aviso para um contato anonimizado — o item aponta para um compromisso que a redação desligou",
    ).toBe(0);
  });
});
