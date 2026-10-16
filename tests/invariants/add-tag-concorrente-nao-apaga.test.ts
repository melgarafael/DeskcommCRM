/**
 * DOIS EVENTOS DIFERENTES, processados por dois drenos AO MESMO TEMPO sobre o
 * mesmo negócio ou contato, NÃO se apagam (issue #2888, migration 0682).
 *
 * ─── O que este arquivo mede, e por que ele é diferente do unitário ────────
 *
 * O `add_tag.test.ts` mede o que a ação faz com a resposta da função, num banco
 * de mentira. A corrida que a #2888 descreve NÃO cabe num dublê: é o banco que
 * tem de mostrar a espera entre transações de verdade. Aqui são dois clients
 * `pg`, duas transações abertas, e o segundo chamando a função ENQUANTO o
 * primeiro não confirmou:
 *
 *     dreno A: fn_lead_adicionar_etiquetas --> (grava, SEGURA a linha)
 *     dreno B:   fn_lead_adicionar_etiquetas --> tem de ESPERAR
 *     dreno A: commit
 *     dreno B: .......____________________ recalcula sobre o que A gravou
 *
 * Se a junção fosse feita FORA do UPDATE — ler, montar a lista no app e gravar,
 * que era o estado do #2864 — as duas leriam a MESMA lista, cada uma gravaria a
 * sua própria foto e a última venceria sozinha: a etiqueta da outra sumiria sem
 * erro nenhum. É a SABOTAGEM que este arquivo tem de saber pegar: volte a ação a
 * ler-e-gravar e o primeiro caso fica VERMELHO.
 *
 * ─── Por que os dois eventos vêm do MESMO dreno seqüencial aqui ────────────
 *
 * Não vêm: a ação é executada uma vez por evento, cada uma com o SEU client e a
 * SUA transação — é a forma fiel do que o `event_log` produz, com o laço do
 * agent-worker e o cron `app/api/v1/cron/event-log-drain` consumindo em
 * paralelo. O claim exclusivo por LINHA deixa dois eventos distintos do mesmo
 * negócio caírem exatamente aqui. Nada neste teste toca o dreno, o claim ou o
 * agendamento: o que está sob medida é a GRAVAÇÃO.
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

/**
 * O suficiente do client admin, PRESO A UMA transação.
 *
 * É o ponto do teste: as chamadas da ação saem no client que o teste escolheu,
 * então o commit é do teste — e é ele que abre a janela entre as duas execuções.
 *
 * O ramo `.from(...)` existe para a SABOTAGEM (a ação que lê e grava por fora):
 * quando a ação volta a montar a lista em memória, é por ali que ela passa.
 */
function adminDaTransacao(client: pg.PoolClient): ActionCtx["admin"] {
  const builder = (tabela: string) => {
    let colunas = "*";
    let dados: Record<string, unknown> = {};
    const filtros: Array<{ col: string; val: unknown }> = [];
    const clausula = () =>
      filtros.length ? ` where ${filtros.map((f, i) => `${f.col} = $${i + 1}`).join(" and ")}` : "";
    const valores = () => filtros.map((f) => f.val);

    const api = {
      select: (cols: string) => {
        colunas = cols;
        return api;
      },
      update: (novos: Record<string, unknown>) => {
        dados = novos;
        return api;
      },
      eq: (col: string, val: unknown) => {
        filtros.push({ col, val });
        return api;
      },
      maybeSingle: async (): Promise<Resultado> => {
        const r = await client.query(
          `select ${colunas} from public.${tabela}${clausula()}`,
          valores(),
        );
        return { data: r.rows[0] ?? null, error: null };
      },
      // O builder do supabase é thenável: `await update(...).eq(...)` cai aqui.
      then: (ok: (v: Resultado) => unknown, falha?: (e: unknown) => unknown) => {
        const colunasDoPayload = Object.keys(dados);
        const sets = colunasDoPayload.map((c, i) => `${c} = $${filtros.length + i + 1}`);
        return Promise.resolve()
          .then(() =>
            client.query(
              `update public.${tabela} set ${sets.join(", ")}${clausula()};`,
              [...valores(), ...colunasDoPayload.map((c) => dados[c])],
            ),
          )
          .then(() => ({ data: null, error: null }) as Resultado)
          .then(ok, falha);
      },
    };
    return api;
  };

  return {
    from: builder,
    rpc: async (nome: string, params: Record<string, unknown>): Promise<Resultado> => {
      try {
        if (nome === "fn_lead_adicionar_etiquetas" || nome === "fn_contato_adicionar_etiquetas") {
          const id = String(
            nome === "fn_lead_adicionar_etiquetas" ? params.p_lead : params.p_contato,
          );
          const r = await client.query(
            `select public.${nome}($1::uuid, $2::uuid, $3::text[]) as resposta;`,
            [params.p_org, id, params.p_etiquetas],
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

/** Um negócio, um contato e a org dona deles — nada compartilhado entre casos. */
async function fixture(etiquetasDoNegocio: string[] = [], etiquetasDoContato: string[] = []) {
  const org = randomUUID();
  const pipeline = randomUUID();
  const stage = randomUUID();
  const lead = randomUUID();
  const contato = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'AddTag','AddTag')",
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
  // O contato ANTES do negócio: `crm_leads.contact_id` referencia `contacts`.
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

/** Uma execução de `add_tag` — a forma de UM evento, com o SEU client. */
function eventoDaRegra(
  f: { org: string; lead: string; contato: string },
  client: pg.PoolClient,
  regra: string,
  contexto: Record<string, unknown>,
): ActionCtx {
  return {
    admin: adminDaTransacao(client),
    organizationId: f.org,
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

describe("dois eventos concorrentes sobre o mesmo alvo", () => {
  it("⭐ negócio: a etiqueta do evento que chega DEPOIS não apaga a do primeiro", async () => {
    const f = await fixture();
    const a = await pool.connect();
    const b = await pool.connect();
    const observer = await pool.connect();
    const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
    try {
      await a.query("begin; set local statement_timeout='10s'");
      await b.query("begin; set local statement_timeout='10s'");

      // As duas fotos são a MESMA lista vazia: é o que dois drenos leem antes de
      // qualquer gravação — o que difere é que este teste ABRE a janela de
      // propósito, segurando a primeira transação.
      const regraA = randomUUID();
      const regraB = randomUUID();

      const pendenteA = getAction("add_tag")!.execute(
        eventoDaRegra(f, a, regraA, { lead: { id: f.lead, contact_id: f.contato, tags: [] } }),
        { tags: ["produto-a"] },
      );
      await pendenteA; // A gravou e SEGURA a linha (não confirmou ainda).

      const pendenteB = getAction("add_tag")!.execute(
        eventoDaRegra(f, b, regraB, { lead: { id: f.lead, contact_id: f.contato, tags: [] } }),
        { tags: ["origem-web"] },
      );
      await esperandoTrava(observer, bpid); // B está esperando a linha, não passou por cima.

      await a.query("commit");
      const resultadoB = await pendenteB;
      await b.query("commit");

      // A promessa da issue: as DUAS sobrevivem.
      expect(await tagsDoNegocio(f.lead)).toEqual(["produto-a", "origem-web"]);
      expect(resultadoB.status).toBe("success");
      // E a ação anuncia o que o RETURNING devolveu — a lista JÁ com a etiqueta
      // do outro evento, não a foto que ela leu antes.
      expect(resultadoB.detail).toMatchObject({ added: ["origem-web"] });

      const doEventoB = (
        await pool.query(
          "select payload from event_log where entity_id=$1 and metadata->>'caused_by_rule'=$2",
          [f.lead, regraB],
        )
      ).rows;
      expect(doEventoB).toHaveLength(1);
      expect(doEventoB[0].payload).toMatchObject({
        added_tags: ["origem-web"],
        tags: ["produto-a", "origem-web"],
      });
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
      observer.release();
    }
  });

  it("⭐ contato: mesma corrida, mesmo desfecho — `destino: contato` não perde etiqueta", async () => {
    const f = await fixture([], []);
    const a = await pool.connect();
    const b = await pool.connect();
    const observer = await pool.connect();
    const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
    try {
      await a.query("begin; set local statement_timeout='10s'");
      await b.query("begin; set local statement_timeout='10s'");

      const pendenteA = getAction("add_tag")!.execute(
        eventoDaRegra(f, a, randomUUID(), { contact: { id: f.contato, tags: [] } }),
        { tags: ["cliente"] },
      );
      await pendenteA;

      const pendenteB = getAction("add_tag")!.execute(
        eventoDaRegra(f, b, randomUUID(), { contact: { id: f.contato, tags: [] } }),
        { tags: ["inbox"] },
      );
      await esperandoTrava(observer, bpid);

      await a.query("commit");
      await pendenteB;
      await b.query("commit");

      expect(await tagsDoContato(f.contato)).toEqual(["cliente", "inbox"]);
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
      observer.release();
    }
  });

  it("o mesmo evento (duas regras, uma execução depois da outra) continua como o #2864 deixou", async () => {
    const f = await fixture();
    const client = await pool.connect();
    try {
      // Sem transação aberta à mão: é o caminho de sempre, um depois do outro.
      const regra1 = randomUUID();
      const regra2 = randomUUID();
      const foto = { lead: { id: f.lead, contact_id: f.contato, tags: [] as string[] } };

      await getAction("add_tag")!.execute(eventoDaRegra(f, client, regra1, structuredClone(foto)), {
        tags: ["produto-a"],
      });
      await getAction("add_tag")!.execute(eventoDaRegra(f, client, regra2, structuredClone(foto)), {
        tags: ["origem-web", "formulario"],
      });

      expect(await tagsDoNegocio(f.lead)).toEqual(["produto-a", "origem-web", "formulario"]);
    } finally {
      client.release();
    }
  });
});

describe("quem alcança a função", () => {
  it("nem anon nem authenticated executam a junção — só service_role", async () => {
    const f = await fixture();
    const chamada = "select public.fn_lead_adicionar_etiquetas($1::uuid,$2::uuid,$3::text[])";
    for (const papel of ["anon", "authenticated"]) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(`set local role ${papel}`);
        await expect(
          c.query(chamada, [f.org, f.lead, ["invasor"]]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await c.query("rollback");
        c.release();
      }
    }
    expect(await tagsDoNegocio(f.lead)).toEqual([]);
  });

  it("negócio de OUTRA organização devolve nulo e não grava nada", async () => {
    const dono = await fixture(["intacto"]);
    const outra = await fixture();

    const r = await pool.query("select public.fn_lead_adicionar_etiquetas($1::uuid,$2::uuid,$3::text[])", [
      outra.org,
      dono.lead,
      ["invasor"],
    ]);

    expect(r.rows[0].fn_lead_adicionar_etiquetas).toBeNull();
    expect(await tagsDoNegocio(dono.lead)).toEqual(["intacto"]);
  });
});
