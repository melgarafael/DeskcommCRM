import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  hasOpenCaseForContact,
  openCase,
  provideCaseUpdate,
  resolveCaseFromHuman,
  markAwaitingLead,
  escalateCase,
  buildCaseSummary,
  openHumanCaseInputSchema,
  type CaseIds,
} from "@/lib/agent-engine/agent/human-cases";

/**
 * Wave 2 (spec 15 — casos humanos) — repositório de dados + tools de dados. Real
 * Postgres via TEST_DB_CONTAINER (mesmo mecanismo de agent-watchdog.test.ts):
 * baseline aplicado, sem seed — as fixtures (org/contact/channel_session/conversation)
 * são inseridas aqui. NÃO existe suíte tests/unit equivalente para engine+DB real
 * (vitest.config.ts EXCLUI tests/invariants/**; vitest.db.config.ts só INCLUI
 * tests/invariants/**) — este arquivo mora aqui de propósito, não em tests/unit,
 * para rodar de fato contra Postgres via `pnpm test:db`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG_A = "cccccccc-0000-4000-8000-000000000001";
const CONTACT_A = "cccccccc-0000-4000-8000-000000000002";
const SESSION_A = "cccccccc-0000-4000-8000-000000000003";
const CONV_A = "cccccccc-0000-4000-8000-000000000004";
const ACTOR_A = "cccccccc-0000-4000-8000-000000000005";

const ORG_B = "cccccccc-0000-4000-8000-000000000011";
const CONTACT_B = "cccccccc-0000-4000-8000-000000000012";
const SESSION_B = "cccccccc-0000-4000-8000-000000000013";
const CONV_B = "cccccccc-0000-4000-8000-000000000014";

async function seedTenant(org: string, contact: string, session: string, conv: string) {
  const suffix = org.slice(-4);
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
    [org, `hc-proof-${suffix}`],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Contato de Prova', $3) on conflict (id) do nothing`,
    [contact, org, `+55119000${suffix}`],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [session, org, `hc-proof-session-${suffix}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'ai_handling', false) on conflict (id) do nothing`,
    [conv, org, contact, session],
  );
}

function ids(org: string, conv: string): CaseIds {
  return { tenantId: org, conversationId: conv };
}

/**
 * uniq_conversations_1to1_per_contact_session exige 1 conversa por (contact,
 * channel_session) — cada conversa extra do teste precisa do seu PRÓPRIO
 * contato (reaproveitando org/session já seedados).
 */
async function seedExtraConversation(
  convId: string,
  contactId: string,
  org: string,
  session: string,
) {
  const suffix = contactId.slice(-6);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Contato Extra', $3) on conflict (id) do nothing`,
    [contactId, org, `+5511800${suffix}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'ai_handling', false) on conflict (id) do nothing`,
    [convId, org, contactId, session],
  );
}

beforeAll(async () => {
  await seedTenant(ORG_A, CONTACT_A, SESSION_A, CONV_A);
  await seedTenant(ORG_B, CONTACT_B, SESSION_B, CONV_B);
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'atendente@prova.test') on conflict (id) do nothing`,
    [ACTOR_A],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("wave 2 — human-cases repositório", () => {
  it("openCase cria agent_cases(status='awaiting_human') + 1 evento 'opened'", async () => {
    const result = await openCase(pool, ids(ORG_A, CONV_A), {
      title: "Lead pediu desconto fora da política",
      summary: "Lead quer 40% de desconto; política permite até 15%.",
      blocker: "Preciso de aprovação humana para o desconto.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const caseRow = await pool.query(
      `select status, wait_started_at, wait_generation from agent_cases where id = $1`,
      [result.caseId],
    );
    expect(caseRow.rows[0]).toMatchObject({ status: "awaiting_human" });
    expect(caseRow.rows[0].wait_started_at).not.toBeNull();
    expect(Number(caseRow.rows[0].wait_generation)).toBe(1);

    const events = await pool.query(
      `select kind, actor_kind from agent_case_events where case_id = $1`,
      [result.caseId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ kind: "opened", actor_kind: "agent" });
  });

  it("hasOpenCaseForContact reflete o ciclo de vida do caso", async () => {
    expect(await hasOpenCaseForContact(pool, ORG_A, CONV_A)).toBe(true);

    // outra conversa (contato diferente), mesma org — nenhum caso aberto ainda
    const otherConv = "cccccccc-0000-4000-8000-000000000099";
    const otherContact = "cccccccc-0000-4000-8000-000000000199";
    await seedExtraConversation(otherConv, otherContact, ORG_A, SESSION_A);
    expect(await hasOpenCaseForContact(pool, ORG_A, otherConv)).toBe(false);

    const { rows } = await pool.query(`select id from agent_cases where conversation_id = $1`, [
      CONV_A,
    ]);
    const caseId = rows[0].id as string;

    await resolveCaseFromHuman(pool, ORG_A, caseId, ACTOR_A, "Aprovei o desconto de 20%.");
    expect(await hasOpenCaseForContact(pool, ORG_A, CONV_A)).toBe(false);
  });

  it("provideCaseUpdate só transiciona awaiting_lead->awaiting_human", async () => {
    const opened = await openCase(pool, ids(ORG_A, CONV_A), {
      title: "Precisa do CPF do lead",
      summary: "Lead ainda não informou o CPF para emitir a nota.",
      blocker: "Sem CPF não emite nota.",
    });
    if (!opened.ok) throw new Error("setup falhou");
    const caseId = opened.caseId;

    // de awaiting_human -> rejeita (estado errado)
    const rejected = await provideCaseUpdate(pool, ids(ORG_A, CONV_A), {
      caseId,
      info: "CPF: 000.000.000-00",
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_case_state" } });

    const beforeAsk = await pool.query(
      `select wait_started_at, wait_generation from agent_cases where id = $1`,
      [caseId],
    );
    await markAwaitingLead(pool, ORG_A, caseId, ACTOR_A, "Qual é o seu CPF?");
    const afterAsk = await pool.query(
      `select status, wait_started_at, wait_generation from agent_cases where id = $1`,
      [caseId],
    );
    expect(afterAsk.rows[0]).toMatchObject({ status: "awaiting_lead" });
    expect(Number(afterAsk.rows[0].wait_generation)).toBe(
      Number(beforeAsk.rows[0].wait_generation),
    );
    expect(afterAsk.rows[0].wait_started_at).toEqual(beforeAsk.rows[0].wait_started_at);

    const provided = await provideCaseUpdate(pool, ids(ORG_A, CONV_A), {
      caseId,
      info: "CPF: 000.000.000-00",
    });
    expect(provided).toMatchObject({ ok: true });

    const afterProvide = await pool.query(
      `select status, wait_started_at, wait_generation from agent_cases where id = $1`,
      [caseId],
    );
    expect(afterProvide.rows[0]).toMatchObject({ status: "awaiting_human" });
    expect(Number(afterProvide.rows[0].wait_generation)).toBe(
      Number(afterAsk.rows[0].wait_generation) + 1,
    );
    expect(new Date(afterProvide.rows[0].wait_started_at).getTime()).toBeGreaterThanOrEqual(
      new Date(afterAsk.rows[0].wait_started_at).getTime(),
    );

    const events = await pool.query(
      `select kind, actor_kind, human_action from agent_case_events where case_id = $1 order by created_at`,
      [caseId],
    );
    expect(events.rows.map((r) => r.kind)).toEqual([
      "opened",
      "human_replied",
      "lead_asked",
      "lead_provided",
    ]);
    expect(events.rows[3]).toMatchObject({ actor_kind: "lead" });

    // limpa esse caso para não interferir no teste de isolamento a seguir
    await escalateCase(pool, ORG_A, caseId, ACTOR_A, "sem resposta após 2 tentativas");
  });

  it("resolveCaseFromHuman: awaiting_human->resolved, closed_at setado, não pisa em já-resolvido", async () => {
    const opened = await openCase(pool, ids(ORG_A, CONV_A), {
      title: "Dúvida sobre garantia",
      summary: "Lead quer saber se o produto tem garantia estendida.",
      blocker: "Preciso confirmar política de garantia com o time.",
    });
    if (!opened.ok) throw new Error("setup falhou");
    const caseId = opened.caseId;

    const first = await resolveCaseFromHuman(
      pool,
      ORG_A,
      caseId,
      ACTOR_A,
      "Sim, tem garantia de 1 ano.",
    );
    expect(first).toBe(true);
    const row = await pool.query(`select status, closed_at from agent_cases where id = $1`, [
      caseId,
    ]);
    expect(row.rows[0].status).toBe("resolved");
    expect(row.rows[0].closed_at).not.toBeNull();

    const events = await pool.query(
      `select kind, human_action from agent_case_events where case_id = $1 order by created_at`,
      [caseId],
    );
    expect(events.rows.map((r) => r.kind)).toEqual(["opened", "human_replied", "resolved"]);
    expect(events.rows[1]).toMatchObject({ human_action: "resolved" });

    // reaplicar não pisa em terminal: nenhum evento novo, status intacto — e o
    // retorno false é o que permite a rota devolver 409 em vez de fingir sucesso
    // quando outro atendente respondeu primeiro.
    const second = await resolveCaseFromHuman(pool, ORG_A, caseId, ACTOR_A, "tentativa duplicada");
    expect(second).toBe(false);
    const eventsAfter = await pool.query(
      `select count(*)::int as n from agent_case_events where case_id = $1`,
      [caseId],
    );
    expect(eventsAfter.rows[0].n).toBe(3);
  });

  it("escalateCase transiciona awaiting_human->escalated com closed_at", async () => {
    const opened = await openCase(pool, ids(ORG_A, CONV_A), {
      title: "Reclamação grave",
      summary: "Lead ameaça processar a empresa.",
      blocker: "Precisa de decisão jurídica.",
    });
    if (!opened.ok) throw new Error("setup falhou");
    const caseId = opened.caseId;

    await escalateCase(
      pool,
      ORG_A,
      caseId,
      ACTOR_A,
      "risco jurídico — fora do escopo do time de suporte",
    );
    const row = await pool.query(`select status, closed_at from agent_cases where id = $1`, [
      caseId,
    ]);
    expect(row.rows[0].status).toBe("escalated");
    expect(row.rows[0].closed_at).not.toBeNull();

    const events = await pool.query(
      `select kind, human_action from agent_case_events where case_id = $1 order by created_at`,
      [caseId],
    );
    expect(events.rows.map((r) => r.kind)).toEqual(["opened", "human_replied", "escalated"]);
    expect(events.rows[1]).toMatchObject({ human_action: "escalate" });
  });

  it("openCase recusa 2º caso aberto para a mesma conversa (dedup fail-safe)", async () => {
    const conv = "cccccccc-0000-4000-8000-000000000098";
    const contact = "cccccccc-0000-4000-8000-000000000198";
    await seedExtraConversation(conv, contact, ORG_A, SESSION_A);
    const first = await openCase(pool, ids(ORG_A, conv), {
      title: "Primeiro caso",
      summary: "Primeiro bloqueio.",
      blocker: "Primeiro motivo.",
    });
    expect(first.ok).toBe(true);

    const second = await openCase(pool, ids(ORG_A, conv), {
      title: "Segundo caso",
      summary: "Segundo bloqueio.",
      blocker: "Segundo motivo.",
    });
    expect(second).toMatchObject({ ok: false, error: { code: "case_already_open" } });
  });

  it("whitelist: openHumanCaseInputSchema rejeita campo extra", () => {
    const parsed = openHumanCaseInputSchema.safeParse({
      title: "x",
      summary: "y",
      blocker: "z",
      extra_field: "não deveria existir",
    });
    expect(parsed.success).toBe(false);
  });

  it("buildCaseSummary formata título + resumo + bloqueio", () => {
    const summary = buildCaseSummary({ title: "T", summary: "S", blocker: "B" });
    expect(summary).toContain("T");
    expect(summary).toContain("S");
    expect(summary).toContain("B");
  });

  it("isolamento: tenantId de outra org não enxerga nem afeta o caso", async () => {
    const opened = await openCase(pool, ids(ORG_A, CONV_A), {
      title: "Caso isolado",
      summary: "Resumo isolado.",
      blocker: "Bloqueio isolado.",
    });
    if (!opened.ok) throw new Error("setup falhou");
    const caseId = opened.caseId;

    // ORG_B não enxerga o caso aberto de ORG_A na mesma conversa (ids diferentes,
    // mas a checagem cruzada de tenant é o que importa: conversation_id de A sob org B)
    expect(await hasOpenCaseForContact(pool, ORG_B, CONV_A)).toBe(false);

    // tentar resolver o caso de A usando o tenantId de B não deve afetar nada —
    // e o false devolvido impede a rota de responder 200 a um no-op cross-tenant
    const crossTenantResolve = await resolveCaseFromHuman(
      pool,
      ORG_B,
      caseId,
      ACTOR_A,
      "tentativa cross-tenant",
    );
    expect(crossTenantResolve).toBe(false);
    const row = await pool.query(`select status from agent_cases where id = $1`, [caseId]);
    expect(row.rows[0].status).toBe("awaiting_human");

    // idem para provideCaseUpdate com ids de B
    const crossTenant = await provideCaseUpdate(pool, ids(ORG_B, CONV_B), {
      caseId,
      info: "não deveria valer",
    });
    expect(crossTenant).toMatchObject({ ok: false });
    const rowAfter = await pool.query(`select status from agent_cases where id = $1`, [caseId]);
    expect(rowAfter.rows[0].status).toBe("awaiting_human");
  });
});
