import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  blocoDoCasoAguardandoCliente,
  getCaseAwaitingLead,
  openCase,
  markAwaitingLead,
  provideCaseUpdate,
} from "@/lib/agent-engine/agent/human-cases";
import { carregarContextoDoAtendimento } from "@/lib/agent-engine/agent/contexto-do-atendimento";
import { lerEventosDoCaso } from "@/lib/agent-engine/agent/conversa-do-caso/leitura";

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DB_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const org = randomUUID(),
  other = randomUUID(),
  contact = randomUUID(),
  session = randomUUID(),
  conv = randomUUID(),
  actor = randomUUID();
const phone = "+5511990000101";
let caseId: string, askId: string;
beforeAll(async () => {
  for (const id of [org, other])
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Prova','Prova')",
      [id],
    );
  await pool.query("insert into auth.users(id,email) values($1,$2)", [
    actor,
    `${actor}@example.test`,
  ]);
  await pool.query(
    "insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Pessoa de prova','+5511990000102')",
    [contact, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)",
    [session, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'ai_handling')",
    [conv, org, contact, session],
  );
  await pool.query(
    "insert into config_aviso_de_caso(organization_id,channel_session_id,telefone_destino,ligado,resposta_whatsapp_habilitada) values($1,$2,$3,true,true)",
    [org, session, phone],
  );
});
beforeEach(async () => {
  await pool.query("delete from job_queue where organization_id=$1", [org]);
  await pool.query("delete from event_log where organization_id=$1", [org]);
  await pool.query("delete from agent_cases where organization_id=$1", [org]);
  await pool.query(
    "update conversations set status='ai_handling',service_revision=1,current_demanda_id=null,is_group=false where id=$1",
    [conv],
  );
  await pool.query(
    "update config_aviso_de_caso set ligado=true,resposta_whatsapp_habilitada=true,telefone_destino=$2,destino_modo='fixo' where organization_id=$1",
    [org, phone],
  );
  const result = await openCase(
    pool,
    { tenantId: org, conversationId: conv },
    {
      title: "Escolha",
      summary: "Conferir opção",
      blocker: "Confirmação",
      contextSnapshot: {
        service_boundary: {
          organization_id: org,
          contact_id: contact,
          conversation_id: conv,
          service_revision: 1,
          demanda_id: null,
          demanda_revision: null,
        },
      },
    },
  );
  if (!result.ok) throw new Error("fixture de caso recusada");
  caseId = result.caseId;
  await pool.query(
    "insert into entregas_de_aviso_de_caso(organization_id,case_id,destino,channel_session_id,status,enviado_em) values($1,$2,$3,$4,'enviado',now())",
    [org, caseId, phone, session],
  );
  await ask();
});
afterAll(() => pool.end());
async function ask() {
  expect(await markAwaitingLead(pool, org, caseId, actor, "Qual opção?")).toBe(true);
  askId = (await pool.query(
    "select id from agent_case_events where organization_id=$1 and case_id=$2 and kind='human_replied' and human_action='need_lead_info' order by created_at desc,id desc limit 1",
    [org,caseId],
  )).rows[0].id;
}
async function provide(requestEventId = askId) {
  return provideCaseUpdate(
    pool,
    { tenantId: org, conversationId: conv },
    { caseId, info: "Primeira opção", requestEventId },
  );
}
/** O segundo caminho do pedido até um modelo: a continuidade do contexto do atendimento. */
async function pedidoNoContexto() {
  const contexto = await carregarContextoDoAtendimento(pool, {
    tenantId: org,
    leadId: contact,
    conversationId: conv,
  });
  const caso = contexto.continuidade.find((f) => f.origem === "caso_humano");
  if (!caso) throw new Error("o caso sumiu do contexto do atendimento");
  return caso.dados.pergunta_humana;
}
async function marcaDaResposta(eventId: string) {
  return (
    await pool.query("select metadata->'fora_da_fronteira' v from agent_case_events where id=$1", [
      eventId,
    ])
  ).rows[0].v;
}
async function event() {
  return (
    await pool.query(
      "select * from event_log where organization_id=$1 and event_type='ai.case_updated' order by created_at desc,id desc limit 1",
      [org],
    )
  ).rows[0]!;
}
async function current(e: Awaited<ReturnType<typeof event>>, tenant = org) {
  return (
    await pool.query("select fn_ler_retorno_de_caso($1,$2,$3,$4) v", [
      tenant,
      caseId,
      e.payload.case_event_id,
      e.payload.config_revision,
    ])
  ).rows[0].v;
}
async function sent(id: string) {
  await pool.query(
    "insert into entregas_de_aviso_de_caso(organization_id,case_id,destino,channel_session_id,status,enviado_em,update_event_id) values($1,$2,$3,$4,'enviado',now(),$5)",
    [org, caseId, phone, session, id],
  );
}
async function reply(id: string | null, key = randomUUID(), action = "resolved", from = phone) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local role service_role");
    await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
    const result = await db.query(
      "select fn_responder_caso_por_whatsapp($1,$2,$3,$4,$5,$6,$7,$8) v",
      [org, caseId, session, [from], action, "Autorizado somente neste pedido", key, id],
    );
    await db.query("commit");
    return result.rows[0].v;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
it("persiste a transição, o fato e a outbox, sem recriar abertura", async () => {
  // Controle da fronteira: dentro dela o pedido vai ao modelo pelos dois caminhos.
  const caso = await getCaseAwaitingLead(pool, org, conv);
  expect(caso).toMatchObject({ id: caseId, eventId: askId, ask: "Qual opção?" });
  expect(blocoDoCasoAguardandoCliente(caso)).toContain("Qual opção?");
  expect(await pedidoNoContexto()).toBe("Qual opção?");
  expect(await provide()).toEqual({ ok: true, foraDaFronteira: false });
  const e = await event();
  expect(await marcaDaResposta(e.payload.case_event_id)).toBe(false);
  expect(e.payload).toMatchObject({ case_id: caseId, conversation_id: conv, contact_id: contact });
  expect(await current(e)).toEqual({
    info: "Primeira opção",
    ask: "Qual opção?",
    contactId: contact,
    conversationId: conv,
  });
  expect(
    (
      await pool.query("select metadata from agent_case_events where id=$1", [
        e.payload.case_event_id,
      ])
    ).rows[0].metadata,
  ).toMatchObject({ request_event_id: askId });
  expect(
    (await pool.query("select id from agent_cases where organization_id=$1", [org])).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select id from event_log where organization_id=$1 and event_type='ai.case_opened'",
        [org],
      )
    ).rowCount,
  ).toBe(1);
});
it("a falha na outbox reverte também informação e transição", async () => {
  await pool.query(
    "create function public.test_recusa_retorno() returns trigger language plpgsql as $$ begin if new.event_type='ai.case_updated' then raise exception 'outbox_indisponivel';end if;return new;end $$;create trigger test_recusa_retorno before insert on event_log for each row execute function public.test_recusa_retorno()",
  );
  try {
    await expect(provide()).rejects.toThrow("outbox_indisponivel");
    expect(
      (await pool.query("select status from agent_cases where id=$1", [caseId])).rows[0].status,
    ).toBe("awaiting_lead");
    expect(
      (
        await pool.query(
          "select id from agent_case_events where case_id=$1 and kind='lead_provided'",
          [caseId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await pool.query(
      "drop trigger test_recusa_retorno on event_log;drop function public.test_recusa_retorno()",
    );
  }
});
it("concorrência e retry mantêm uma atualização lógica", async () => {
  const results = await Promise.all([provide(), provide()]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect((await provide()).ok).toBe(false);
  expect(
    (
      await pool.query(
        "select id from event_log where organization_id=$1 and event_type='ai.case_updated'",
        [org],
      )
    ).rowCount,
  ).toBe(1);
});
it("a entrega inicial não autoriza o novo ciclo; o comando certo mantém evento e job canônicos", async () => {
  await provide();
  const e = await event();
  expect(await reply(null)).toBe("case_unavailable");
  expect(await reply(e.payload.case_event_id)).toBe("case_unavailable");
  await sent(e.payload.case_event_id);
  const key = randomUUID();
  expect(await reply(e.payload.case_event_id, key)).toBe("accepted");
  expect(await reply(e.payload.case_event_id, key)).toBe("duplicate");
  const h = (
    await pool.query(
      "select id,metadata,actor_user_id from agent_case_events where case_id=$1 and metadata->>'whatsapp_message_key'=$2",
      [caseId, key],
    )
  ).rows[0];
  const delivery = (
    await pool.query("select id from entregas_de_aviso_de_caso where update_event_id=$1", [
      e.payload.case_event_id,
    ])
  ).rows[0];
  expect(h.metadata.delivery_id).toBe(delivery.id);
  expect(h.actor_user_id).toBeNull();
  expect(h.metadata.update_event_id).toBe(e.payload.case_event_id);
  expect(
    (
      await pool.query(
        "select payload from job_queue where organization_id=$1 and kind='case_reply_turn'",
        [org],
      )
    ).rows[0].payload,
  ).toMatchObject({case_id:caseId,action:"resolved",body:"Autorizado somente neste pedido"});
  expect(await current(e)).toBeNull();
});
it("o segundo ciclo do mesmo Caso tem identidade própria e recusa comando/turno antigos", async () => {
  await provide();
  const first = await event();
  await sent(first.payload.case_event_id);
  expect(await reply(first.payload.case_event_id, randomUUID(), "need_lead_info")).toBe("accepted");
  const latest = (
    await pool.query(
      "select id from agent_case_events where case_id=$1 and kind='human_replied' order by created_at desc,id desc limit 1",
      [caseId],
    )
  ).rows[0].id;
  expect((await provide(askId)).ok).toBe(false);
  expect((await provide(latest)).ok).toBe(true);
  const second = await event();
  expect(second.payload.case_event_id).not.toBe(first.payload.case_event_id);
  expect(await current(first)).toBeNull();
  expect(await current(second)).not.toBeNull();
  await sent(second.payload.case_event_id);
  expect(await reply(first.payload.case_event_id)).toBe("case_unavailable");
  expect(await reply(second.payload.case_event_id)).toBe("accepted");
  expect(
    (await pool.query("select id from entregas_de_aviso_de_caso where case_id=$1", [caseId]))
      .rowCount,
  ).toBe(3);
});
it("isolamento, alteração do destino e nova fronteira impedem reaproveitamento", async () => {
  expect(
    (
      await provideCaseUpdate(
        pool,
        { tenantId: other, conversationId: conv },
        { caseId, info: "não é deste tenant" },
      )
    ).ok,
  ).toBe(false);
  await provide();
  const e = await event();
  expect(await current(e, other)).toBeNull();
  await pool.query(
    "update config_aviso_de_caso set updated_at=clock_timestamp(),telefone_destino='+5511990000103' where organization_id=$1",
    [org],
  );
  expect(await current(e)).toBeNull();
  await pool.query("update config_aviso_de_caso set telefone_destino=$2 where organization_id=$1", [
    org,
    phone,
  ]);
  const cfg = (
    await pool.query(
      "select updated_at::text v from config_aviso_de_caso where organization_id=$1",
      [org],
    )
  ).rows[0].v;
  e.payload.config_revision = cfg;
  await pool.query("update conversations set service_revision=2 where id=$1", [conv]);
  expect(await current(e)).toBeNull();
});

/**
 * A fronteira decide o aviso, o comando e o que o modelo lê, nunca se a resposta do
 * cliente fica no caso. Cada cenário vence a fronteira de um jeito e cobra as MESMAS
 * consequências: o caso continua achável no turno sem o pedido antigo, a resposta é
 * gravada e marcada, o caso volta a esperar a equipe, o aviso não sai e o WhatsApp
 * não comanda mais este ciclo (na main o comando da abertura era aceito aqui; agora
 * só a tela responde).
 */
async function cobraFronteiraVencida() {
  const caso = await getCaseAwaitingLead(pool, org, conv);
  expect(caso).toMatchObject({ id: caseId, eventId: askId, title: "Escolha", ask: null });
  const bloco = blocoDoCasoAguardandoCliente(caso);
  expect(bloco).toContain(caseId);
  expect(bloco).not.toContain("Qual opção?");
  expect(await provide()).toEqual({ ok: true, foraDaFronteira: true });
  expect(
    (await pool.query("select status from agent_cases where id=$1", [caseId])).rows[0].status,
  ).toBe("awaiting_human");
  const provided = await pool.query(
    "select id from agent_case_events where case_id=$1 and kind='lead_provided' and body='Primeira opção' order by created_at desc,id desc",
    [caseId],
  );
  expect(provided.rowCount).toBeGreaterThan(0);
  const e = await event();
  expect(e.payload.case_event_id).toBe(provided.rows[0].id);
  expect(await marcaDaResposta(e.payload.case_event_id)).toBe(true);
  expect((await lerEventosDoCaso(pool, org, caseId)).at(-1)).toMatchObject({
    rotulo: "O cliente respondeu fora do atendimento atual (sem aviso no WhatsApp)",
    corpo: "Primeira opção",
  });
  expect(await current(e)).toBeNull();
  expect(await reply(null)).toBe("case_unavailable");
  await sent(e.payload.case_event_id);
  expect(await reply(e.payload.case_event_id)).toBe("case_unavailable");
}
it("conversa fechada e reaberta: a resposta fica no caso e só o aviso e o comando caem", async () => {
  await pool.query("update conversations set status='closed' where id=$1", [conv]);
  await pool.query("update conversations set status='ai_handling' where id=$1", [conv]);
  expect(
    Number(
      (await pool.query("select service_revision from conversations where id=$1", [conv])).rows[0]
        .service_revision,
    ),
  ).toBeGreaterThan(1);
  expect(await pedidoNoContexto()).toBeNull();
  await cobraFronteiraVencida();
});
it("próximo passo da demanda alterado: a resposta fica no caso e só o aviso e o comando caem", async () => {
  const demanda = (
    await pool.query(
      "insert into demandas(organization_id,contact_id,agent_case_id) values($1,$2,$3) returning id,revision",
      [org, contact, caseId],
    )
  ).rows[0];
  await pool.query("update conversations set current_demanda_id=$2 where id=$1", [conv, demanda.id]);
  await pool.query(
    "update agent_cases set context_snapshot=jsonb_set(jsonb_set(context_snapshot,'{service_boundary,demanda_id}',to_jsonb($2::text)),'{service_boundary,demanda_revision}',to_jsonb($3::int)) where id=$1",
    [caseId, demanda.id, demanda.revision],
  );
  // Controle: com a demanda intacta, a mesma resposta gera aviso.
  expect(await provide()).toEqual({ ok: true, foraDaFronteira: false });
  expect(await current(await event())).not.toBeNull();
  await ask();
  expect((await getCaseAwaitingLead(pool, org, conv))?.ask).toBe("Qual opção?");
  await pool.query("update demandas set proximo_passo='Conferir a segunda opção' where id=$1", [
    demanda.id,
  ]);
  expect(
    Number((await pool.query("select revision from demandas where id=$1", [demanda.id])).rows[0].revision),
  ).toBeGreaterThan(Number(demanda.revision));
  expect(await pedidoNoContexto()).toBeNull();
  await cobraFronteiraVencida();
});
it("caso de grupo: a resposta fica no caso e só o aviso e o comando caem", async () => {
  await pool.query("update conversations set is_group=true where id=$1", [conv]);
  await cobraFronteiraVencida();
});
it("caso legado sem fronteira ainda gera aviso", async () => {
  await pool.query(
    "update agent_cases set context_snapshot=context_snapshot-'service_boundary' where id=$1",
    [caseId],
  );
  await pool.query("update conversations set service_revision=2 where id=$1", [conv]);
  expect((await getCaseAwaitingLead(pool, org, conv))?.ask).toBe("Qual opção?");
  expect(await provide()).toEqual({ ok: true, foraDaFronteira: false });
  expect(await current(await event())).toMatchObject({ info: "Primeira opção", ask: "Qual opção?" });
});
it("modo responsavel: o celular pessoal não comanda; o recuo ao número da empresa comanda", async () => {
  await pool.query("update config_aviso_de_caso set destino_modo='responsavel' where organization_id=$1", [org]);
  await provide();
  const e = await event();
  const celular = "+5511990000104";
  await pool.query(
    "insert into entregas_de_aviso_de_caso(organization_id,case_id,destino,channel_session_id,status,enviado_em,update_event_id) values($1,$2,$3,$4,'enviado',now(),$5)",
    [org, caseId, celular, session, e.payload.case_event_id],
  );
  expect(await reply(e.payload.case_event_id, randomUUID(), "resolved", celular)).toBe("unauthorized");
  expect(await reply(e.payload.case_event_id)).toBe("case_unavailable");
  await sent(e.payload.case_event_id);
  expect(await reply(e.payload.case_event_id)).toBe("accepted");
});
