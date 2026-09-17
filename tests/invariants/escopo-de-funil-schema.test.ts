import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O ESCOPO DE FUNIL NO BANCO (migration 0125).
 *
 * O que só o Postgres pode responder:
 *
 *  1. a coluna EXISTE no baseline aplicado — prova que a mudança chegou ao
 *     apêndice, e não só ao diretório de migrations (o kit self-host aplica
 *     apenas o baseline);
 *  2. ela nasce VAZIA — falha fechada por default do banco, não por código;
 *  3. o trigger de imutabilidade a COBRE — sem isso, o escopo de permissão
 *     seria editável numa versão publicada sem virar versão nova, que é a
 *     própria ausência de escopo com aparência de controle;
 *  4. e cobre também as nove colunas que ele ignorava antes desta migration.
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

const ORG = "e5c07e00-0000-4000-8000-000000000001";
let agente = "";
let versaoPublicada = "";
let canal = "";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-escopo-funil', 'Escopo LTDA', 'Escopo') on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: a } = await pool.query<{ id: string }>(
    `insert into ai_agents (organization_id, name, kind, system_prompt, model)
     values ($1, 'Agente do escopo', 'mcp_agent', 'oi', 'claude-sonnet-4-6') returning id`,
    [ORG],
  );
  agente = a[0]!.id;

  // `channel_session_id` aceita NULL no rascunho sem canal. Publicar
  // continua exigindo sessão: `fn_publish_ai_agent_version` não encontra a
  // linha e levanta `channel_session_not_found`.
  const { rows: cs } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, display_name, webhook_secret_encrypted)
     values ($1, 'escopo-funil-session', 'Canal do escopo', decode('00','hex')) returning id`,
    [ORG],
  );
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into ai_agent_versions
       (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, published_at)
     values ($1, $2, 1, 'oi', 'anthropic', 'claude-sonnet-4-6', $3, 'published', now()) returning id`,
    [ORG, agente, cs[0]!.id],
  );
  versaoPublicada = v[0]!.id;
  canal = cs[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("a coluna", () => {
  it("existe no baseline aplicado — é o que o self-hoster recebe", async () => {
    const { rows } = await pool.query<{ data_type: string; column_default: string | null }>(
      `select data_type, column_default from information_schema.columns
        where table_name = 'ai_agent_versions' and column_name = 'pipeline_ids'`,
    );
    expect(rows, "a 0125 não chegou ao apêndice do baseline").toHaveLength(1);
    expect(rows[0]!.data_type).toBe("ARRAY");
  });

  it("nasce VAZIA — falha fechada pelo DEFAULT do banco, não por código", async () => {
    // Duas origens de falha fechada, como o repo já faz: o default cobre o
    // agente novo; o `?? []` no runtime cobre o clone sem a migration.
    const { rows } = await pool.query<{ pipeline_ids: string[] }>(
      "select pipeline_ids from ai_agent_versions where id = $1",
      [versaoPublicada],
    );
    expect(rows[0]!.pipeline_ids).toEqual([]);
  });
});

describe("o trigger de imutabilidade", () => {
  it("COBRE o escopo — permissão não muda em versão publicada sem virar versão nova", async () => {
    // É o caso que justifica o conserto ter entrado na MESMA migration:
    // acrescentar `pipeline_ids` sem isto seria pior que não acrescentar.
    await expect(
      pool.query("update ai_agent_versions set pipeline_ids = $2 where id = $1", [
        versaoPublicada,
        ["aaaaaaaa-0000-4000-8000-000000000001"],
      ]),
    ).rejects.toThrow(/imutável|imutavel/i);
  });

  it("cobre também as NOVE colunas que ele ignorava — o conserto de brinde", async () => {
    // O trigger parava no `followup`. Tudo o que entrou depois era editável em
    // produção sem deixar trilha: o modelo do Operador, as ferramentas dele, o
    // corte de mensagens, o multimodal.
    // ⚠️ Cada valor tem de ser DIFERENTE do default da coluna. A primeira versão
    // deste caso usava `multimodal_input = true`, que JÁ é o default: o
    // `is distinct from` dava false, o UPDATE passava, e o teste acusava o
    // trigger de não cobrir uma coluna que ele cobria. Sabotagem que não sabota
    // mede o teste, não o código.
    const casos: Array<[string, unknown]> = [
      ["operator_enabled", true], // default false
      ["operator_model", "claude-opus-4-7"], // default null
      ["operator_tool_ids", ["crm_update_lead"]], // default {}
      ["cases_enabled", true], // default false
      ["split_messages", true], // default false
      ["split_max_chars", 500], // default 600
      ["multimodal_input", false], // default TRUE — invertido de propósito
      ["video_frames_enabled", true], // default false
    ];
    for (const [coluna, valor] of casos) {
      await expect(
        pool.query(`update ai_agent_versions set ${coluna} = $2 where id = $1`, [versaoPublicada, valor]),
        `a coluna ${coluna} continua editável em versão publicada`,
      ).rejects.toThrow(/imutável|imutavel/i);
    }
  });

  it("RASCUNHO continua editável — senão ninguém configura nada", async () => {
    // Controle do outro lado: um trigger que travasse o draft tornaria a tela
    // de configuração inútil, e o teste acima passaria igual.
    const { rows } = await pool.query<{ id: string }>(
      `insert into ai_agent_versions
         (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
       values ($1, $2, 2, 'oi', 'anthropic', 'claude-sonnet-4-6', $3, 'draft') returning id`,
      [ORG, agente, canal],
    );
    await expect(
      pool.query("update ai_agent_versions set pipeline_ids = $2 where id = $1", [
        rows[0]!.id,
        ["aaaaaaaa-0000-4000-8000-000000000001"],
      ]),
    ).resolves.toBeDefined();
  });
});
