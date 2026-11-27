/**
 * A FAIXA DE SALDO DA IA lê o banco do jeito que o self-hoster o tem.
 *
 * `avisosDeSaldoDaIa` (lib/ai/saude-do-saldo.ts) é o coração da faixa do topo
 * do app: uma consulta só sobre `llm_calls`, `job_queue`, credenciais, agentes e
 * vínculos dos últimos 7 dias. O teste do componente usa um fetch falso e a
 * rota só repassa o resultado, então nenhum teste exercitava a consulta contra
 * o schema real. Aqui ela roda no `baseline.sql` (install + update).
 *
 * O caso da OpenAI é o que a triagem do #5312 pegou: a faixa tinha uma lista
 * própria de frases e não reconhecia "You exceeded your current quota"
 * (`insufficient_quota`), que a fila de espera por saldo
 * (lib/agent-engine/queue/espera-de-saldo.ts) já tratava como falta de saldo.
 * Hoje as duas leem `FRASES_DE_SEM_SALDO`; tirar a frase de lá reprova este caso.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { avisosDeSaldoDaIa } from "@/lib/ai/saude-do-saldo";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "5a1d0000-0000-4000-8000-000000005312";
const OUTRA_ORG = "5a1d0000-0000-4000-8000-000000005313";
const CONTATO = "5a1d0000-0000-4000-8000-000000005314";
const JOB = "5a1d0000-0000-4000-8000-000000005315";

async function erro(
  org: string,
  provider: string,
  purpose: string,
  mensagem: string,
  extra: { job?: string; origem?: string; http?: number } = {},
) {
  await pool.query(
    `insert into llm_calls (organization_id, job_id, purpose, provider, model, status, error_code,
                            error_message, http_status, origem_da_escolha, created_at)
     values ($1, $2, $3, $4, 'm', 'erro', 'limite_ou_saldo', $5, $6, $7, now() - interval '10 minutes')`,
    [org, extra.job ?? null, purpose, provider, mensagem, extra.http ?? 400, extra.origem ?? null],
  );
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "aviso-saldo-a"],
    [OUTRA_ORG, "aviso-saldo-b"],
  ]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4)
       on conflict (id) do nothing`,
      [id, slug, slug, slug],
    );
  }
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'c', '+5511900005312')`,
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into job_queue (id, organization_id, contact_id, kind) values ($1, $2, $3, 'inbound_turn')`,
    [JOB, ORG, CONTATO],
  );
  await erro(ORG, "anthropic", "agent_turn", "Your credit balance is too low to access the Anthropic API.", {
    job: JOB,
    origem: "padrao_da_organizacao",
  });
  await erro(
    ORG,
    "openai",
    "transcricao_de_audio",
    '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
    { http: 429 },
  );
  await erro(ORG, "google", "transcricao_de_audio", "Rate limit reached for requests", { http: 429 });
});

afterAll(async () => {
  await pool.end();
});

describe("avisosDeSaldoDaIa no baseline", () => {
  it("falta de saldo num turno de atendimento acende o aviso vermelho", async () => {
    expect(await avisosDeSaldoDaIa(pool, ORG)).toContainEqual({ provider: "anthropic", atendimento: true });
  });

  it("a falta de saldo da OpenAI que a fila já reconhece acende a faixa, como etapa auxiliar", async () => {
    expect(await avisosDeSaldoDaIa(pool, ORG)).toContainEqual({ provider: "openai", atendimento: false });
  });

  it("um 429 de limite de ritmo não é falta de saldo", async () => {
    const avisos = await avisosDeSaldoDaIa(pool, ORG);
    expect(avisos.map((a) => a.provider)).not.toContain("google");
  });

  it("outra organização não vê os avisos desta", async () => {
    expect(await avisosDeSaldoDaIa(pool, OUTRA_ORG)).toEqual([]);
  });

  it("um sucesso depois do erro, no mesmo ponto, apaga o aviso", async () => {
    await pool.query(
      `insert into llm_calls (organization_id, job_id, purpose, provider, model, status, origem_da_escolha, created_at)
       values ($1, $2, 'agent_turn', 'anthropic', 'm', 'ok', 'padrao_da_organizacao', now() - interval '1 minute')`,
      [ORG, JOB],
    );
    const avisos = await avisosDeSaldoDaIa(pool, ORG);
    expect(avisos.map((a) => a.provider)).not.toContain("anthropic");
  });
});
