import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * O PORTÃO DE CUSTO TEM QUE MEDIR QUEM EXECUTA, NÃO QUEM EXISTE.
 *
 * `drain.ts` decide, antes de enfileirar o turno, se há alguém capaz de
 * atender aquela sessão — e pula o evento quando não há, para que "pausei o
 * agente" signifique "parou de gastar". A pergunta tem dois braços:
 * `tem_agente` (versão publicada para a sessão) e `tem_roteador`.
 *
 * O braço do roteador media EXISTÊNCIA DE LINHA: `fallback_agent_id is not
 * null` ou `exists (select 1 from ai_router_members ...)`. Nenhuma das duas
 * sobrevive à pergunta certa, porque pausar um agente **não apaga a linha de
 * membro nem zera o `fallback_agent_id`** — só limpa `published_version_id`.
 *
 * Resultado, com todos os agentes de um roteador pausados: o portão abria, a
 * organização pagava o classificador de intenção e o turno inteiro por
 * mensagem recebida, e ninguém publicado atendia — a resposta saía pelo
 * caminho genérico. É o mesmo desperdício que o braço `tem_agente` já barrava,
 * entrando pela outra porta.
 *
 * Este arquivo congela o portão nas DUAS direções. Só a metade que fecha
 * seria satisfeita por um portão que nunca abre — e um portão que nunca abre
 * é a IA muda, que é pior que o gasto.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

const ORG = "cca00000-0000-4000-8000-000000000001";
const CONTACT = "cca00000-0000-4000-8000-000000000002";

const DRAIN_KNOBS = {
  batchSize: 20,
  intervalMs: 100,
  idleIntervalMs: 100,
  debounceMs: 0,
  reapTimeoutMs: 300_000,
};

/** Um cenário completo e isolado: uma sessão de canal só dele. */
interface Cenario {
  session: string;
  conv: string;
  msg: string;
}

let seq = 0;
function proximoId(): string {
  seq += 1;
  return `cca00000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function montarCenario(nome: string): Promise<Cenario> {
  const session = proximoId();
  const conv = proximoId();
  const msg = proximoId();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [session, ORG, `cap-${nome}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [conv, ORG, CONTACT, session],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi', 'external_device', now())`,
    [msg, ORG, conv, session, CONTACT],
  );
  return { session, conv, msg };
}

/**
 * Cria um agente. `publicado: false` reproduz EXATAMENTE o que a pausa deixa
 * no banco — a versão existe e virou `superseded`, e `published_version_id`
 * ficou nulo. Criar o agente sem versão nenhuma seria um estado mais fácil, e
 * o portão poderia passar por um motivo que a pausa real não produz.
 */
async function criarAgente(
  sessionId: string,
  opts: { publicado: boolean; nome: string },
): Promise<string> {
  const agent = proximoId();
  const version = proximoId();
  // O nome vem de fora porque `ai_agents_name_unique` é por organização, e
  // todos os cenários deste arquivo dividem a mesma org: um literal fixo aqui
  // faz o segundo insert morrer em 23505 e o caso nunca chega a exercitar o
  // portão — ele fica vermelho por erro de fixture, que lê como defeito.
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agent, ORG, `Agente Portão ${opts.nome}`],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, $5, now())`,
    [version, ORG, agent, sessionId, opts.publicado ? "published" : "superseded"],
  );
  if (opts.publicado) {
    await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  }
  return agent;
}

async function criarRouter(
  sessionId: string,
  opts: { fallback?: string | null; membro?: string | null },
): Promise<string> {
  const router = proximoId();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, fallback_agent_id)
     values ($1, $2, 'Roteador Portão', $3, true, $4)`,
    [router, ORG, sessionId, opts.fallback ?? null],
  );
  if (opts.membro) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, 'suporte', 'dúvidas de suporte')`,
      [ORG, router, opts.membro],
    );
  }
  return router;
}

/** Drena o evento do cenário e responde: nasceu job? */
async function drenaEGeraJob(c: Cenario, debounceMs = 0): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
             jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                'contact_id', $4::text, 'channel_session_id', $5::text,
                                'inbound_message_id', $2::text),
             'pending')
     returning id`,
    [ORG, c.msg, c.conv, CONTACT, c.session],
  );
  const eventId = rows[0]!.id;

  await drainTick(pool, { ...DRAIN_KNOBS, debounceMs }, log);

  const { rows: jobs } = await pool.query<{ n: number }>(
    "select count(*)::int as n from job_queue where source_event_id = $1",
    [eventId],
  );
  return jobs[0]!.n > 0;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'portao-capacidade', 'Portao Capacidade', 'Portao Capacidade')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead Portão', '+5511900000099') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("portão de capacidade do drain — mede quem EXECUTA", () => {
  it.each([
    { nome: "rajada inicial", attempts: 0, mesmaConversa: true, criaJob: false },
    { nome: "retry após fechamento falho", attempts: 1, mesmaConversa: true, criaJob: true },
    { nome: "outro canal do mesmo contato", attempts: 0, mesmaConversa: false, criaJob: true },
  ])("coalescência: $nome", async ({ nome, attempts, mesmaConversa, criaJob }) => {
    await pool.query('delete from job_queue where organization_id = $1', [ORG]);
    const c = await montarCenario(nome);
    await criarAgente(c.session, { publicado: true, nome });
    const anterior = mesmaConversa ? c : await montarCenario(`${nome}-anterior`);
    await pool.query(
      `insert into job_queue (organization_id, contact_id, kind, status, attempts, run_after, payload)
       values ($1, $2, 'inbound_turn', 'pending', $3, now() + interval '1 minute',
               jsonb_build_object('conversation_id', $4::text))`,
      [ORG, CONTACT, attempts, anterior.conv],
    );
    expect(await drenaEGeraJob(c, 8000)).toBe(criaJob);
    const { rows } = await pool.query(
      'select count(*)::int as n from job_queue where organization_id = $1', [ORG],
    );
    expect(rows[0].n).toBe(criaJob ? 2 : 1);
  });

  it("agente publicado para a sessão: o turno é enfileirado", async () => {
    const c = await montarCenario("publicado");
    await criarAgente(c.session, { publicado: true, nome: "publicado" });

    expect(await drenaEGeraJob(c)).toBe(true);
  });

  it("agente PAUSADO e sem roteador: nada é enfileirado — pausar tem que parar o gasto", async () => {
    const c = await montarCenario("pausado");
    await criarAgente(c.session, { publicado: false, nome: "pausado" });

    expect(await drenaEGeraJob(c)).toBe(false);
  });

  it("roteador ativo cujo MEMBRO está pausado: nada é enfileirado", async () => {
    // O defeito: a linha em ai_router_members sobrevive à pausa do agente, e o
    // portão a contava como "existe quem atenda".
    const c = await montarCenario("membro-pausado");
    const membro = await criarAgente(c.session, { publicado: false, nome: "membro-pausado" });
    await criarRouter(c.session, { membro });

    expect(await drenaEGeraJob(c)).toBe(false);
  });

  it("roteador ativo com MEMBRO publicado: o turno é enfileirado", async () => {
    const c = await montarCenario("membro-publicado");
    const membro = await criarAgente(c.session, { publicado: true, nome: "membro-publicado" });
    // O membro é publicado, mas a versão dele aponta para ESTA sessão, o que
    // também faria `tem_agente` passar. Um router cujo membro é publicado é o
    // caso que tem de abrir o portão de qualquer um dos dois braços.
    await criarRouter(c.session, { membro });

    expect(await drenaEGeraJob(c)).toBe(true);
  });

  it("roteador ativo cujo FALLBACK está pausado: nada é enfileirado", async () => {
    const c = await montarCenario("fallback-pausado");
    const fallback = await criarAgente(c.session, { publicado: false, nome: "fallback-pausado" });
    await criarRouter(c.session, { fallback });

    expect(await drenaEGeraJob(c)).toBe(false);
  });

  it("roteador ativo com FALLBACK publicado: o turno é enfileirado", async () => {
    const c = await montarCenario("fallback-publicado");
    const fallback = await criarAgente(c.session, { publicado: true, nome: "fallback-publicado" });
    await criarRouter(c.session, { fallback });

    expect(await drenaEGeraJob(c)).toBe(true);
  });

  it("agente ARQUIVADO com versão publicada: nada é enfileirado", async () => {
    // Arquivar não supersede a versão (medido em `_actions.ts`), então o
    // `v.status='published'` sozinho não basta — o `archived_at is null` do
    // portão é que segura.
    const c = await montarCenario("arquivado");
    const agente = await criarAgente(c.session, { publicado: true, nome: "arquivado" });
    await pool.query(`update ai_agents set archived_at = now() where id = $1`, [agente]);

    expect(await drenaEGeraJob(c)).toBe(false);
  });
});
