import type pg from "pg";
import { MissionError, activeStatuses, type MissionInput } from "./schema";
import { callSuggestions, serializeCallContext, type ContextMessage } from "./context";

export async function conversationForMission(
  db: pg.Pool | pg.PoolClient,
  org: string,
  conversation: string,
) {
  const { rows } = await db.query(
    `select c.id,c.contact_id,c.active_ai_agent_id,c.status,c.is_group,p.name,p.phone_number,p.is_blocked,p.is_anonymized,
    o.display_name as company from conversations c join contacts p on p.id=c.contact_id and p.organization_id=c.organization_id
    join organizations o on o.id=c.organization_id where c.organization_id=$1 and c.id=$2`,
    [org, conversation],
  );
  const c = rows[0];
  if (!c || c.is_anonymized) throw new MissionError("Atendimento não encontrado.", 404);
  return c;
}

export async function readMissions(pool: pg.Pool, org: string, conversation: string, user: string) {
  const c = await conversationForMission(pool, org, conversation);
  const [missions, agents, channels, contacts, voice, recent] = await Promise.all([
    pool.query(
      `select id,objective,agent_id,channel_id,test_contact_id,test,status,result,error,cancel_requested,created_at,started_at,ended_at
      from voice_missions where organization_id=$1 and conversation_id=$2 and (status<>'draft' or created_by=$3) order by created_at desc limit 20`,
      [org, conversation, user],
    ),
    pool.query(
      `select id,name,is_default,(is_active and published_version_id is not null) as ready from ai_agents where organization_id=$1 and archived_at is null order by name`,
      [org],
    ),
    pool.query(
      `select id,display_name as name,phone_number,status,(status='WORKING' and wacalls_session_id is not null and wacalls_paired_at is not null) as ready from channel_sessions where organization_id=$1 and provider='wacalls' and archived_at is null`,
      [org],
    ),
    pool.query(
      `select id,name,phone_number from contacts where organization_id=$1 and not is_anonymized and not is_blocked and phone_number is not null order by updated_at desc limit 100`,
      [org],
    ),
    pool.query("select enabled from org_voice_calls where organization_id=$1", [org]),
    pool.query<ContextMessage>(
      `select id,direction,body,sent_at from messages where organization_id=$1 and conversation_id=$2 and revoked_at is null and body is not null and btrim(body)<>'' order by sent_at desc,id desc limit 40`,
      [org, conversation],
    ),
  ]);
  const readyAgents = agents.rows.filter((a) => a.ready);
  const defaultAgents = readyAgents.filter((a) => a.is_default);
  const readyChannels = channels.rows.filter((c) => c.ready);
  return {
    voice: {
      configured: !!(process.env.WACALLS_API_BASE_URL && process.env.WACALLS_API_TOKEN),
      enabled: voice.rows[0]?.enabled === true,
    },
    defaults: {
      agent_id:
        readyAgents.find((a) => a.id === c.active_ai_agent_id)?.id ??
        (defaultAgents.length === 1 ? defaultAgents[0].id : null) ??
        (readyAgents.length === 1 ? readyAgents[0].id : null),
      channel_id: readyChannels.length === 1 ? readyChannels[0].id : null,
    },
    contact: { name: c.name, phone: c.phone_number },
    suggestions: callSuggestions(recent.rows),
    missions: missions.rows,
    agents: agents.rows,
    channels: channels.rows,
    contacts: contacts.rows,
  };
}

export async function saveMission(
  pool: pg.Pool,
  org: string,
  user: string,
  conversation: string,
  input: MissionInput,
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `voice-mission:${org}`,
    ]);
    const c = await conversationForMission(db, org, conversation);
    const { rows: old } = await db.query(`select * from voice_missions where id=$1 for update`, [
      input.id,
    ]);
    if (
      old[0] &&
      (old[0].organization_id !== org ||
        old[0].conversation_id !== conversation ||
        old[0].created_by !== user)
    )
      throw new MissionError("Este pedido não está disponível.", 404);
    if (input.action === "cancel") {
      if (!old[0]) throw new MissionError("Pedido não encontrado.", 404);
      await db.query(
        `update voice_missions set cancel_requested=true,status=case when status in ('draft','queued') then 'cancelled' else status end,updated_at=now() where id=$1`,
        [input.id],
      );
      await db.query("commit");
      return { id: input.id };
    }
    if (old[0] && old[0].status !== "draft") {
      if (
        input.action === "start" &&
        old[0].objective === input.objective &&
        old[0].agent_id === input.agent_id &&
        old[0].channel_id === input.channel_id &&
        old[0].test === input.test &&
        old[0].test_contact_id === input.test_contact_id
      ) {
        await db.query("commit");
        return { id: input.id };
      }
      throw new MissionError("Este pedido já foi iniciado. Atualize o acompanhamento.", 409);
    }
    for (const [id, table, condition] of [
      [input.agent_id, "ai_agents", "archived_at is null"],
      [input.channel_id, "channel_sessions", "provider='wacalls' and archived_at is null"],
      [input.test_contact_id, "contacts", "not is_anonymized and not is_blocked"],
    ] as const) {
      if (id) {
        const found = await db.query(
          `select id from ${table} where organization_id=$1 and id=$2 and ${condition}`,
          [org, id],
        );
        if (!found.rowCount)
          throw new MissionError("Uma das escolhas não está disponível nesta empresa.");
      }
    }
    if (input.action === "start") {
      if (
        !process.env.OPENAI_API_KEY ||
        !process.env.WACALLS_API_BASE_URL ||
        !process.env.WACALLS_API_TOKEN
      )
        throw new MissionError("A ligação por IA ainda não está disponível neste servidor.", 503);
      const worker = await db.query(
        "select 1 from voice_mission_runtime where id=1 and heartbeat_at>now()-interval '30 seconds'",
      );
      if (!worker.rowCount)
        throw new MissionError(
          "O serviço de ligação está reconectando. Salve o pedido e tente novamente em instantes.",
          503,
        );
      if (c.is_group || c.is_blocked || ["closed", "archived", "resolved"].includes(c.status))
        throw new MissionError("Escolha um atendimento individual aberto e um contato permitido.");
      if (!input.test && !c.phone_number)
        throw new MissionError(
          "Cadastre o telefone do contato antes de ligar ou escolha um contato de teste.",
        );
      if (input.objective.length < 8)
        throw new MissionError("Conte o que a IA precisa resolver nesta ligação.");
      if (!input.agent_id || !input.channel_id || (input.test && !input.test_contact_id))
        throw new MissionError(
          "Escolha o agente, o número de saída e, para testar, o contato de teste.",
        );
      const allowed = await db.query(
        `select 1 from org_voice_calls where organization_id=$1 and enabled`,
        [org],
      );
      if (!allowed.rowCount)
        throw new MissionError("Ative as chamadas da empresa em Conexões antes de ligar.");
      const ready = await db.query(
        `select 1 from ai_agents where organization_id=$1 and id=$2 and is_active and published_version_id is not null`,
        [org, input.agent_id],
      );
      if (!ready.rowCount) throw new MissionError("Publique e ative o agente antes de ligar.");
      const paired = await db.query(
        `select 1 from channel_sessions where organization_id=$1 and id=$2 and wacalls_session_id is not null and wacalls_paired_at is not null and status='WORKING'`,
        [org, input.channel_id],
      );
      if (!paired.rowCount)
        throw new MissionError(
          "Conecte o número de chamadas em Conexões. O rascunho pode ser salvo agora.",
        );
      const active = await db.query(
        `select 1 from voice_missions where organization_id=$1 and status=any($2::text[])`,
        [org, activeStatuses],
      );
      if (active.rowCount)
        throw new MissionError("Já há uma ligação por IA em andamento nesta empresa.", 409);
      const count = await db.query(
        `select count(*)::int as n from voice_missions where organization_id=$1 and started_at>now()-interval '24 hours'`,
        [org],
      );
      if (count.rows[0].n >= 20)
        throw new MissionError("O limite do piloto é de 20 ligações em 24 horas.", 429);
    }
    await db.query(
      `insert into voice_missions(id,organization_id,conversation_id,created_by,objective,agent_id,channel_id,test_contact_id,test,status)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(id) do update set objective=excluded.objective,agent_id=excluded.agent_id,channel_id=excluded.channel_id,
      test_contact_id=excluded.test_contact_id,test=excluded.test,status=excluded.status,updated_at=now()`,
      [
        input.id,
        org,
        conversation,
        user,
        input.objective,
        input.agent_id,
        input.channel_id,
        input.test_contact_id,
        input.test,
        input.action === "start" ? "queued" : "draft",
      ],
    );
    await db.query("commit");
    return { id: input.id };
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export async function missionContext(pool: pg.Pool, org: string, conversation: string) {
  const c = await conversationForMission(pool, org, conversation);
  if (c.is_blocked || c.is_group || ["closed", "archived", "resolved"].includes(c.status))
    throw new MissionError("Atendimento não está disponível para ligar.");
  const { rows } = await pool.query<ContextMessage>(
    `select direction,body,sent_at from messages where organization_id=$1 and conversation_id=$2 and revoked_at is null and body is not null order by sent_at desc,id desc limit 40`,
    [org, conversation],
  );
  return serializeCallContext(c.company, c.name, rows);
}
