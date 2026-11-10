import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov, GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER } from "./gov-helpers";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { listarSugestoesDaConversa } from "@/lib/agent-engine/agent/sugestoes-da-conversa";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

// Fixture copiada de tests/invariants/autonomia-replies.test.ts (não é exportada).
async function fixture() {
  const org = randomUUID(),
    contact = randomUUID(),
    agent = randomUUID(),
    version = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Replies','Replies')",
    [org],
  );
  for (const [user, role] of [
    [GOV_AGENT_A, "agent"],
    [GOV_AGENT_B, "agent"],
    [GOV_VIEWER, "viewer"],
  ])
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())",
      [org, user, role],
    );
  await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Contato')", [
    contact,
    org,
  ]);
  const boundary = await criarOrigemDeFollowup(pool, org, contact),
    conversation = boundary.conversation_id;
  await pool.query(
    "update conversations set assigned_to_user_id=$1 where organization_id=$2 and id=$3",
    [GOV_AGENT_A, org, conversation],
  );
  const channel = (
    await pool.query(
      "select channel_session_id from conversations where organization_id=$1 and id=$2",
      [org, conversation],
    )
  ).rows[0].channel_session_id;
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Assistente','Ajude com informações confirmadas.','assisted')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Ajude com informações confirmadas.','anthropic','test-model',$4,'published')",
    [version, org, agent, channel],
  );
  await pool.query(
    "update ai_agents set published_version_id=$1 where organization_id=$2 and id=$3",
    [version, org, agent],
  );
  return { org, contact, agent, version, conversation, channel, boundary };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function begin(f: F) {
  return (
    await pool.query("select * from fn_reply_begin($1,$2,$3,$4,$5)", [
      f.org,
      f.conversation,
      f.agent,
      f.version,
      randomUUID(),
    ])
  ).rows[0];
}

async function pending(f: F) {
  const d = await begin(f);
  await pool.query(
    "update ai_reply_drafts set status='pending',original_body='Olá',edited_body='Olá' where organization_id=$1 and id=$2",
    [f.org, d.id],
  );
  return d;
}

/** A geração falhou. `aprovada` = a pessoa já tinha aprovado e o ENVIO falhou. */
async function falhar(f: F, d: { id: string }, aprovada = false) {
  await pool.query(
    "update ai_reply_drafts set status='failed', error_code='no_candidate', approved_body=$3 where organization_id=$1 and id=$2",
    [f.org, d.id, aprovada ? "Olá" : null],
  );
}

/** Uma mensagem de saída criada agora, depois da sugestão. */
async function mensagemDeSaida(f: F, status: string) {
  await pool.query(
    "insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body) values($1::uuid,$2,$3,$4,$5,'text','outbound',$6,'ai','Resposta')",
    [randomUUID(), f.org, f.conversation, f.channel, f.contact, status],
  );
}

async function status(f: F) {
  return (await listarSugestoesDaConversa(pool, f.org, f.conversation))[0]?.status;
}

async function revisaoDaConversa(f: F) {
  return (
    await pool.query(
      "select reply_context_revision::text as r from conversations where organization_id=$1 and id=$2",
      [f.org, f.conversation],
    )
  ).rows[0].r as string;
}

async function current(f: F, id: unknown) {
  return (await pool.query("select fn_reply_context_current($1,$2) as current", [f.org, id]))
    .rows[0].current;
}

it("a: falha de geração sem nada depois continua 'failed' (não aposenta demais)", async () => {
  const f = await fixture(),
    d = await pending(f);
  await falhar(f, d);
  expect(await status(f)).toBe("failed");
});

it("b: falha de geração + saída enviada depois vira 'stale'", async () => {
  const f = await fixture(),
    d = await pending(f);
  await falhar(f, d);
  expect(await status(f)).toBe("failed");
  await mensagemDeSaida(f, "sent");
  expect(await status(f)).toBe("stale");
});

it("c: falha + só uma saída que também falhou depois continua 'failed'", async () => {
  const f = await fixture(),
    d = await pending(f);
  await falhar(f, d);
  await mensagemDeSaida(f, "failed");
  expect(await status(f)).toBe("failed");
});

it("d: falha + revisão do contexto andou (sem saída) vira 'stale'", async () => {
  const f = await fixture(),
    d = await pending(f);
  await falhar(f, d);
  expect(await status(f)).toBe("failed");
  const antes = await revisaoDaConversa(f);
  // bot_silenced_until é campo observado pelo gatilho fn_reply_conversation_revision.
  await pool.query(
    "update conversations set bot_silenced_until=now()+interval '1 hour' where organization_id=$1 and id=$2",
    [f.org, f.conversation],
  );
  expect(Number(await revisaoDaConversa(f))).toBeGreaterThan(Number(antes));
  expect(await status(f)).toBe("stale");
});

it("e: falha de ENVIO (approved_body preenchido) + saída depois continua 'failed'", async () => {
  const f = await fixture(),
    d = await pending(f);
  await falhar(f, d, true);
  await mensagemDeSaida(f, "sent");
  expect(await status(f)).toBe("failed");
});

it("f: contato bloqueado não faz o aviso de falha sumir", async () => {
  const f = await fixture(),
    d = await pending(f);
  await falhar(f, d);
  const antes = await revisaoDaConversa(f);
  // O gatilho de is_blocked só mexe em contato_trava_humano, que não entra na
  // revisão do contexto: por isso o bloqueio é construível sem mudar revisão.
  await pool.query("update contacts set is_blocked=true where organization_id=$1 and id=$2", [
    f.org,
    f.contact,
  ]);
  expect(await revisaoDaConversa(f)).toBe(antes);
  expect(await current(f, d.id)).toBe(false);
  expect(await status(f)).toBe("failed");
});

it("g: isolamento: saída posterior em OUTRA organização não aposenta a falha", async () => {
  const f = await fixture(),
    d = await pending(f);
  await falhar(f, d);
  const outra = await fixture();
  await mensagemDeSaida(outra, "sent");
  expect(await status(f)).toBe("failed");
});

it("h: regressão: sugestão pendente cujo contexto mudou continua 'stale'", async () => {
  const f = await fixture();
  await pending(f);
  expect(await status(f)).toBe("pending");
  await pool.query(
    "update conversations set bot_silenced_until=now()+interval '1 hour' where organization_id=$1 and id=$2",
    [f.org, f.conversation],
  );
  expect(await status(f)).toBe("stale");
});
