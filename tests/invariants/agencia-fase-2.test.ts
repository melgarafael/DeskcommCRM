import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, seedGov } from "./gov-helpers";

/**
 * O banco da Fase 2 da agência (migration 9004, docs/agencia/SPEC-clientes.md,
 * SPEC-acervo.md, SPEC-tarefas.md): nenhuma tabela nova é alcançável pelo
 * PostgREST, e as três garantias de unicidade que a regra de negócio usa valem.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const TABELAS = [
  "agencia_clientes",
  "agencia_clientes_empresas",
  "agencia_clientes_membros",
  "agencia_contratacoes",
  "agencia_drive",
  "agencia_etiquetas",
  "agencia_tarefas_recorrentes",
  "agencia_recorrentes_responsaveis",
  "agencia_recorrentes_etiquetas",
  "agencia_tarefas",
  "agencia_tarefas_responsaveis",
  "agencia_tarefas_checklist",
  "agencia_tarefas_links",
  "agencia_tarefas_etiquetas",
  "agencia_tarefas_tempo",
  "agencia_avisos_de_prazo",
  "agencia_arquivos",
] as const;

const membro = randomUUID();
const cliente = randomUUID();
const tarefa = randomUUID();

async function como(user: string | null, sql: string): Promise<pg.QueryResult> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(user ? { sub: user, role: "authenticated" } : { role: "anon" }),
    ]);
    const r = await c.query(sql);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await seedGov();
  await pool.query(
    "insert into agencia_membros(id,user_id,nome,whatsapp,email,situacao) values ($1,$2,'M','+5511900000009',$3,'ativo')",
    [membro, GOV_AGENT_A, `m-${membro}@agencia.test`],
  );
  await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente F2')", [cliente]);
  await pool.query("insert into agencia_tarefas(id,titulo,cliente_id) values ($1,'Editar vídeos',$2)", [tarefa, cliente]);
});

afterAll(async () => {
  await pool.query("delete from agencia_tarefas where id = $1", [tarefa]);
  await pool.query("delete from agencia_clientes where id = $1", [cliente]);
  await pool.query("delete from agencia_membros where id = $1", [membro]);
  await pool.end();
});

describe("nenhuma tabela da fase 2 é alcançável pelo PostgREST", () => {
  it.each(TABELAS)("anon não lê %s", async (t) => {
    await expect(como(null, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
  it.each(TABELAS)("authenticated não lê %s", async (t) => {
    await expect(como(GOV_AGENT_A, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("as unicidades da regra de negócio", () => {
  it("uma pessoa tem um cronômetro rodando por vez", async () => {
    await pool.query("insert into agencia_tarefas_tempo(tarefa_id,membro_id,inicio) values ($1,$2,now())", [tarefa, membro]);
    try {
      await expect(
        pool.query("insert into agencia_tarefas_tempo(tarefa_id,membro_id,inicio) values ($1,$2,now())", [tarefa, membro]),
      ).rejects.toThrow(/agencia_tempo_um_rodando/);
    } finally {
      await pool.query("delete from agencia_tarefas_tempo where membro_id = $1", [membro]);
    }
  });

  it("a recorrência gera uma tarefa por instante", async () => {
    const r = randomUUID();
    await pool.query("insert into agencia_tarefas_recorrentes(id,titulo,padrao) values ($1,'Cortes','diaria')", [r]);
    try {
      const instante = "2026-11-02T11:00:00Z";
      await pool.query("insert into agencia_tarefas(titulo,recorrente_id,gerada_para) values ('Cortes',$1,$2)", [r, instante]);
      await expect(
        pool.query("insert into agencia_tarefas(titulo,recorrente_id,gerada_para) values ('Cortes',$1,$2)", [r, instante]),
      ).rejects.toThrow(/agencia_tarefas_uma_por_recorrencia/);
    } finally {
      await pool.query("delete from agencia_tarefas where recorrente_id = $1", [r]);
      await pool.query("delete from agencia_tarefas_recorrentes where id = $1", [r]);
    }
  });

  it("cada marco de prazo avisa uma vez", async () => {
    await pool.query("insert into agencia_avisos_de_prazo(tarefa_id,marco) values ($1,'no_dia')", [tarefa]);
    await expect(
      pool.query("insert into agencia_avisos_de_prazo(tarefa_id,marco) values ($1,'no_dia')", [tarefa]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("uma organização é cliente de um cadastro só", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "insert into organizations(id,slug,display_name,legal_name) values (gen_random_uuid(), $1, 'Org F2', 'Org F2') returning id",
      [`org-f2-${randomUUID()}`],
    );
    const org = rows[0]!.id;
    await pool.query("update agencia_clientes set organization_id = $1 where id = $2", [org, cliente]);
    await expect(pool.query("insert into agencia_clientes(nome,organization_id) values ('Outro',$1)", [org])).rejects.toThrow(
      /agencia_clientes_organizacao_unica/,
    );
    await pool.query("update agencia_clientes set organization_id = null where id = $1", [cliente]);
  });
});

describe("o que nasce pronto", () => {
  it("as etiquetas do quadro de referência e a linha do Drive", async () => {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from agencia_etiquetas");
    expect(rows[0]?.n).toBeGreaterThanOrEqual(7);
    const drive = await pool.query<{ n: number }>("select count(*)::int as n from agencia_drive");
    expect(drive.rows[0]?.n).toBe(1);
  });
});
