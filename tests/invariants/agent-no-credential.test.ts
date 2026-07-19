import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Fase 4B (robustez BYOK) — turno SEM credencial nenhuma (nem env, nem BYOK).
 *
 * Roda o HANDLER REAL do turno (createInboundTurnHandler) contra o PG efêmero,
 * pelo MESMO contrato de execução do worker (runJob de main.ts: handler → catch
 * → failJob). Congela:
 *   1. o turno falha com erro CLARO e instrutivo (LlmNotConfiguredError);
 *   2. a falha é ISOLADA: job → dead (max_attempts=1) SEM propagar — o loop
 *      sobrevive e a fila segue operável;
 *   3. trilha humana: agent_inbox_items kind='job_dead' severity='critical';
 *   4. NENHUMA mensagem é enviada (nem vazia) — zero linhas outbound.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

// Placeholders ANTES dos imports dinâmicos do engine (módulos da borda leem env
// de app no uso; nada disso é chamado antes do erro de credencial).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "dddddddd-0000-4000-8000-000000000001";
const CONTACT = "dddddddd-0000-4000-8000-000000000002";
const SESSION = "dddddddd-0000-4000-8000-000000000003";
const CONV = "dddddddd-0000-4000-8000-000000000004";
const MSG = "dddddddd-0000-4000-8000-000000000005";

type EngineModules = {
  createInboundTurnHandler: typeof import("@/lib/agent-engine/agent/inbound-turn")["createInboundTurnHandler"];
  queue: typeof import("@/lib/agent-engine/queue/queue");
  createLogger: typeof import("@/lib/agent-engine/obs/logger")["createLogger"];
  crmEdgeConfigFromEnv: typeof import("@/lib/agent-engine/edge/crm/mcp-client")["crmEdgeConfigFromEnv"];
};
let m: EngineModules;

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    crmEdgeConfigFromEnv: (await import("@/lib/agent-engine/edge/crm/mcp-client"))
      .crmEdgeConfigFromEnv,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'nocred-proof', 'NoCred Proof', 'NoCred Proof') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead Sem Credencial', '+5511900000042') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'nocred-session', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi, quero comprar', 'external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  // playbook platform obrigatório (o ritual de abertura o exige)
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("4B — turno sem credencial NENHUMA (nem env, nem BYOK)", () => {
  it("falha EXPLÍCITA e ISOLADA: dead + inbox critical + fila viva + zero envio", async () => {
    const log = m.createLogger();
    const handler = m.createInboundTurnHandler({
      crmCfg: m.crmEdgeConfigFromEnv({
        SUPABASE_URL: "https://placeholder.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "placeholder-service",
      }),
      llmCfg: {}, // SEM anthropicApiKey — e o banco não tem BYOK para a org
      knobs: {
        historyLimit: 10,
        maxContextTokens: 1000,
        notesIndexMaxTokens: 500,
        maxSteps: 4,
        queuedRetryDelayMs: 1000,
        breaker: {
          exactFailureWarn: 2,
          exactFailureBlock: 5,
          sameToolFailureWarn: 3,
          sameToolFailureHalt: 8,
          noProgressWarn: 3,
          noProgressBlock: 5,
        },
      },
      log,
    });

    // O PG efêmero é compartilhado com as outras suítes: neutraliza jobs
    // pendentes alheios para o claim (FIFO global) pegar o DESTE teste.
    await pool.query("update job_queue set status = 'done' where status = 'pending'");

    const { job } = await m.queue.enqueueJob(pool, ORG, {
      kind: "inbound_turn",
      leadId: CONTACT,
      payload: {
        conversation_id: CONV,
        contact_id: CONTACT,
        channel_session_id: SESSION,
        inbound_message_id: MSG,
        crm_event_id: "dddddddd-0000-4000-8000-000000000006",
      },
      maxAttempts: 1,
    });

    const workerId = "test-worker-nocred";
    const [claimed] = await m.queue.claimJobs(pool, { workerId, maxConcurrency: 1 });
    expect(claimed?.id).toBe(job.id);

    // O CONTRATO DO WORKER (main.ts runJob): handler lança → catch → failJob.
    // A exceção NÃO pode escapar deste bloco — isso É o isolamento.
    let turnError: Error | null = null;
    try {
      await handler(claimed!, pool, { workerId });
    } catch (err) {
      turnError = err as Error;
      await m.queue.failJob(pool, claimed!.id, workerId, err);
    }

    // 1. erro CLARO e instrutivo (nunca stack críptico)
    expect(turnError).not.toBeNull();
    expect(turnError!.message).toMatch(/credencial LLM/);
    expect(turnError!.message).toMatch(/ai_provider_credentials|ANTHROPIC_API_KEY/);

    // 2. job dead (max_attempts=1), com o erro gravado
    const { rows: jobs } = await pool.query(
      "select status, left(last_error, 200) as last_error from job_queue where id = $1",
      [job.id],
    );
    expect(jobs[0]!.status).toBe("dead");
    expect(jobs[0]!.last_error).toMatch(/credencial LLM/);

    // 3. trilha humana: inbox item crítico
    const { rows: inbox } = await pool.query(
      `select kind, severity from agent_inbox_items
       where organization_id = $1 order by created_at desc limit 1`,
      [ORG],
    );
    expect(inbox[0]).toMatchObject({ kind: "job_dead", severity: "critical" });

    // 4. NENHUMA mensagem enviada (nem vazia)
    const { rows: outbound } = await pool.query(
      "select count(*)::int as n from messages where conversation_id = $1 and direction = 'outbound'",
      [CONV],
    );
    expect(outbound[0]!.n).toBe(0);

    // 5. a fila SOBREVIVE: claim seguinte funciona sem erro (worker operável)
    const nextClaims = await m.queue.claimJobs(pool, { workerId, maxConcurrency: 1 });
    expect(Array.isArray(nextClaims)).toBe(true);
  });
});
