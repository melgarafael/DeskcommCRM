import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { haQuemAtendaASessao } from "@/lib/ai/agents/quem-atende-a-sessao";

/**
 * O JEV SÓ É PERGUNTADO ONDE HÁ QUEM ATENDA NÃO PAUSADO (2º conserto da onda 3,
 * G1).
 *
 * Pausar pela tela grava SÓ `ai_agents.paused_at` (`app/app/ai/agents/_actions.ts`,
 * `app/api/v1/ai/agents/[id]/pause/route.ts`): a versão segue `published` e o
 * ponteiro `published_version_id` fica. O portão do dreno não lê a pausa, então
 * ele enfileira o turno — e o turno sai na pausa (`inbound-turn.ts`, `pausedAt`)
 * ANTES de a regra de hoje rodar. O Jev, perguntado ali, contaria "um pedido que
 * a regra deixou passar" onde ela nem foi consultada.
 *
 * O worker pede o portão `ignorarPausados`; o dreno chama como sempre. Aqui a
 * pausa é a da TELA — o `update` que ela faz —, não um estado que a pausa não
 * produz (a versão `superseded` com o ponteiro nulo é o do agente despublicado,
 * que `jev-pergunta-so-onde-o-dreno-atende.test.ts` cobre).
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

const ORG = "cca10426-0000-4000-8000-000000000001";

let seq = 0;
function proximoId(): string {
  seq += 1;
  return `cca10426-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function criarSessao(nome: string): Promise<string> {
  const session = proximoId();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [session, ORG, `jev-pausa-${nome}`],
  );
  return session;
}

/** Um agente publicado no número `sessionId` — e, se `pausado`, pausado como a tela pausa. */
async function criarAgente(sessionId: string, nome: string, pausado: boolean): Promise<string> {
  const agent = proximoId();
  const version = proximoId();
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agent, ORG, `Agente Pausa ${nome}`],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [version, ORG, agent, sessionId],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  if (pausado) {
    // O que a tela grava ao pausar — e só isso.
    await pool.query(`update ai_agents set paused_at = now(), updated_at = now() where id = $1 and organization_id = $2`, [
      agent,
      ORG,
    ]);
  }
  return agent;
}

async function criarRouter(sessionId: string, opts: { fallback?: string; membros?: string[] }): Promise<void> {
  const router = proximoId();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, fallback_agent_id)
     values ($1, $2, 'Roteador Pausa', $3, true, $4)`,
    [router, ORG, sessionId, opts.fallback ?? null],
  );
  for (const [i, membro] of (opts.membros ?? []).entries()) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, $4, 'dúvidas')`,
      [ORG, router, membro, `intencao-${i}`],
    );
  }
}

/** O que o worker do Jev pergunta, e o que o dreno pergunta, sobre o número. */
async function responder(sessionId: string): Promise<{ doJev: boolean | null; doDreno: boolean | null }> {
  return {
    doJev: await haQuemAtendaASessao(pool, ORG, sessionId, { ignorarPausados: true }),
    doDreno: await haQuemAtendaASessao(pool, ORG, sessionId),
  };
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'jev-quem-nao-esta-pausado', 'Jev Pausa', 'Jev Pausa')
     on conflict (id) do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("há quem atenda NÃO PAUSADO? — o portão que o worker do Jev pede", () => {
  it("o agente do número pausado pela tela: a versão segue publicada, e o Jev não é perguntado", async () => {
    const s = await criarSessao("agente");
    const agente = await criarAgente(s, "agente", true);
    const { rows } = await pool.query<{ publicado: boolean; pausado: boolean }>(
      `select v.status = 'published' as publicado, a.paused_at is not null as pausado
         from ai_agents a join ai_agent_versions v on v.id = a.published_version_id where a.id = $1`,
      [agente],
    );
    expect(rows[0], "a pausa da tela mantém a publicação (a premissa deste arquivo)").toEqual({ publicado: true, pausado: true });
    // O dreno, sem a opção, segue abrindo (o comportamento de hoje, que este PR não muda).
    expect(await responder(s)).toEqual({ doJev: false, doDreno: true });
  });

  it("controle: o mesmo agente, sem pausa — o Jev é perguntado", async () => {
    const s = await criarSessao("controle");
    await criarAgente(s, "controle", false);
    expect(await responder(s)).toEqual({ doJev: true, doDreno: true });
  });

  it("o único membro do roteador do número, pausado pela tela: o Jev não é perguntado", async () => {
    const longe = await criarSessao("membro-longe");
    const membro = await criarAgente(longe, "membro", true);
    const s = await criarSessao("membro");
    await criarRouter(s, { membros: [membro] });
    expect(await responder(s)).toEqual({ doJev: false, doDreno: true });
  });

  it("o fallback do roteador do número, pausado pela tela e sem membros: o Jev não é perguntado", async () => {
    const longe = await criarSessao("fallback-longe");
    const fallback = await criarAgente(longe, "fallback", true);
    const s = await criarSessao("fallback");
    await criarRouter(s, { fallback });
    expect(await responder(s)).toEqual({ doJev: false, doDreno: true });
  });

  it("um membro pausado e outro no ar: há quem atenda — o Jev é perguntado", async () => {
    const longe = await criarSessao("misto-longe");
    const pausado = await criarAgente(longe, "misto-pausado", true);
    const noAr = await criarAgente(longe, "misto-no-ar", false);
    const s = await criarSessao("misto");
    await criarRouter(s, { membros: [pausado, noAr] });
    expect(await responder(s)).toEqual({ doJev: true, doDreno: true });
  });
});
