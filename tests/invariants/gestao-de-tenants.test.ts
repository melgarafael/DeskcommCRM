import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Gestão de tenants pelo admin da plataforma (migration 0492).
 *
 * Duas promessas que só o Postgres consegue provar, porque moram em função
 * SECURITY DEFINER, policy e cascata de FK:
 *
 * 1. SUSPENDER CORTA. `fn_user_org_ids()` e `fn_user_role_in_org()` deixam de
 *    devolver a organização suspensa. Até a 0492 elas ignoravam
 *    `organizations.status`, e o JWT do membro seguia lendo tudo pelo PostgREST
 *    (auditoria de 28/09/2026, P3). Reativar devolve o acesso.
 * 2. EXCLUIR É COMPLETO. `fn_excluir_organizacao` apaga a organização inteira
 *    numa transação, inclusive o caso que derrubava um `delete` avulso (lead com
 *    dono IA → `event_log` apontando para a org já apagada), guarda a lápide na
 *    auditoria e diz quais logins ficaram sem organização.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG_A = "7e0a0000-0000-4000-8000-00000000000a";
const ORG_B = "7e0a0000-0000-4000-8000-00000000000b";
const ORG_X = "7e0a0000-0000-4000-8000-0000000000ee"; // a que será excluída
const USER_A = "7e0a1111-0000-4000-8000-00000000000a";
const USER_SO_X = "7e0a1111-0000-4000-8000-0000000000e1"; // só pertence à X
const USER_X_E_B = "7e0a1111-0000-4000-8000-0000000000e2"; // X e B
const ADMIN_PLAT = "7e0a1111-0000-4000-8000-0000000000ff";
const SESS_X = "7e0a2222-0000-4000-8000-0000000000ee";

async function criarUsuario(id: string, tag: string): Promise<void> {
  await pool.query(
    `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
    [id, `gestao-tenants-${tag}@invariant.test`],
  );
}

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, $3, $3) on conflict (id) do nothing`,
    [id, slug, `Gestao ${slug}`],
  );
}

async function vincular(user: string, org: string, role = "admin"): Promise<void> {
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $2, $3, now()) on conflict do nothing`,
    [user, org, role],
  );
}

/** Roda `query` como o PostgREST roda: papel `authenticated` + claims do JWT. */
async function comoUsuario<T extends pg.QueryResultRow>(
  userId: string,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const { rows } = await client.query<T>(query, params);
    return rows;
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function status(org: string, s: "active" | "suspended"): Promise<void> {
  await pool.query("update organizations set status = $2 where id = $1", [org, s]);
}

beforeAll(async () => {
  for (const [id, tag] of [
    [USER_A, "a"],
    [USER_SO_X, "so-x"],
    [USER_X_E_B, "x-e-b"],
    [ADMIN_PLAT, "plataforma"],
  ] as const) {
    await criarUsuario(id, tag);
  }
  await criarOrg(ORG_A, "gestao-tenants-a");
  await criarOrg(ORG_B, "gestao-tenants-b");
  await vincular(USER_A, ORG_A);
  await pool.query(
    `insert into contacts (organization_id, display_name) values ($1, 'Contato da A')`,
    [ORG_A],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B, ORG_X]]);
  await pool.query("delete from api_audit_log where resource_id = $1", [ORG_X]);
  // `platform_admins.granted_by` é RESTRICT, e o fixture concede a si mesmo.
  await pool.query("delete from platform_admins where user_id = $1", [ADMIN_PLAT]);
  await pool.query("delete from auth.users where id = any($1)", [
    [USER_A, USER_SO_X, USER_X_E_B, ADMIN_PLAT],
  ]);
  await pool.end();
});

describe("suspender corta o acesso pela RLS", () => {
  it("controle: a organização ATIVA é alcançável pelo membro", async () => {
    await status(ORG_A, "active");
    const ids = await comoUsuario<{ id: string }>(USER_A, "select public.fn_user_org_ids() as id");
    expect(ids.map((r) => r.id)).toContain(ORG_A);
    const contatos = await comoUsuario<{ n: string }>(
      USER_A,
      "select count(*) as n from contacts where organization_id = $1",
      [ORG_A],
    );
    expect(Number(contatos[0]!.n)).toBeGreaterThan(0);
  });

  it("suspensa: some de fn_user_org_ids, o papel vira nulo e as linhas ficam invisíveis", async () => {
    await status(ORG_A, "suspended");
    const ids = await comoUsuario<{ id: string }>(USER_A, "select public.fn_user_org_ids() as id");
    expect(ids.map((r) => r.id)).not.toContain(ORG_A);

    const papel = await comoUsuario<{ r: string | null }>(
      USER_A,
      "select public.fn_user_role_in_org($1) as r",
      [ORG_A],
    );
    expect(papel[0]!.r).toBeNull();

    const contatos = await comoUsuario<{ n: string }>(
      USER_A,
      "select count(*) as n from contacts where organization_id = $1",
      [ORG_A],
    );
    expect(Number(contatos[0]!.n)).toBe(0);

    // Escrita também: a policy de INSERT usa o mesmo helper.
    await expect(
      comoUsuario(USER_A, "insert into contacts (organization_id, display_name) values ($1, 'x')", [
        ORG_A,
      ]),
    ).rejects.toThrow(/row-level security/i);
  });

  it("o vínculo continua legível pelo próprio usuário — a aplicação sabe mostrar a tela de suspensão", async () => {
    await status(ORG_A, "suspended");
    const vinculos = await comoUsuario<{ organization_id: string }>(
      USER_A,
      "select organization_id from user_organizations where user_id = $1",
      [USER_A],
    );
    expect(vinculos.map((v) => v.organization_id)).toContain(ORG_A);
  });

  it("reativar devolve o acesso", async () => {
    await status(ORG_A, "active");
    const papel = await comoUsuario<{ r: string | null }>(
      USER_A,
      "select public.fn_user_role_in_org($1) as r",
      [ORG_A],
    );
    expect(papel[0]!.r).toBe("admin");
  });
});

describe("fn_excluir_organizacao", () => {
  beforeAll(async () => {
    await criarOrg(ORG_X, "gestao-tenants-x");
    await vincular(USER_SO_X, ORG_X);
    await vincular(USER_X_E_B, ORG_X, "agent");
    await vincular(USER_X_E_B, ORG_B, "agent");
    await criarUsuario(ADMIN_PLAT, "plataforma");
    await pool.query(
      `insert into platform_admins (user_id, granted_by, scope, reason)
       values ($1, $1, 'full', 'invariante de gestão de tenants')
       on conflict (user_id) do nothing`,
      [ADMIN_PLAT],
    );
    await vincular(ADMIN_PLAT, ORG_X, "admin");

    // O tenant com o que um tenant real tem — e com o caso R1: lead cujo dono
    // é um agente de IA, que fazia o `delete` avulso abortar.
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
       values ($1, $2, 'gestao-tenants-x', '\\x00'::bytea) on conflict (id) do nothing`,
      [SESS_X, ORG_X],
    );
    await pool.query(
      `do $seed$
       declare v_contact uuid; v_conv uuid; v_agent uuid; v_pipe uuid; v_stage uuid;
       begin
         insert into contacts (organization_id, display_name) values ('${ORG_X}', 'Contato X')
           returning id into v_contact;
         insert into conversations (organization_id, contact_id, channel_session_id)
           values ('${ORG_X}', v_contact, '${SESS_X}') returning id into v_conv;
         insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
           values ('${ORG_X}', v_conv, '${SESS_X}', v_contact, 'text', 'inbound', 'oi');
         insert into ai_agents (organization_id, name, kind, system_prompt, model)
           values ('${ORG_X}', 'Agente X', 'mcp_agent', 'oi', 'claude-sonnet-4-6') returning id into v_agent;
         select id into v_pipe from crm_pipelines where organization_id = '${ORG_X}' limit 1;
         select id into v_stage from crm_stages where pipeline_id = v_pipe order by position limit 1;
         insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id, owner_kind, owner_agent_id)
           values ('${ORG_X}', v_pipe, v_stage, 'Lead da IA', v_contact, 'ai', v_agent);
         insert into lgpd_requests (organization_id, request_type, source, due_at)
           values ('${ORG_X}', 'data_request', 'manual', now() + interval '7 days');
       end $seed$`,
    );
    await pool.query(
      `insert into webhook_events_log (organization_id, channel_session_id, raw_body)
       values ($1, $2, '{"telefone":"5511999999999"}')`,
      [ORG_X, SESS_X],
    );
  });

  it("controle: o cenário tem lead com dono IA e webhook sem FK — sem isso o caso não mede nada", async () => {
    const { rows } = await pool.query<{ leads_ia: string; webhooks: string }>(
      `select (select count(*) from crm_leads where organization_id = $1 and owner_kind = 'ai') as leads_ia,
              (select count(*) from webhook_events_log where organization_id = $1) as webhooks`,
      [ORG_X],
    );
    expect(Number(rows[0]!.leads_ia)).toBe(1);
    expect(Number(rows[0]!.webhooks)).toBe(1);
  });

  it("não é executável por usuário logado (nem pelo admin da plataforma)", async () => {
    await expect(
      comoUsuario(ADMIN_PLAT, "select public.fn_excluir_organizacao($1, $2, $3, $4)", [
        ORG_X,
        ADMIN_PLAT,
        "gestao-tenants-x",
        "motivo suficientemente longo",
      ]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("recusa organização ATIVA — exclusão exige suspensão antes", async () => {
    await status(ORG_X, "active");
    await expect(
      pool.query("select public.fn_excluir_organizacao($1, $2, $3, $4)", [
        ORG_X,
        ADMIN_PLAT,
        "gestao-tenants-x",
        "motivo suficientemente longo",
      ]),
    ).rejects.toThrow(/organizacao_nao_suspensa/);
  });

  it("recusa confirmação que não é o slug", async () => {
    await status(ORG_X, "suspended");
    await expect(
      pool.query("select public.fn_excluir_organizacao($1, $2, $3, $4)", [
        ORG_X,
        ADMIN_PLAT,
        "outro-slug",
        "motivo suficientemente longo",
      ]),
    ).rejects.toThrow(/organizacao_confirmacao_divergente/);
  });

  it("apaga tudo, guarda a lápide e aponta só os logins que ficaram sem organização", async () => {
    await status(ORG_X, "suspended");
    const { rows } = await pool.query<{ r: Record<string, unknown> }>(
      "select public.fn_excluir_organizacao($1, $2, $3, $4, 'req-invariante') as r",
      [ORG_X, ADMIN_PLAT, "gestao-tenants-x", "encerramento de contrato — invariante"],
    );
    const r = rows[0]!.r as { usuarios_removiveis: string[]; membros: string[] };

    // Só quem pertencia APENAS à X, e não é admin da plataforma.
    expect(r.usuarios_removiveis).toEqual([USER_SO_X]);
    expect(new Set(r.membros)).toEqual(new Set([USER_SO_X, USER_X_E_B, ADMIN_PLAT]));

    const sobra = await pool.query<{ org: string; webhooks: string; b: string }>(
      `select (select count(*) from organizations where id = $1) as org,
              (select count(*) from webhook_events_log where organization_id = $1) as webhooks,
              (select count(*) from user_organizations where user_id = $2 and organization_id = $3) as b`,
      [ORG_X, USER_X_E_B, ORG_B],
    );
    expect(sobra.rows[0]!.org).toBe("0");
    expect(sobra.rows[0]!.webhooks).toBe("0");
    // A outra organização de quem estava nas duas fica intacta.
    expect(sobra.rows[0]!.b).toBe("1");

    const lapide = await pool.query<{
      organization_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `select organization_id, metadata from api_audit_log
        where action = 'organization.deleted' and resource_id = $1`,
      [ORG_X],
    );
    expect(lapide.rows).toHaveLength(1);
    expect(lapide.rows[0]!.organization_id).toBeNull();
    expect(lapide.rows[0]!.metadata.slug).toBe("gestao-tenants-x");
    // A prova de atendimento LGPD, que o cascade apagou, fica na lápide.
    expect(lapide.rows[0]!.metadata.lgpd_requests as unknown[]).toHaveLength(1);
  });

  it("organização inexistente é recusada com PT404", async () => {
    await expect(
      pool.query("select public.fn_excluir_organizacao($1, $2, $3, $4)", [
        ORG_X,
        ADMIN_PLAT,
        "gestao-tenants-x",
        "motivo suficientemente longo",
      ]),
    ).rejects.toMatchObject({ code: "PT404" });
  });
});

describe("fn_arquivos_da_organizacao", () => {
  it("é só do servidor", async () => {
    await expect(
      comoUsuario(USER_A, "select * from public.fn_arquivos_da_organizacao($1)", [ORG_A]),
    ).rejects.toThrow(/permission denied/i);
  });
});
