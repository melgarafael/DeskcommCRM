/**
 * `remove_tag` sob DOIS eventos concorrentes sobre o mesmo negócio ou contato
 * (migration 0768) — o espelho de `add-tag-concorrente-nao-apaga.test.ts`.
 *
 * Dois clients `pg`, duas transações abertas: um dreno TIRA uma etiqueta e
 * segura a linha; o outro PÕE (ou tira) outra e tem de ESPERAR. Se a remoção
 * fosse feita fora do UPDATE — ler a lista no app e gravar "a lista menos as
 * pedidas" —, o segundo gravaria a foto que leu antes do commit do primeiro, e
 * a etiqueta tirada voltaria (ou a posta sumiria) sem erro nenhum.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/register-all";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
afterAll(() => pool.end());

type Resultado = { data: unknown; error: { message: string; code?: string } | null };

const FUNCOES: Record<string, "p_lead" | "p_contato"> = {
  fn_lead_adicionar_etiquetas: "p_lead",
  fn_contato_adicionar_etiquetas: "p_contato",
  fn_lead_remover_etiquetas: "p_lead",
  fn_contato_remover_etiquetas: "p_contato",
};

/** O client admin PRESO a uma transação: o commit é do teste. */
function adminDaTransacao(client: pg.PoolClient): ActionCtx["admin"] {
  return {
    rpc: async (nome: string, params: Record<string, unknown>): Promise<Resultado> => {
      try {
        const chaveDoId = FUNCOES[nome];
        if (chaveDoId) {
          const r = await client.query(
            `select public.${nome}($1::uuid, $2::uuid, $3::text[]) as resposta;`,
            [params.p_org, params[chaveDoId], params.p_etiquetas],
          );
          return { data: r.rows[0].resposta, error: null };
        }
        if (nome === "emit_event") {
          await client.query(
            `select public.emit_event($1::text, $2::text, $3::uuid, $4::jsonb, $5::jsonb, $6::uuid);`,
            [
              params.p_event_type,
              params.p_entity_kind,
              params.p_entity_id,
              JSON.stringify(params.p_payload ?? {}),
              JSON.stringify(params.p_metadata ?? {}),
              params.p_organization_id,
            ],
          );
          return { data: null, error: null };
        }
        throw new Error(`dublê: rpc desconhecida ${nome}`);
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },
  } as unknown as ActionCtx["admin"];
}

async function fixture(etiquetasDoNegocio: string[] = [], etiquetasDoContato: string[] = []) {
  const org = randomUUID();
  const pipeline = randomUUID();
  const stage = randomUUID();
  const lead = randomUUID();
  const contato = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'RemoveTag','RemoveTag')",
    [org],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Funil',$1::text)",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Entrada','entrada',1)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name,tags) values($1,$2,'Contato',$3)",
    [contato, org, etiquetasDoContato],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,contact_id,tags) values($1,$2,$3,$4,'Negócio',$5,$6)",
    [lead, org, pipeline, stage, contato, etiquetasDoNegocio],
  );
  return { org, lead, contato };
}

function eventoDaRegra(org: string, client: pg.PoolClient, contexto: Record<string, unknown>): ActionCtx {
  const regra = randomUUID();
  return {
    admin: adminDaTransacao(client),
    organizationId: org,
    ruleId: regra,
    ruleName: regra,
    event: { id: randomUUID() } as unknown as EventRow,
    requestId: `rule:${regra}`,
    context: contexto,
  } as ActionCtx;
}

const tagsDoNegocio = async (id: string) =>
  (await pool.query("select tags from crm_leads where id=$1", [id])).rows[0].tags as string[];
const tagsDoContato = async (id: string) =>
  (await pool.query("select tags from contacts where id=$1", [id])).rows[0].tags as string[];

async function esperandoTrava(observer: pg.PoolClient, pid: number) {
  await expect
    .poll(
      async () => {
        const r = (
          await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])
        ).rows[0];
        return r?.wait_event_type === "Lock";
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(true);
}

/** A tira e segura a linha; B roda a sua ação e tem de esperar o commit de A. */
async function corrida(
  primeira: (c: pg.PoolClient) => Promise<unknown>,
  segunda: (c: pg.PoolClient) => Promise<unknown>,
) {
  const a = await pool.connect();
  const b = await pool.connect();
  const observer = await pool.connect();
  const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  try {
    await a.query("begin; set local statement_timeout='10s'");
    await b.query("begin; set local statement_timeout='10s'");
    await primeira(a);
    const pendenteB = segunda(b);
    await esperandoTrava(observer, bpid);
    await a.query("commit");
    const resultadoB = await pendenteB;
    await b.query("commit");
    return resultadoB;
  } finally {
    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    a.release();
    b.release();
    observer.release();
  }
}

describe("remove_tag concorrente", () => {
  it("⭐ negócio: tirar e pôr ao mesmo tempo — a tirada não volta e a posta não some", async () => {
    const f = await fixture(["vip", "quente"]);
    const foto = () => ({ lead: { id: f.lead, contact_id: f.contato, tags: ["vip", "quente"] } });

    await corrida(
      (c) => getAction("remove_tag")!.execute(eventoDaRegra(f.org, c, foto()), { tags: ["vip"] }),
      (c) => getAction("add_tag")!.execute(eventoDaRegra(f.org, c, foto()), { tags: ["novo"] }),
    );

    expect(await tagsDoNegocio(f.lead)).toEqual(["quente", "novo"]);
  });

  it("⭐ contato: dois eventos tiram etiquetas DIFERENTES — as duas saem", async () => {
    const f = await fixture([], ["vip", "quente", "cliente"]);
    const foto = () => ({ contact: { id: f.contato, tags: ["vip", "quente", "cliente"] } });

    const resultadoB = await corrida(
      (c) => getAction("remove_tag")!.execute(eventoDaRegra(f.org, c, foto()), { tags: ["vip"] }),
      (c) => getAction("remove_tag")!.execute(eventoDaRegra(f.org, c, foto()), { tags: ["quente"] }),
    );

    expect(await tagsDoContato(f.contato)).toEqual(["cliente"]);
    expect(resultadoB).toMatchObject({ status: "success", detail: { removed: ["quente"] } });
  });
});

describe("a função de remoção", () => {
  it("casa pela chave canônica e preserva a ordem das que ficam", async () => {
    const f = await fixture(["A", " VIP ", "b", "vip"]);
    const r = await pool.query("select public.fn_lead_remover_etiquetas($1::uuid,$2::uuid,$3::text[]) as r", [
      f.org,
      f.lead,
      ["Vip", null, "  "],
    ]);
    expect(r.rows[0].r).toEqual({ tags: ["A", "b"], removidas: [" VIP ", "vip"] });
    expect(await tagsDoNegocio(f.lead)).toEqual(["A", "b"]);
  });

  it("pedido só com vazios recusa (22023), sem tocar na linha", async () => {
    const f = await fixture(["vip"]);
    await expect(
      pool.query("select public.fn_lead_remover_etiquetas($1::uuid,$2::uuid,$3::text[])", [f.org, f.lead, [" "]]),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await tagsDoNegocio(f.lead)).toEqual(["vip"]);
  });

  it("nem anon nem authenticated executam — só service_role", async () => {
    const f = await fixture(["vip"], ["vip"]);
    for (const [fn, id] of [
      ["fn_lead_remover_etiquetas", f.lead],
      ["fn_contato_remover_etiquetas", f.contato],
    ] as const) {
      for (const papel of ["anon", "authenticated"]) {
        const c = await pool.connect();
        try {
          await c.query("begin");
          await c.query(`set local role ${papel}`);
          await expect(
            c.query(`select public.${fn}($1::uuid,$2::uuid,$3::text[])`, [f.org, id, ["vip"]]),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await c.query("rollback");
          c.release();
        }
      }
    }
    expect(await tagsDoNegocio(f.lead)).toEqual(["vip"]);
    expect(await tagsDoContato(f.contato)).toEqual(["vip"]);
  });

  it("linha de OUTRA organização devolve nulo e não é tocada", async () => {
    const dono = await fixture(["intacto"], ["intacto"]);
    const outra = await fixture();
    const lead = await pool.query("select public.fn_lead_remover_etiquetas($1::uuid,$2::uuid,$3::text[]) as r", [
      outra.org,
      dono.lead,
      ["intacto"],
    ]);
    const contato = await pool.query(
      "select public.fn_contato_remover_etiquetas($1::uuid,$2::uuid,$3::text[]) as r",
      [outra.org, dono.contato, ["intacto"]],
    );
    expect(lead.rows[0].r).toBeNull();
    expect(contato.rows[0].r).toBeNull();
    expect(await tagsDoNegocio(dono.lead)).toEqual(["intacto"]);
    expect(await tagsDoContato(dono.contato)).toEqual(["intacto"]);
  });
});
