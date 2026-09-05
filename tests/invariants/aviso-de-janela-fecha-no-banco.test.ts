import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import {
  avisarJanelaFechada,
  resolverAvisoDeJanela,
  REF_KIND_JANELA,
} from "@/lib/agent-engine/pacing/aviso-de-janela";

/**
 * O AVISO DE JANELA FECHADA TEM QUE FECHAR — CONTRA UM POSTGRES DE VERDADE.
 *
 * ─── O defeito que este arquivo existe para ter pegado ─────────────────────
 *
 * `lib/agent-engine/pacing/aviso-de-janela.ts` (commit 4912c5230, 2026-08-30)
 * resolve o aviso "as respostas da IA estão esperando a janela de envio abrir"
 * com:
 *
 *     update agent_inbox_items set status = 'resolved', resolved_at = now() ...
 *
 * `agent_inbox_items.resolved_at` NÃO EXISTIA — nem no snapshot original nem em
 * migration nenhuma depois. O commit mexeu no código e em nenhuma migration, e
 * o defeito viajou até a VPS de quem instalou (PR #569, @automatikpg-ux).
 *
 * Três propriedades tornam esse erro invisível, e são elas que decidem a FORMA
 * deste teste:
 *
 *  1. **É erro de PARSE (42703), não de linha.** O Postgres resolve o nome da
 *     coluna na análise, ANTES de olhar o `where`. Então o UPDATE estoura mesmo
 *     quando não há nenhum aviso aberto — isto é, a CADA turno atendido dentro
 *     do horário, e não só quando existe aviso. Por isso o caso "não havia nada
 *     a resolver" abaixo não é enfeite: é o caminho quente do defeito.
 *  2. **O chamador é fire-and-forget.** O `catch` engole de propósito, para que
 *     telemetria nunca derrube a resposta ao lead. Correto, e é o que faz o erro
 *     não aparecer em lugar nenhum.
 *  3. **O sintoma é o oposto do estado.** O aviso "este número está calado" fica
 *     `open` para sempre enquanto o agente responde normalmente.
 *
 * ─── Por que aqui, e não em tests/unit ─────────────────────────────────────
 *
 * `tests/unit/silencio-da-janela-deixa-rastro.test.ts` cobre as duas funções e
 * ficou VERDE o tempo todo — o dublê devolve `{rows: [], rowCount}` para
 * qualquer string, e as asserções são sobre a string do SQL
 * (`expect(sql).toContain("update agent_inbox_items")`). Ele guarda a CHAMADA,
 * nunca o EFEITO: aquele SQL jamais tocou um Postgres, e nenhum dublê sabe se a
 * coluna existe.
 *
 * O conserto por classe é este arquivo: as funções REAIS contra o Postgres
 * efêmero do `scripts/test-db.sh`, com o `supabase/baseline.sql` aplicado — o
 * mesmo arquivo que o kit self-host instala. Isso faz o teste provar as duas
 * coisas de uma vez: que o comportamento fecha o laço, e que a mudança de
 * schema chegou ao APÊNDICE do baseline (só a migration não bastaria — o
 * `update.sh` de clone não lê `migrations/`).
 *
 * A próxima coluna inventada por código morre aqui, no job obrigatório
 * `invariants`, e não em silêncio na VPS de alguém.
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

const ORG = "7a11e1a0-0000-4000-8000-000000000001";
/** Segunda organização: a janela de um tenant não pode fechar o aviso do outro. */
const ORG_VIZINHA = "7a11e1a0-0000-4000-8000-000000000002";
const CANAL = "7a11e1a0-0000-4000-8000-00000000000a";

/** `ref_id` é `uuid` na tabela; o input é o id da channel_session. */
const BASE = {
  channelSessionId: CANAL,
  abertura: new Date("2026-08-31T10:00:00.000Z"),
  janela: "7h-22h",
  timezone: "America/Sao_Paulo",
  domingoDesligado: true,
};

async function avisosDe(org: string) {
  const { rows } = await pool.query<{
    status: string;
    resolved_at: string | null;
    kind: string;
    severity: string;
    title: string;
  }>(
    `select status, resolved_at, kind, severity, title
       from agent_inbox_items
      where organization_id = $1 and ref_kind = $2 and ref_id = $3
      order by created_at`,
    [org, REF_KIND_JANELA, CANAL],
  );
  return rows;
}

/**
 * Conta sem LER `resolved_at`, de propósito.
 *
 * O caso de dedup não precisa da coluna, e é o CONTROLE da sabotagem desta
 * catraca: com a coluna removida do baseline, ele tem de continuar VERDE. Se
 * ele ficasse vermelho junto com os outros, a rodada não distinguiria "a coluna
 * sumiu" de "o harness não subiu" — e uma sabotagem em que tudo falha não prova
 * que o teste vigia a coisa certa.
 */
async function contarAvisos(org: string) {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from agent_inbox_items
      where organization_id = $1 and ref_kind = $2 and ref_id = $3`,
    [org, REF_KIND_JANELA, CANAL],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-janela-invariante"],
    [ORG_VIZINHA, "org-janela-invariante-vizinha"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Org Janela LTDA', 'Org Janela')
       on conflict (id) do nothing`,
      [id, slug],
    );
  }
});

beforeEach(async () => {
  await pool.query("delete from agent_inbox_items where organization_id = any($1::uuid[])", [
    [ORG, ORG_VIZINHA],
  ]);
});

afterAll(async () => {
  await pool.query("delete from agent_inbox_items where organization_id = any($1::uuid[])", [
    [ORG, ORG_VIZINHA],
  ]);
  await pool.query("delete from organizations where id = any($1::uuid[])", [[ORG, ORG_VIZINHA]]);
  await pool.end();
});

describe("aviso de janela de envio fechada, contra o banco real", () => {
  it("a coluna que o motor grava EXISTE, é timestamptz e é anulável", async () => {
    // Anulável e sem default não é detalhe estético: é o que faz o `update.sh`
    // de um clone com linhas antigas não quebrar. Um `not null` aqui reprovaria
    // toda linha de `agent_inbox_items` já gravada.
    const { rows } = await pool.query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agent_inbox_items'
          and column_name = 'resolved_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe("timestamp with time zone");
    expect(rows[0]!.is_nullable).toBe("YES");
  });

  it("abrir grava UM aviso, aberto e ainda sem carimbo de resolução", async () => {
    const criados = await avisarJanelaFechada(pool, { tenantId: ORG, ...BASE });
    expect(criados).toBe(1);

    const avisos = await avisosDe(ORG);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.status).toBe("open");
    expect(avisos[0]!.resolved_at).toBeNull();
    // 'other' + 'warn' são os únicos valores que os CHECKs da tabela aceitam
    // para este aviso — e só um Postgres de verdade reprova quem errar.
    expect(avisos[0]!.kind).toBe("other");
    expect(avisos[0]!.severity).toBe("warn");
  });

  it("rajada não vira enxurrada: 50 pessoas no domingo continuam UM aviso", async () => {
    await avisarJanelaFechada(pool, { tenantId: ORG, ...BASE });
    const segundo = await avisarJanelaFechada(pool, { tenantId: ORG, ...BASE });
    expect(segundo).toBe(0);
    expect(await contarAvisos(ORG)).toBe(1);
  });

  it("resolver CARIMBA resolved_at — o laço fecha no banco, não só na string do SQL", async () => {
    // Este é o caso que teria falhado no dia em que o 4912c5230 entrou: o
    // UPDATE existia, o teste de unidade estava verde, e a coluna não existia.
    await avisarJanelaFechada(pool, { tenantId: ORG, ...BASE });

    const resolvidos = await resolverAvisoDeJanela(pool, {
      tenantId: ORG,
      channelSessionId: CANAL,
    });
    expect(resolvidos).toBe(1);

    const avisos = await avisosDe(ORG);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.status).toBe("resolved");
    expect(avisos[0]!.resolved_at).not.toBeNull();
  });

  it("resolver SEM nada aberto não estoura — o caminho quente do defeito", async () => {
    // Erro de coluna inexistente é 42703, levantado na ANÁLISE do comando: o
    // Postgres nem chega ao `where`. Então o UPDATE que não casa linha nenhuma
    // falha exatamente igual ao que casa — e é ele que roda a cada turno
    // atendido dentro do horário, dezenas de vezes por hora, o dia inteiro.
    // Sem este caso, uma catraca que só exercitasse o aviso ABERTO deixaria
    // passar a versão do defeito que mais acontece.
    await expect(
      resolverAvisoDeJanela(pool, { tenantId: ORG, channelSessionId: CANAL }),
    ).resolves.toBe(0);
  });

  it("o laço reabre: janela fecha de novo no dia seguinte e há aviso novo", async () => {
    // O dedup é por aviso ABERTO. Se ele fosse por ref_kind+ref_id sem olhar o
    // status, o segundo domingo ficaria mudo — de novo.
    await avisarJanelaFechada(pool, { tenantId: ORG, ...BASE });
    await resolverAvisoDeJanela(pool, { tenantId: ORG, channelSessionId: CANAL });

    expect(await avisarJanelaFechada(pool, { tenantId: ORG, ...BASE })).toBe(1);

    const avisos = await avisosDe(ORG);
    expect(avisos).toHaveLength(2);
    expect(avisos.map((a) => a.status)).toEqual(["resolved", "open"]);
  });

  it("a janela de um tenant não fecha o aviso do vizinho", async () => {
    // Mesmo channel_session_id nos dois: se o UPDATE esquecesse o
    // organization_id, este caso é o único que notaria.
    await avisarJanelaFechada(pool, { tenantId: ORG, ...BASE });
    await avisarJanelaFechada(pool, { tenantId: ORG_VIZINHA, ...BASE });

    expect(
      await resolverAvisoDeJanela(pool, { tenantId: ORG, channelSessionId: CANAL }),
    ).toBe(1);

    expect((await avisosDe(ORG))[0]!.status).toBe("resolved");
    const vizinho = (await avisosDe(ORG_VIZINHA))[0]!;
    expect(vizinho.status).toBe("open");
    expect(vizinho.resolved_at).toBeNull();
  });
});
