/**
 * O LEAD SÓ SE LIGA A CONTATO E RESPONSÁVEL DA PRÓPRIA EMPRESA — no banco
 * (migration 0403).
 *
 * Os handlers de lead já conferiam, mas não eram o único caminho: a REST do
 * banco (`/rest/v1/crm_leads`, com GRANT para `authenticated` e políticas que
 * não olham `contact_id`) e a RPC `fn_nascer_lead_da_conversa` (security
 * invoker) gravavam o contato de outra organização e o responsável de fora.
 * Aqui os dois caminhos rodam COMO `authenticated`, com o JWT de um manager da
 * organização A — o mesmo que o browser tem —, e a cura roda contra vínculos
 * cruzados plantados com o gatilho desligado.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const orgA = randomUUID();
const orgB = randomUUID();
const managerA = randomUUID();
const agenteA = randomUUID();
const desligadoA = randomUUID();
const viewerA = randomUUID();
const membroB = randomUUID();
const contatoA = randomUUID();
const contatoA2 = randomUUID();
const contatoB = randomUUID();
const funilA = randomUUID();
const etapaA = randomUUID();
let leadA: string;

async function novoLead(extra: { contact_id?: string | null; owner_user_id?: string | null } = {}): Promise<string> {
  const { rows } = await pool.query(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id, owner_user_id, owner_kind)
     values ($1, $2, $3, 'Negócio', $4, $5, case when $5::uuid is null then null else 'user' end)
     returning id`,
    [orgA, funilA, etapaA, extra.contact_id ?? null, extra.owner_user_id ?? null],
  );
  return rows[0].id as string;
}

/** Roda `sql` como o browser rodaria: papel `authenticated` e o JWT do usuário. */
async function comoUsuario(usuario: string, sql: string, args: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: usuario, role: "authenticated", aal: "aal1" }),
    ]);
    const resultado = await client.query(sql, args);
    await client.query("commit");
    return resultado;
  } catch (erro) {
    await client.query("rollback");
    throw erro;
  } finally {
    client.release();
  }
}

async function recusa(promessa: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await promessa;
  } catch (erro) {
    return erro as pg.DatabaseError;
  }
  throw new Error("a escrita devia ter sido recusada e passou");
}

async function lead(id: string) {
  const { rows } = await pool.query(
    "select contact_id, owner_user_id, owner_kind, title from crm_leads where id = $1",
    [id],
  );
  return rows[0] as { contact_id: string | null; owner_user_id: string | null; owner_kind: string | null; title: string };
}

beforeAll(async () => {
  for (const u of [managerA, agenteA, desligadoA, viewerA, membroB]) {
    await pool.query("insert into auth.users (id, email) values ($1, $2)", [u, `${u}@invariante.test`]);
  }
  for (const org of [orgA, orgB]) {
    await pool.query(
      "insert into organizations (id, slug, display_name, legal_name) values ($1, $2, 'Liga', 'Liga')",
      [org, `liga-${org.slice(0, 8)}`],
    );
  }
  for (const [org, user, role, revogado] of [
    [orgA, managerA, "manager", false],
    [orgA, agenteA, "agent", false],
    [orgA, desligadoA, "agent", true],
    [orgA, viewerA, "viewer", false],
    [orgB, membroB, "admin", false],
  ] as const) {
    await pool.query(
      `insert into user_organizations (organization_id, user_id, role, accepted_at, revoked_at)
       values ($1, $2, $3, now(), case when $4 then now() else null end)`,
      [org, user, role, revogado],
    );
  }
  await pool.query(
    "insert into contacts (id, organization_id, name) values ($1, $2, 'A'), ($3, $2, 'A2'), ($4, $5, 'B')",
    [contatoA, orgA, contatoA2, contatoB, orgB],
  );
  await pool.query(
    "insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Funil', $3)",
    [funilA, orgA, "funil"],
  );
  await pool.query(
    "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1, $2, $3, 'Novo', 'novo', 1000)",
    [etapaA, orgA, funilA],
  );
  leadA = await novoLead({ contact_id: contatoA, owner_user_id: agenteA });
});

afterAll(() => pool.end());

describe("PATCH direto na tabela, como authenticated (o caminho da REST do banco)", () => {
  it("contato de OUTRA organização: recusado com PT404, e o lead não muda", async () => {
    const erro = await recusa(
      comoUsuario(managerA, "update crm_leads set contact_id = $1 where id = $2", [contatoB, leadA]),
    );
    expect(erro.code).toBe("PT404");
    expect((await lead(leadA)).contact_id).toBe(contatoA);
  });

  it("a recusa não diz se o id existe noutra organização: mesma resposta que um uuid inexistente", async () => {
    const deB = await recusa(
      comoUsuario(managerA, "update crm_leads set contact_id = $1 where id = $2", [contatoB, leadA]),
    );
    const inexistente = await recusa(
      comoUsuario(managerA, "update crm_leads set contact_id = $1 where id = $2", [randomUUID(), leadA]),
    );
    expect([inexistente.code, inexistente.message, inexistente.detail ?? null]).toEqual([
      deB.code,
      deB.message,
      deB.detail ?? null,
    ]);
    expect(deB.message).not.toContain(contatoB);
  });

  it("responsável de OUTRA organização: recusado com PT422", async () => {
    const erro = await recusa(
      comoUsuario(managerA, "update crm_leads set owner_user_id = $1 where id = $2", [membroB, leadA]),
    );
    expect(erro.code).toBe("PT422");
    expect((await lead(leadA)).owner_user_id).toBe(agenteA);
  });

  it("responsável desligado ou viewer da própria organização: recusado com PT422", async () => {
    for (const dono of [desligadoA, viewerA]) {
      const erro = await recusa(
        comoUsuario(managerA, "update crm_leads set owner_user_id = $1 where id = $2", [dono, leadA]),
      );
      expect(erro.code).toBe("PT422");
    }
  });

  it("INSERT direto com contato de B também é recusado", async () => {
    const erro = await recusa(
      comoUsuario(
        managerA,
        "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, 'X', $4)",
        [orgA, funilA, etapaA, contatoB],
      ),
    );
    expect(erro.code).toBe("PT404");
  });

  it("contato e responsável da PRÓPRIA organização: passa", async () => {
    await comoUsuario(managerA, "update crm_leads set contact_id = $1, owner_user_id = $2 where id = $3", [
      contatoA2,
      managerA,
      leadA,
    ]);
    const depois = await lead(leadA);
    expect([depois.contact_id, depois.owner_user_id]).toEqual([contatoA2, managerA]);
  });

  it("reenviar o responsável que o lead JÁ tem, mesmo desligado, não trava a edição", async () => {
    const id = await novoLead({ owner_user_id: agenteA });
    // O vínculo revoga DEPOIS de ele virar dono — o estado de quem saiu da empresa.
    await pool.query(
      "update user_organizations set revoked_at = now() where organization_id = $1 and user_id = $2",
      [orgA, agenteA],
    );
    try {
      await comoUsuario(managerA, "update crm_leads set title = 'Renomeado', owner_user_id = $1 where id = $2", [
        agenteA,
        id,
      ]);
      expect((await lead(id)).title).toBe("Renomeado");
    } finally {
      await pool.query(
        "update user_organizations set revoked_at = null where organization_id = $1 and user_id = $2",
        [orgA, agenteA],
      );
    }
  });
});

describe("RPC fn_nascer_lead_da_conversa, como authenticated", () => {
  const nascer = (contato: string) =>
    comoUsuario(
      managerA,
      "select public.fn_nascer_lead_da_conversa($1, $2, $3, $4, 'Conversa', 'whatsapp') as id",
      [orgA, contato, funilA, etapaA],
    );

  it("contato de OUTRA organização: recusado, e nenhum lead nasce", async () => {
    const erro = await recusa(nascer(contatoB));
    expect(erro.code).toBe("PT404");
    const { rows } = await pool.query("select count(*)::int as n from crm_leads where contact_id = $1", [contatoB]);
    expect(rows[0].n).toBe(0);
  });

  it("contato da própria organização: o lead nasce", async () => {
    const contatoNovo = randomUUID();
    await pool.query("insert into contacts (id, organization_id, name) values ($1, $2, 'Novo')", [contatoNovo, orgA]);
    const { rows } = await nascer(contatoNovo);
    expect(rows[0].id).toEqual(expect.any(String));
  });
});

describe("a cura dos vínculos cruzados que já existem", () => {
  const MIGRATION = join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260924070000_0403_lead_so_liga_a_propria_empresa.sql",
  );
  const cura = () => {
    const texto = readFileSync(MIGRATION, "utf8");
    const inicio = texto.indexOf("-- 1 · cura");
    const fim = texto.indexOf("-- 2 · gatilho");
    if (inicio < 0 || fim < 0) throw new Error("seções da migration 0403 não encontradas");
    return texto.slice(inicio, fim);
  };
  const atividadesDeCura = async (id: string) =>
    (
      await pool.query(
        "select count(*)::int as n from crm_lead_activities where lead_id = $1 and type = 'lead_edited' and actor_kind = 'system'",
        [id],
      )
    ).rows[0].n as number;

  it("anula o contato e o responsável de fora, preserva o desligado, e é idempotente", async () => {
    // Planta o estado que a REST permitia, com o gatilho desligado.
    await pool.query("alter table crm_leads disable trigger trg_lead_so_liga_a_propria_empresa");
    let cruzado: string, desligado: string;
    try {
      cruzado = await novoLead({ contact_id: contatoB, owner_user_id: membroB });
      desligado = await novoLead({ contact_id: contatoA, owner_user_id: desligadoA });
    } finally {
      await pool.query("alter table crm_leads enable trigger trg_lead_so_liga_a_propria_empresa");
    }

    await pool.query(cura());

    expect(await lead(cruzado)).toMatchObject({ contact_id: null, owner_user_id: null, owner_kind: null });
    expect(await atividadesDeCura(cruzado)).toBe(2);
    // O desligado ERA da empresa: o lead era dele, e isso não é vínculo cruzado.
    expect(await lead(desligado)).toMatchObject({ contact_id: contatoA, owner_user_id: desligadoA });
    expect(await atividadesDeCura(desligado)).toBe(0);

    await pool.query(cura());
    expect(await atividadesDeCura(cruzado)).toBe(2);
  });
});
