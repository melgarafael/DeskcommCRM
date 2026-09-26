import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { haQuemAtendaAOrganizacao, haQuemAtendaASessao } from "@/lib/ai/agents/quem-atende-a-sessao";

/**
 * "NÃO RODA" NAS TAREFAS DE PEDIDO DO JEV (conserto 3 da onda 3, H4).
 *
 * O worker de clima só pergunta os pedidos do cliente onde há quem atenda o
 * número da conversa sem pausa (`haQuemAtendaASessao(..., { ignorarPausados:
 * true })`). O cartão do Jev pergunta o mesmo em nível de organização
 * (`haQuemAtendaAOrganizacao`): em nenhum número → as duas tarefas dizem "Não
 * roda", em vez de "Só observa" com "nenhuma mensagem" para sempre.
 *
 * Aqui, contra o Postgres do baseline: a resposta da organização é EXATAMENTE
 * "algum número dela responde sim ao portão do worker" — nos estados que a tela
 * produz (a pausa grava só `paused_at`), no roteador, no arquivado, e sem
 * enxergar outra organização.
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

let seq = 0;
function proximoId(): string {
  seq += 1;
  return `cca30426-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function criarOrganizacao(nome: string): Promise<string> {
  const org = proximoId();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)`,
    [org, `jev-nao-roda-${nome}`, `Jev Não Roda ${nome}`],
  );
  return org;
}

async function criarSessao(org: string, nome: string): Promise<string> {
  const session = proximoId();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [session, org, `jev-nao-roda-${nome}`],
  );
  return session;
}

/** Um agente com a versão publicada em `sessionId`, pausado como a tela pausa, ou arquivado. */
async function criarAgente(
  org: string,
  sessionId: string,
  estado: { pausado?: boolean; arquivado?: boolean } = {},
): Promise<string> {
  const agent = proximoId();
  const version = proximoId();
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agent, org, `Agente ${agent.slice(-4)}`],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [version, org, agent, sessionId],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  if (estado.pausado) {
    // O que a tela grava ao pausar — e só isso.
    await pool.query(`update ai_agents set paused_at = now(), updated_at = now() where id = $1 and organization_id = $2`, [agent, org]);
  }
  if (estado.arquivado) {
    await pool.query(`update ai_agents set archived_at = now() where id = $1 and organization_id = $2`, [agent, org]);
  }
  return agent;
}

async function criarRoteador(org: string, sessionId: string, membros: string[]): Promise<void> {
  const router = proximoId();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active)
     values ($1, $2, 'Roteador Não Roda', $3, true)`,
    [router, org, sessionId],
  );
  for (const [i, membro] of membros.entries()) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, $4, 'dúvidas')`,
      [org, router, membro, `intencao-${i}`],
    );
  }
}

/** A resposta do cartão, e a do worker em cada número da organização. */
async function responder(org: string): Promise<{ doCartao: boolean | null; algumNumeroDoWorker: boolean }> {
  const { rows } = await pool.query<{ id: string }>(`select id from channel_sessions where organization_id = $1`, [org]);
  const porNumero = await Promise.all(rows.map((r) => haQuemAtendaASessao(pool, org, r.id, { ignorarPausados: true })));
  return { doCartao: await haQuemAtendaAOrganizacao(pool, org), algumNumeroDoWorker: porNumero.some((r) => r === true) };
}

afterAll(async () => {
  await pool.end();
});

describe("há quem atenda, sem pausa, em algum número da organização? — o 'Não roda' das tarefas de pedido", () => {
  it("nenhum agente: não roda", async () => {
    const org = await criarOrganizacao("vazia");
    await criarSessao(org, "vazia");
    expect(await responder(org)).toEqual({ doCartao: false, algumNumeroDoWorker: false });
  });

  it("o único agente, pausado pela tela (a versão segue publicada): não roda", async () => {
    const org = await criarOrganizacao("pausada");
    const s = await criarSessao(org, "pausada");
    await criarAgente(org, s, { pausado: true });
    expect(await responder(org)).toEqual({ doCartao: false, algumNumeroDoWorker: false });
  });

  it("o único agente, arquivado: não roda", async () => {
    const org = await criarOrganizacao("arquivada");
    const s = await criarSessao(org, "arquivada");
    await criarAgente(org, s, { arquivado: true });
    expect(await responder(org)).toEqual({ doCartao: false, algumNumeroDoWorker: false });
  });

  it("um agente no ar num dos números: roda", async () => {
    const org = await criarOrganizacao("no-ar");
    await criarSessao(org, "no-ar-sem-ninguem");
    const s = await criarSessao(org, "no-ar");
    await criarAgente(org, s);
    expect(await responder(org)).toEqual({ doCartao: true, algumNumeroDoWorker: true });
  });

  it("o roteador ativo num número, com o único membro pausado: não roda — e o dreno, sem a opção, abriria (controle)", async () => {
    const org = await criarOrganizacao("roteador");
    const longe = await criarSessao(org, "roteador-longe");
    const pausado = await criarAgente(org, longe, { pausado: true });
    const s = await criarSessao(org, "roteador");
    await criarRoteador(org, s, [pausado]);
    expect(await haQuemAtendaASessao(pool, org, s), "o portão do dreno não lê a pausa").toBe(true);
    expect(await responder(org)).toEqual({ doCartao: false, algumNumeroDoWorker: false });
  });

  it("o agente no ar de OUTRA organização não conta", async () => {
    const outra = await criarOrganizacao("outra");
    await criarAgente(outra, await criarSessao(outra, "outra"));
    const org = await criarOrganizacao("so-a-outra-tem");
    await criarSessao(org, "so-a-outra-tem");
    expect(await responder(outra), "controle: a outra roda").toEqual({ doCartao: true, algumNumeroDoWorker: true });
    expect(await responder(org)).toEqual({ doCartao: false, algumNumeroDoWorker: false });
  });
});
