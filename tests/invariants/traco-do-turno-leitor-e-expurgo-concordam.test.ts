import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { COLUNAS_DO_TRACO, reciboDoTraco } from "@/lib/agent-engine/agent/recibo-do-traco";
import { janelaDaLeitura } from "@/lib/retencao/janela-do-traco";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode por pnpm test:db no banco efêmero.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 1,
});
afterAll(() => pool.end());

const PESSOAL = "Pessoa Sintética traco3201@example.test +5511999032010";
const SEGREDO = "sk-synthetic-trace-3201-never-used";
type Linha = Parameters<typeof reciboDoTraco>[0];

async function comFixture(
  prova: (
    client: pg.PoolClient,
    ids: { orgs: string[]; users: string[]; traces: string[]; contato: string },
  ) => Promise<void>,
) {
  const client = await pool.connect();
  await client.query("begin; set local timezone = 'UTC'");
  try {
    const ids = {
      orgs: [randomUUID(), randomUUID()],
      users: [randomUUID(), randomUUID()],
      traces: [randomUUID(), randomUUID()],
      contato: randomUUID(),
    };
    for (let i = 0; i < 2; i++) {
      await client.query(
        "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Empresa sintética','Empresa sintética')",
        [ids.orgs[i], `traco-${ids.orgs[i]}`],
      );
      await client.query("insert into auth.users(id,email) values($1,$2)", [
        ids.users[i],
        `${ids.users[i]}@invariant.test`,
      ]);
      await client.query(
        "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",
        [ids.users[i], ids.orgs[i]],
      );
      await client.query(
        `insert into agent_turn_traces(id,organization_id,job_id,contact_id,status,error_code,error_message,ferramentas,skills,kb_sources)
        values($1,$2,$3,$4,'failed','TypeError',$5,$6::jsonb,$7::jsonb,'[]')`,
        [
          ids.traces[i],
          ids.orgs[i],
          randomUUID(),
          ids.contato,
          `${PESSOAL} ${SEGREDO}`,
          JSON.stringify([
            {
              nome: "crm_get_contact",
              estado: "falhou",
              erro: `${PESSOAL} ${SEGREDO}`,
              duracao_ms: 12,
              body: PESSOAL,
            },
          ]),
          JSON.stringify([{ nome: PESSOAL, versao_id: randomUUID(), gatilho: SEGREDO }]),
        ],
      );
    }
    await prova(client, ids);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("o leitor técnico e a poda no Postgres real", () => {
  it("duas organizações: a RLS e o filtro explícito não deixam atravessar pelo mesmo contato", async () => {
    await comFixture(async (client, ids) => {
      for (let i = 0; i < 2; i++) {
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: ids.users[i] }),
        ]);
        const visiveis = await client.query(
          "select id from agent_turn_traces where contact_id=$1",
          [ids.contato],
        );
        expect(visiveis.rows.map((r) => r.id)).toEqual([ids.traces[i]]);
        const outra = await client.query(
          "select id from agent_turn_traces where organization_id=$1 and contact_id=$2",
          [ids.orgs[1 - i], ids.contato],
        );
        expect(outra.rows).toEqual([]);
        await client.query("reset role");
      }
    });
  });

  it("o corte no meio do dia mantém igualdade e o lado recente, e apaga o vencido dos dois tenants", async () => {
    await comFixture(async (client, ids) => {
      const relogio = (
        await client.query<{ agora: string; corte: string }>(
          "select now()::text as agora, (now()-make_interval(days=>100))::text as corte",
        )
      ).rows[0];
      if (!relogio) throw new Error("O banco não devolveu o relógio da transação");
      const janela = janelaDaLeitura({ desde: "2000-01-01" }, 100, new Date(relogio.agora));
      // A API tem precisão de milissegundos; a fronteira SQL abaixo mantém a
      // precisão nativa do banco e usa o MESMO now() estável da transação.
      expect(janela.de.getTime()).toBe(new Date(relogio.corte).getTime());
      await client.query(
        "update agent_turn_traces set created_at=now()-make_interval(days=>100)-interval '1 second' where id=any($1::uuid[])",
        [ids.traces],
      );
      const limites = [randomUUID(), randomUUID()];
      for (let i = 0; i < 2; i++)
        await client.query(
          `insert into agent_turn_traces(id,organization_id,job_id,status,created_at)
        values($1,$2,$3,'completed',now()-make_interval(days=>100)+make_interval(secs=>$4))`,
          [limites[i], ids.orgs[0], randomUUID(), i],
        );
      const leitura = await client.query(
        "select id from agent_turn_traces where organization_id=$1 and created_at >= $2::timestamptz order by created_at",
        [ids.orgs[0], relogio.corte],
      );
      expect(leitura.rows.map((r) => r.id)).toEqual(limites);
      await client.query("set local role service_role");
      const removidos = await client.query(
        "select public.fn_expurgar_traco_do_turno_vencido(100,10000) as n",
      );
      expect(Number(removidos.rows[0].n)).toBeGreaterThanOrEqual(2);
      await client.query("reset role");
      expect(
        (
          await client.query("select id from agent_turn_traces where id=any($1::uuid[])", [
            ids.traces,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await client.query(
            "select id from agent_turn_traces where id=any($1::uuid[]) order by created_at",
            [limites],
          )
        ).rows.map((r) => r.id),
      ).toEqual(limites);
    });
  });

  it("o conteúdo pessoal realmente guardado no legado não sai pelo recibo projetado", async () => {
    await comFixture(async (client, ids) => {
      expect(
        (
          await client.query("select error_message from agent_turn_traces where id=$1", [
            ids.traces[0],
          ])
        ).rows[0].error_message,
      ).toContain(PESSOAL);
      for (let i = 0; i < 2; i++) {
        const linhas = await client.query<Linha>(
          `select ${COLUNAS_DO_TRACO} from agent_turn_traces where organization_id=$1`,
          [ids.orgs[i]],
        );
        const recibos = linhas.rows.map(reciboDoTraco);
        expect(recibos).toHaveLength(1);
        expect(recibos[0]).toMatchObject({
          id: ids.traces[i],
          error_code: "TypeError",
          ferramentas: [
            { nome: "crm_get_contact", estado: "falhou", erro: "internal_error", duracao_ms: 12 },
          ],
        });
        expect(JSON.stringify(recibos)).not.toContain(PESSOAL);
        expect(JSON.stringify(recibos)).not.toContain(SEGREDO);
      }
    });
  });
});
