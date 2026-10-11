import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";

/**
 * Um agente PAUSADO não pode sequestrar o número de quem está no ar.
 *
 * Medido em produção (2026-10-05): sete agentes publicados no mesmo número, a
 * "Vitória" pausada com prioridade 1000 e a "Lia" no ar com prioridade 1. A
 * escolha por número pegava o primeiro por prioridade SEM olhar a pausa, o
 * turno saía no `pausedAt` e o cliente ficava sem resposta — com um agente
 * ativo publicado no mesmo número.
 *
 * O caso "todos pausados" é a outra metade e é a que já passava: ali o pausado
 * TEM de continuar vindo, porque `null` significa "responde o genérico" — e
 * pausar o único agente do número o faria voltar a responder.
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

const ORG = "eeeeeeee-7a05-4000-8000-000000000001";
const SESSAO_MISTA = "eeeeeeee-7a05-4000-8000-000000000002";
const SESSAO_TODOS_PAUSADOS = "eeeeeeee-7a05-4000-8000-000000000003";

const PAUSADO_PRIORITARIO = "eeeeeeee-7a05-4000-8000-000000000011";
const NO_AR = "eeeeeeee-7a05-4000-8000-000000000012";
const SO_PAUSADO = "eeeeeeee-7a05-4000-8000-000000000013";

async function agentePublicado(
  agentId: string,
  sessao: string,
  nome: string,
  prioridade: number,
  pausado: boolean,
): Promise<void> {
  const versao = agentId.replace(/1(\d)$/, "2$1");
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, priority, paused_at)
     values ($1, $2, $3, 'system', $4, case when $5 then now() end) on conflict (id) do nothing`,
    [agentId, ORG, nome, prioridade, pausado],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published')
     on conflict (id) do nothing`,
    [versao, ORG, agentId, sessao],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [versao, agentId]);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'pausado-nao-sequestra', 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
    [ORG],
  );
  for (const [id, nome] of [
    [SESSAO_MISTA, "pausado-sequestra-mista"],
    [SESSAO_TODOS_PAUSADOS, "pausado-sequestra-todos"],
  ]) {
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, $2, $3, 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
      [id, ORG, nome],
    );
  }
  await agentePublicado(PAUSADO_PRIORITARIO, SESSAO_MISTA, "Pausado prioritário", 1000, true);
  await agentePublicado(NO_AR, SESSAO_MISTA, "No ar", 1, false);
  await agentePublicado(SO_PAUSADO, SESSAO_TODOS_PAUSADOS, "Único, pausado", 1000, true);
});

afterAll(async () => {
  await pool.end();
});

describe("escolha do agente por número com agente pausado", () => {
  it("o agente no ar responde, mesmo com um pausado de prioridade maior no mesmo número", async () => {
    const config = await loadPublishedAgentConfig(pool, ORG, SESSAO_MISTA);
    expect(config?.agentId).toBe(NO_AR);
    expect(config?.pausedAt ?? null).toBeNull();
  });

  it("todos pausados: o pausado continua vindo, para o turno silenciar e não cair no genérico", async () => {
    const config = await loadPublishedAgentConfig(pool, ORG, SESSAO_TODOS_PAUSADOS);
    expect(config?.agentId).toBe(SO_PAUSADO);
    expect(config?.pausedAt).not.toBeNull();
  });
});
