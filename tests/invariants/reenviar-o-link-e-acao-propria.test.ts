/**
 * REENVIAR O LINK É UMA AÇÃO PRÓPRIA, E O `deliver` CONTINUA PROTEGIDO.
 *
 * ## O que este arquivo guarda
 *
 * O `return false` de `fn_meet_action` em estado `sent` não é uma limitação: é
 * a proteção contra clique duplo. O reenvio explícito existe porque quem já
 * enviou e precisa enviar de novo não tinha caminho pelo produto — mas ele NÃO
 * pode ser obtido afrouxando o `deliver`, senão ganha-se o reenvio e perde-se a
 * proteção no mesmo movimento. Envio em dobro para cliente é pior que
 * não-envio.
 *
 * Três asserções, e cada uma cobre um jeito diferente de o conserto virar
 * defeito:
 *
 *   1. `deliver` em estado `sent` continua devolvendo `false` — se alguém
 *      "simplificar" removendo o `p_action='deliver' and`, este caso vermelha;
 *   2. `resend` no mesmo estado PASSA, e supersede o que estava na fila em vez
 *      de somar uma segunda entrega;
 *   3. `resend` NÃO é porta lateral: os gates de papel e de MFA que valem para
 *      o `deliver` valem para ele — ação nova é o lugar clássico onde uma
 *      guarda fica para trás.
 *
 * ## O que ele NÃO prova
 *
 * Nada do lado da tela (a confirmação antes do reenvio está em
 * `tests/unit/agenda-meet-ui.test.tsx` e na spec de e2e), e nada sobre o texto
 * que chega ao cliente — o reenvio manda a mesma frase do primeiro envio, de
 * propósito.
 *
 * Recorte do PR #803, de @paulolimajr77 — o invariante é acréscimo da triagem:
 * o PR trouxe a capacidade e os testes de tela, e nenhum caso exercitava a
 * função no Postgres.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedGov, GOV_AGENT_A, GOV_VIEWER } from "./gov-helpers";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { appointmentSnapshotSchema, expectedAppointment } from "@/lib/agenda/google/sync-store";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

beforeAll(() => seedGov());
afterAll(() => pool.end());

/** Compromisso com Meet pronto e uma conversa de destino válida. */
async function fixture() {
  const org = randomUUID();
  const id = randomUUID();
  const contact = randomUUID();
  const conn = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Reenvio','Reenvio')",
    [org],
  );
  for (const [user, role] of [
    [GOV_AGENT_A, "agent"],
    [GOV_VIEWER, "viewer"],
  ])
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())",
      [org, user, role],
    );
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Cliente','Cliente')",
    [contact, org],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  await pool.query(
    "insert into calendar_connections(id,organization_id,user_id,provider,account_email,status) values($1,$2,$3,'google_calendar',$4,'healthy')",
    [conn, org, GOV_AGENT_A, `${conn}@example.test`],
  );
  await pool.query(
    "insert into calendar_connection_calendars(organization_id,connection_id,external_calendar_id,name,is_destination,access_role,allowed_conference_types) values($1,$2,'meet-calendar','Meet',true,'owner',array['hangoutsMeet'])",
    [org, conn],
  );
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,status,location_kind) values($1,$2,$3,$4,$5,'Reunião',now()+interval '4 days',now()+interval '4 days 1 hour','confirmed','google_meet')",
    [id, org, contact, boundary.conversation_id, GOV_AGENT_A],
  );
  const a = appointmentSnapshotSchema.parse(
    (await pool.query("select fn_google_appointment($1,$2,'claim','{}') r", [org, id])).rows[0].r,
  );
  await pool.query("select fn_google_appointment($1,$2,'meet',$3) r", [
    org,
    id,
    {
      ...expectedAppointment(a),
      result: {
        state: "ready",
        received: true,
        url: "https://meet.google.com/abc-defg-hij",
        error: null,
        etag: "v1",
      },
    },
  ]);
  return { org, id, contact, boundary, revisao: a.revision, pedido: a.meeting_request_id };
}

/** Executa como um usuário de verdade: papel `authenticated` e claims no JWT. */
async function comoUsuario(
  user: string | null,
  args: unknown[],
  aal: "aal1" | "aal2" = "aal2",
): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: user ? "authenticated" : "anon", aal }),
    ]);
    const r = await c.query("select fn_meet_action($1,$2,$3,$4,$5,$6) r", args);
    await c.query("commit");
    return r.rows[0].r as boolean;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function entrega(id: string) {
  return (await pool.query("select meeting_delivery d from calendar_appointments where id=$1", [id]))
    .rows[0].d as Record<string, unknown>;
}

it("⛔ `deliver` continua devolvendo false em estado `sent` — a proteção contra clique duplo", async () => {
  const f = await fixture();
  const alvo = [f.org, f.id, f.revisao, f.pedido, "deliver", f.boundary.conversation_id];
  expect(await comoUsuario(GOV_AGENT_A, alvo)).toBe(true);
  // O worker teria marcado `sent`; aqui o estado é posto direto porque o que
  // está sob teste é a DECISÃO da função, não o caminho do envio.
  await pool.query(
    "update calendar_appointments set meeting_delivery=meeting_delivery||'{\"state\":\"sent\"}' where id=$1",
    [f.id],
  );
  expect(await comoUsuario(GOV_AGENT_A, alvo)).toBe(false);
});

it("⛔ `resend` no mesmo estado PASSA, e SUPERSEDE em vez de somar uma segunda entrega", async () => {
  const f = await fixture();
  const conversa = f.boundary.conversation_id;
  expect(
    await comoUsuario(GOV_AGENT_A, [f.org, f.id, f.revisao, f.pedido, "deliver", conversa]),
  ).toBe(true);
  // Com o link pronto, o gatilho do enfileirador já põe a entrega na fila: o
  // estado imediato é `queued`, não `waiting_for_link`. Eu tinha escrito
  // `waiting_for_link` aqui e o Postgres me corrigiu — fica registrado porque a
  // diferença é o que este caso mede.
  const antes = await entrega(f.id);
  expect(antes.state).toBe("queued");
  const jobAntes = (
    await pool.query("select meeting_delivery_job_id j from calendar_appointments where id=$1", [
      f.id,
    ])
  ).rows[0].j as string;
  expect(jobAntes).toBeTruthy();

  await pool.query(
    "update calendar_appointments set meeting_delivery=meeting_delivery||'{\"state\":\"sent\"}' where id=$1",
    [f.id],
  );
  expect(
    await comoUsuario(GOV_AGENT_A, [f.org, f.id, f.revisao, f.pedido, "resend", conversa]),
  ).toBe(true);

  const depois = await entrega(f.id);
  const jobDepois = (
    await pool.query("select meeting_delivery_job_id j from calendar_appointments where id=$1", [
      f.id,
    ])
  ).rows[0].j as string;
  // Geração NOVA: é ela que faz a entrega anterior ser SUPERADA, em vez de a
  // segunda sair como uma cópia autorizada pela mesma decisão.
  expect(depois.generation).not.toBe(antes.generation);
  expect(jobDepois).toBeTruthy();
  expect(jobDepois).not.toBe(jobAntes);
  // E o job anterior não fica vivo na fila esperando a vez: quem reenvia
  // substitui, não soma. Duas entregas pendentes para o mesmo compromisso
  // seriam duas mensagens ao cliente.
  const anterior = (
    await pool.query("select status,last_error from job_queue where id=$1", [jobAntes])
  ).rows[0];
  expect(anterior.status).toBe("failed");
  expect(anterior.last_error).toBe("meet_delivery_superseded");
});

it("⛔ `resend` NÃO é porta lateral: papel e MFA valem como no `deliver`", async () => {
  const f = await fixture();
  const alvo = [f.org, f.id, f.revisao, f.pedido, "resend", f.boundary.conversation_id];
  // `viewer` não manda nada ao cliente, nem pelo caminho novo.
  await expect(comoUsuario(GOV_VIEWER, alvo)).rejects.toThrow("meet_forbidden");

  // MFA: `fn_session_mfa_proven` só COBRA de quem tem fator verificado — então
  // sem plantar o fator este caso ficaria verde por ausência, não por guarda.
  const fator = randomUUID();
  await pool.query(
    "insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')",
    [fator, GOV_AGENT_A],
  );
  try {
    await expect(comoUsuario(GOV_AGENT_A, alvo, "aal1")).rejects.toThrow("meet_mfa_required");
    // CONTROLE POSITIVO, com o MESMO fator de pé: provada a verificação, passa.
    // Sem ele, o caso acima poderia estar vermelho por fixture errada.
    expect(await comoUsuario(GOV_AGENT_A, alvo, "aal2")).toBe(true);
  } finally {
    await pool.query("delete from auth.mfa_factors where id=$1", [fator]);
  }
});
