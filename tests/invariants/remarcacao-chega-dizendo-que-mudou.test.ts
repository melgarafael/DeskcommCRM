/**
 * A CORREÇÃO DA REMARCAÇÃO CHEGA AO CLIENTE, E DIZ QUE MUDOU.
 *
 * ## Por que este arquivo existe
 *
 * Sabotei o worker — fiz o motivo virar `primeiro_envio` fixo — e o único
 * vermelho que apareceu foi um TIMEOUT de 15s sob carga, não uma asserção.
 * Ou seja: nada cobria o worker LER o motivo do payload. A cadeia inteira podia
 * estar certa (gatilho grava `remarcado`, enfileirador copia para o job) e o
 * cliente receber a frase errada — "está marcado para", como se fosse a
 * primeira vez, com uma data diferente da que ele já tinha.
 *
 * Este arquivo prova a cadeia INTEIRA pelo caminho de produção: remarcar →
 * gatilho → enfileirador → worker real → receptor HTTP, e lê a frase que
 * chegou do outro lado.
 *
 * ## As duas direções
 *
 *   1. remarcação → a mensagem diz que MUDOU;
 *   2. primeiro envio → a mensagem NÃO diz que mudou.
 *
 * Sem a segunda, um worker que dissesse "mudou" sempre passaria na primeira.
 *
 * Recorte do PR #803, de @paulolimajr77 — o arquivo é acréscimo da triagem.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { meetPgSupabase } from "../support/meet-pg-supabase";
import { createAdminClient } from "@/lib/supabase/admin";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { seedGov, GOV_AGENT_A } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

/** Compromisso pronto para entregar, com canal e contato que aceitam receber. */
async function cenario(local: string, meetingState: string, url: string | null) {
  const org = randomUUID();
  const id = randomUUID();
  const contact = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'SemLink','SemLink')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [org, GOV_AGENT_A],
  );
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name,phone_number,ai_authorized_at) values($1,$2,'Cliente','Cliente','+15551234567',now())",
    [contact, org],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  const canal = (
    await pool.query("select channel_session_id c from conversations where id=$1", [
      boundary.conversation_id,
    ])
  ).rows[0].c as string;
  // Sem throttle e com janela de 24h: o que está sob teste é o conteúdo da
  // mensagem, não a régua de anti-banimento.
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour) values($1,$2,0,0,0,24)",
    [org, canal],
  );
  await pool.query(
    "update conversations set assignee_kind='ai',bot_silenced_until=null where id=$1",
    [boundary.conversation_id],
  );
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,
       starts_at,ends_at,time_zone,status,location_kind,meeting_state,meeting_url,meeting_request_id)
     values($1,$2,$3,$4,$5,'Compromisso',now()+interval '4 days',now()+interval '4 days 1 hour','America/Sao_Paulo','confirmed',$6,$7,$8,gen_random_uuid())`,
    [id, org, contact, boundary.conversation_id, GOV_AGENT_A, local, meetingState, url],
  );
  return { org, id, contact, boundary };
}

/** Autoriza pelo caminho real — `fn_meet_action`, como a tela faz. */
async function autorizar(f: Awaited<ReturnType<typeof cenario>>) {
  const a = (
    await pool.query(
      "select revision::text r, meeting_request_id q from calendar_appointments where id=$1",
      [f.id],
    )
  ).rows[0];
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: GOV_AGENT_A, role: "authenticated", aal: "aal2" }),
    ]);
    await c.query("select fn_meet_action($1,$2,$3,$4,'deliver',$5)", [
      f.org,
      f.id,
      a.r,
      a.q,
      f.boundary.conversation_id,
    ]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Roda o worker DE VERDADE contra um receptor HTTP, e devolve o que saiu. */
async function entregar(f: Awaited<ReturnType<typeof cenario>>): Promise<string[]> {
  const jid = (
    await pool.query("select meeting_delivery_job_id j from calendar_appointments where id=$1", [
      f.id,
    ])
  ).rows[0].j as string | null;
  expect(jid, "o gatilho não enfileirou — o defeito é antes do worker").toBeTruthy();
  const textos: string[] = [];
  const receiver = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const corpo = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    textos.push(String(corpo.text ?? ""));
    res.end(JSON.stringify({ id: `msg-${textos.length}` }));
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const addr = receiver.address();
  if (!addr || typeof addr === "string") throw Error("receiver");
  const urlAnterior = process.env.WAHA_API_BASE_URL;
  const chaveAnterior = process.env.WAHA_API_KEY;
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.WAHA_API_KEY = "receiver-only";
  try {
    const db = meetPgSupabase(pool);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const { createMeetDeliveryHandler } = await import("@/lib/agent-engine/agent/meet-delivery");
    const run = createMeetDeliveryHandler({
      crmCfg: { supabase: db.client },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: async () => {},
    } as never);
    // ⚠️ `locked_at::text`: o porteiro compara o instante por igualdade exata, e
    // o `Date` do driver trunca os microssegundos do `timestamptz`. Com `Date`,
    // a entrega é recusada por RELÓGIO e não por regra — medido.
    const job = (
      await pool.query(
        "update job_queue set status='running',locked_by='meet-worker',locked_at=clock_timestamp(),attempts=attempts+1 where id=$1 returning *,locked_at::text claim_acquired_at",
        [jid],
      )
    ).rows[0];
    await run(job, pool);
  } finally {
    if (urlAnterior === undefined) delete process.env.WAHA_API_BASE_URL;
    else process.env.WAHA_API_BASE_URL = urlAnterior;
    if (chaveAnterior === undefined) delete process.env.WAHA_API_KEY;
    else process.env.WAHA_API_KEY = chaveAnterior;
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  }
  return textos;
}

it("⛔ remarcar depois de enviado: a correção chega DIZENDO que mudou", async () => {
  const link = "https://meet.google.com/abc-defg-hij";
  const f = await cenario("google_meet", "ready", link);
  await autorizar(f);
  const primeiro = await entregar(f);
  expect(primeiro, "o primeiro envio não saiu — o defeito é antes da remarcação").toHaveLength(1);
  expect(primeiro[0]).not.toMatch(/mudou/i);

  // Remarcar: o gatilho grava `motivo:remarcado` e o enfileirador o copia para
  // o payload do job. A espera de 2 min vai para o `run_after`, e aqui ela é
  // encurtada porque o que está sob teste é a FRASE, não o relógio da fila.
  await pool.query(
    "update calendar_appointments set starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' where id=$1",
    [f.id],
  );
  await pool.query(
    "update job_queue set run_after=now() where organization_id=$1 and kind='transactional_delivery' and status='pending'",
    [f.org],
  );
  const correcao = await entregar(f);
  expect(correcao, "a correção não saiu").toHaveLength(1);
  expect(correcao[0]).toMatch(/mudou/i);
  expect(correcao[0]).toContain(link);
});

it("⛔ CONTROLE: o primeiro envio NÃO diz que mudou", async () => {
  // Sem este par, um worker que dissesse "mudou" para todo mundo passaria no
  // caso acima — e o cliente leria "o horário mudou" na primeira mensagem que
  // recebe, sobre um horário que nunca mudou.
  const f = await cenario("in_person", "not_requested", null);
  await autorizar(f);
  const textos = await entregar(f);
  expect(textos).toHaveLength(1);
  expect(textos[0]).not.toMatch(/mudou/i);
});
