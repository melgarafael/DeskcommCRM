/**
 * O ROTEADOR NASCE EM "AUTOMÁTICO" — E A CURA NÃO APAGA ESCOLHA DE QUEM ESCOLHEU.
 *
 * O defeito medido (2026-10-02, `llm_calls` de uma instalação real): o
 * `ai_routers.config` semeava `'classifier_model', 'claude-haiku-4-5'`. Numa
 * organização configurada na **OpenRouter**, esse id entrava pelo precedência 3
 * de `decidirBinding` (modelo do call site vence o padrão da organização) e ia
 * para o endpoint da OpenRouter:
 *
 *   provider openrouter · model claude-haiku-4-5 · http_status 400
 *   error_message "claude-haiku-4-5 is not a valid model ID"
 *
 * A organização nunca escolheu Claude — o default do banco escolheu por ela. E o
 * id não existe na OpenRouter (lá é `anthropic/claude-haiku-4.5`, com ponto).
 * Três chamadas 400, o classificador calado, e todo turno caindo no fallback.
 *
 * O unitário (`tests/unit/router-config-classificador-automatico.test.ts`) mede o
 * TEXTO do schema. O que este mede é o que o self-host faz: o default no banco
 * depois de aplicar o `baseline.sql`, e a cura das linhas já semeadas.
 *
 * ⚠️ Por que isto NÃO pode ser só "o default não tem a chave": a cura por
 * `update` tem dois erros possíveis e silenciosos. `set config =
 * jsonb_build_object(...)` em vez de `config - 'classifier_model'` reescreve a
 * linha e apaga o `sticky`/`min_confidence` que a pessoa ajustou. E uma cura
 * larga demais apaga o que funcionava: o seed numa organização Anthropic (lá o
 * alias `claude-haiku-4-5` resolve, 0104) ou a escolha deliberada
 * `anthropic/claude-haiku-4-5` pela Requesty (catálogo da 0410).
 *
 * A cura testada é a do PRÓPRIO apêndice do `baseline.sql`, lida do arquivo e
 * executada — não uma cópia dela. Uma cópia continuaria verde se a guarda do
 * arquivo mudasse. O unitário garante que a migration tem o mesmo texto.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

/** O único id que a 0085 semeou em `ai_routers` — e que a OpenRouter rejeita. */
const ID_SEMEADO = "claude-haiku-4-5";
/**
 * NÃO é seed: é um modelo válido do catálogo da Requesty (0410), que a tela
 * oferece e grava com `classifier_provider = 'requesty'`. A cura não pode tocá-lo.
 */
const HAIKU_DA_REQUESTY = "anthropic/claude-haiku-4-5";

/**
 * Organização com EXATAMENTE este `settings`; `{}` = provedor efetivo Anthropic
 * (`llmSettingsSchema`).
 *
 * O `settings` vai num UPDATE depois do INSERT, e não no INSERT: o gatilho
 * `trg_seed_org_llm_defaults` (before insert) grava `llm.provider = 'anthropic'`
 * em toda organização nova sem `default_model` — medido: com o settings no
 * INSERT, a organização "na OpenRouter" nascia Anthropic e o caso da cura ficava
 * vermelho pelo motivo errado. Organização antiga (anterior ao gatilho) ou
 * editada pela API pode não ter o campo, e é esse estado que o teste precisa.
 */
async function criarOrganizacao(settings: Record<string, unknown> = {}): Promise<string> {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Roteador Automatico', 'Roteador Automatico')`,
    [org, `rot-auto-${org}`],
  );
  await pool.query(`update organizations set settings = $2::jsonb where id = $1`, [
    org,
    JSON.stringify(settings),
  ]);
  return org;
}

const NA_OPENROUTER = { llm: { provider: "openrouter" } };

/**
 * O UPDATE da cura como o self-host o aplica: o texto do bloco da 0530 no
 * apêndice do `baseline.sql`, sem cópia. O escopo por id só existe para o teste
 * não alcançar linhas de outros arquivos da suíte — a guarda é a do arquivo.
 */
const CURA_DO_APENDICE = (() => {
  const sql = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const rotulo = sql.indexOf('-- ---- classificador do roteador nasce "Automático" (migration 0530) ----');
  if (rotulo < 0) throw new Error("bloco da 0530 ausente do apêndice do baseline.sql");
  const fimDoBloco = sql.indexOf("\n-- ---- ", rotulo + 10);
  const bloco = sql.slice(rotulo, fimDoBloco < 0 ? undefined : fimDoBloco);
  const update = bloco.match(/update public\.ai_routers r[\s\S]*?;/);
  if (!update) throw new Error("UPDATE da cura ausente do bloco da 0530 no baseline.sql");
  return update[0].replace(/;$/, "");
})();

async function curar(...roteadores: string[]): Promise<void> {
  await pool.query(`${CURA_DO_APENDICE}\n  and r.id = any($1::uuid[])`, [roteadores]);
}

async function criarRoteador(org: string, config: Record<string, unknown>): Promise<string> {
  const sessao = await criarSessao(org);
  const roteador = randomUUID();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, config)
     values ($1, $2, 'Roteador', $3, $4::jsonb)`,
    [roteador, org, sessao, JSON.stringify(config)],
  );
  return roteador;
}

async function configDe(roteador: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ config: Record<string, unknown> }>(
    `select config from ai_routers where id = $1`,
    [roteador],
  );
  return rows[0]!.config;
}

/** Uma sessão de canal, que é o que o roteador precisa para existir. */
async function criarSessao(org: string): Promise<string> {
  const sessao = randomUUID();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [sessao, org, `rot-auto-${sessao}`],
  );
  return sessao;
}

beforeAll(async () => {
  await pool.query("select 1");
});

afterAll(async () => {
  await pool.end();
});

describe("ai_routers — o classificador nasce em 'Automático'", () => {
  it("um roteador criado sem config não ganha classifier_model do banco", async () => {
    const org = await criarOrganizacao();
    const sessao = await criarSessao(org);
    const roteador = randomUUID();

    // Sem `config` no INSERT: o default da coluna é quem decide. É assim que a
    // tela e a API criam roteador (`app/api/v1/ai/routers/route.ts`).
    await pool.query(
      `insert into ai_routers (id, organization_id, name, channel_session_id)
       values ($1, $2, 'Roteador Hubiss', $3)`,
      [roteador, org, sessao],
    );

    const { rows } = await pool.query<{ config: Record<string, unknown> }>(
      `select config from ai_routers where id = $1`,
      [roteador],
    );

    expect(rows[0]!.config).not.toHaveProperty("classifier_model");
    // O resto do default sobrevive: o leitor usa `sticky`/`min_confidence` daqui.
    expect(rows[0]!.config).toMatchObject({ sticky: true, min_confidence: 0.6 });
  });

  it("o default da coluna é o da 0530, não o id do Anthropic", async () => {
    // Pergunta ao CATÁLOGO, e não ao texto: é o que o banco realmente tem.
    const { rows } = await pool.query<{ dflt: string | null }>(
      `select pg_get_expr(adbin, adrelid) as dflt
       from pg_attrdef
       where adrelid = 'public.ai_routers'::regclass
         and adnum = (select attnum from pg_attribute
                      where attrelid = 'public.ai_routers'::regclass and attname = 'config')`,
    );
    expect(rows[0]!.dflt).not.toBeNull();
    expect(rows[0]!.dflt).not.toContain("classifier_model");
  });
});

describe("a cura alcança o seed que quebrava, e só ele", () => {
  it("organização na OpenRouter: tira o seed e preserva o resto do config", async () => {
    // Linha como a 0085 a semeou, mais o que a pessoa ajustou na tela.
    const roteador = await criarRoteador(await criarOrganizacao(NA_OPENROUTER), {
      classifier_model: ID_SEMEADO,
      sticky: false,
      min_confidence: 0.85,
    });

    await curar(roteador);

    const config = await configDe(roteador);
    expect(config).not.toHaveProperty("classifier_model");
    // O resto intacto — `set config = jsonb_build_object(...)` perderia isto.
    expect(config).toMatchObject({ sticky: false, min_confidence: 0.85 });
  });

  it.each([
    ["sem settings.llm", {}],
    ["provider 'anthropic'", { llm: { provider: "anthropic" } }],
    ["provider vazio", { llm: { provider: "" } }],
    ["provider que não é texto", { llm: { provider: 5 } }],
  ])("organização Anthropic (%s): o seed funcionava e fica", async (_caso, settings) => {
    // `llmSettingsSchema` (`credentials.ts`) cai para 'anthropic' nos quatro
    // casos, e lá o alias `claude-haiku-4-5` resolve (0104). Tirar o seed
    // trocaria o Haiku pelo modelo padrão da organização sem ninguém escolher.
    const roteador = await criarRoteador(await criarOrganizacao(settings), {
      classifier_model: ID_SEMEADO,
      sticky: true,
      min_confidence: 0.6,
    });

    await curar(roteador);

    expect(await configDe(roteador)).toMatchObject({ classifier_model: ID_SEMEADO });
  });

  it("escolha da Requesty (anthropic/claude-haiku-4-5) fica, mesmo fora do Anthropic", async () => {
    // Nunca foi seed: é modelo do catálogo da Requesty (0410), gravado pela tela
    // com o provedor junto. A cura original do PR apagava esta linha.
    const roteador = await criarRoteador(
      await criarOrganizacao({ llm: { provider: "requesty" } }),
      { classifier_model: HAIKU_DA_REQUESTY, classifier_provider: "requesty" },
    );

    await curar(roteador);

    expect(await configDe(roteador)).toMatchObject({
      classifier_model: HAIKU_DA_REQUESTY,
      classifier_provider: "requesty",
    });
  });

  it("linha com classifier_provider gravado é escolha e fica", async () => {
    // Organização na OpenRouter que escolheu, pela tela, o Haiku do Anthropic:
    // a chamada vai pelo `llmOverride` para o Anthropic e funciona.
    const roteador = await criarRoteador(await criarOrganizacao(NA_OPENROUTER), {
      classifier_model: ID_SEMEADO,
      classifier_provider: "anthropic",
    });

    await curar(roteador);

    expect(await configDe(roteador)).toMatchObject({
      classifier_model: ID_SEMEADO,
      classifier_provider: "anthropic",
    });
  });

  it("a cura é idempotente", async () => {
    const roteador = await criarRoteador(await criarOrganizacao(NA_OPENROUTER), {
      classifier_model: ID_SEMEADO,
      sticky: true,
    });

    await curar(roteador);
    const primeira = await configDe(roteador);
    await curar(roteador);

    expect(await configDe(roteador)).toEqual(primeira);
  });
});
