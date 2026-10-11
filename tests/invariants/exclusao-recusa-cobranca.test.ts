import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Exclusão de tenant e suspensão por cobrança (migration 0614).
 *
 * EXCLUIR NÃO APAGA QUEM DEVE. Uma organização suspensa por COBRANÇA não se
 * exclui: a assinatura continuaria cobrando no provedor e ninguém mais teria
 * onde resolver. A rota confere o tipo antes de tocar em nada, e a função
 * confere de novo dentro da transação — `fn_suspender_organizacao` pode trocar
 * o tipo entre a leitura da rota e a exclusão. Este arquivo prova a segunda.
 *
 * O AVISO DE TROCA DE E-MAIL CABE NA CENTRAL. A rota de troca do e-mail de
 * login grava `email_de_login_trocado` em `agent_inbox_items`; sem o kind no
 * CHECK, a troca falharia fechada em toda instalação.
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

const ORG_COBRANCA = "7e0b0000-0000-4000-8000-0000000000c0";
const ORG_AVISO = "7e0b0000-0000-4000-8000-0000000000a0";
const ATOR = "7e0b1111-0000-4000-8000-0000000000ff";
const SLUG = "exclusao-recusa-cobranca";
const MOTIVO = "motivo suficientemente longo";

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_COBRANCA, SLUG],
    [ORG_AVISO, "exclusao-recusa-cobranca-aviso"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, $3, $3) on conflict (id) do nothing`,
      [id, slug, `Exclusão ${slug}`],
    );
  }
  // Como o service role prepara: o gatilho da 0501 só barra authenticated/anon.
  await pool.query(
    `update organizations set status = 'suspended', suspended_kind = 'cobranca',
            suspended_at = now(), suspended_reason = 'cobrança em aberto'
      where id = $1`,
    [ORG_COBRANCA],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_COBRANCA, ORG_AVISO]]);
  await pool.query("delete from api_audit_log where resource_id = $1", [ORG_COBRANCA]);
  await pool.end();
});

describe("fn_excluir_organizacao recusa suspensão por cobrança", () => {
  it("controle: a organização está suspensa por cobrança", async () => {
    const { rows } = await pool.query<{ status: string; suspended_kind: string }>(
      "select status, suspended_kind from organizations where id = $1",
      [ORG_COBRANCA],
    );
    expect(rows[0]).toEqual({ status: "suspended", suspended_kind: "cobranca" });
  });

  it("PT409 organizacao_com_cobranca_pendente, e a organização continua lá", async () => {
    let erro: { code?: string; message?: string } | null = null;
    try {
      await pool.query("select public.fn_excluir_organizacao($1, $2, $3, $4)", [
        ORG_COBRANCA,
        ATOR,
        SLUG,
        MOTIVO,
      ]);
    } catch (e) {
      erro = e as { code?: string; message?: string };
    }
    expect(erro?.code).toBe("PT409");
    expect(erro?.message).toBe("organizacao_com_cobranca_pendente");

    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from organizations where id = $1",
      [ORG_COBRANCA],
    );
    expect(Number(rows[0]!.n)).toBe(1);
    const lapide = await pool.query(
      "select 1 from api_audit_log where action = 'organization.deleted' and resource_id = $1",
      [ORG_COBRANCA],
    );
    expect(lapide.rowCount).toBe(0);
  });
});

describe("agent_inbox_items aceita email_de_login_trocado", () => {
  it("o insert que a rota de troca de e-mail faz passa pelo CHECK", async () => {
    const { rows } = await pool.query<{ kind: string }>(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body)
       values ($1, 'email_de_login_trocado', 'warn',
               'E-mail de login trocado pelo administrador da plataforma',
               'O e-mail de login de uma pessoa da equipe foi trocado.')
       returning kind`,
      [ORG_AVISO],
    );
    expect(rows[0]!.kind).toBe("email_de_login_trocado");
  });

  it("controle: um kind fora do vocabulário continua recusado", async () => {
    await expect(
      pool.query(
        `insert into agent_inbox_items (organization_id, kind, title) values ($1, 'kind_inexistente', 't')`,
        [ORG_AVISO],
      ),
    ).rejects.toThrow(/agent_inbox_items_kind_check/);
  });
});

/**
 * A COBRANÇA NÃO SE APAGA TROCANDO O RÓTULO. `fn_suspender_organizacao`, numa
 * org já suspensa por cobrança, aceita a administrativa e TROCA o tipo ("a
 * administrativa prevalece", mantendo o início da suspensão). Olhando só o
 * tipo, duas chamadas (/suspend e /delete) apagavam a empresa com a assinatura
 * cobrando. A exclusão confere o `tenant.suspended` de tipo cobrança desde o
 * início da suspensão atual — e uma suspensão nova, depois de reativar, não
 * herda a de antes.
 */
describe("fn_excluir_organizacao: a suspensão administrativa por cima da cobrança não libera", () => {
  const ORG_TROCA = "7e0b0000-0000-4000-8000-0000000000c1";
  const ORG_NOVO_EPISODIO = "7e0b0000-0000-4000-8000-0000000000c2";
  // A lápide referencia o ator (FK para auth.users): aqui ele existe.
  const ATOR_REAL = "7e0b1111-0000-4000-8000-0000000000fe";
  const PLANO_TROCA = "7e0b0000-0000-4000-8000-0000000000c9";
  const suspender = (org: string, kind: string) =>
    pool.query("select public.fn_suspender_organizacao($1, $2, 'motivo do teste', null) as r", [org, kind]);

  beforeAll(async () => {
    await pool.query(
      `insert into auth.users (id, email) values ($1, 'exclusao-troca@invariant.test') on conflict (id) do nothing`,
      [ATOR_REAL],
    );
    for (const [id, slug] of [
      [ORG_TROCA, "exclusao-troca-de-rotulo"],
      [ORG_NOVO_EPISODIO, "exclusao-novo-episodio"],
    ] as const) {
      await pool.query(
        `insert into organizations (id, slug, legal_name, display_name)
         values ($1, $2, $3, $3) on conflict (id) do nothing`,
        [id, slug, `Exclusão ${slug}`],
      );
    }
    // Desde a 0583, org SEM assinatura é isenta: `fn_suspender_organizacao`
    // devolve `org_isenta` e não suspende por cobrança. A assinatura vem SEM
    // provedor, para o gatilho da 0601 (assinatura viva) não responder por esta
    // recusa: aqui quem precisa recusar é o `tenant.suspended` de cobrança.
    await pool.query(
      `insert into cobranca_planos (id, nome, preco_cents, intervalo)
       values ($1, 'Plano da troca de rótulo', 9900, 'mes') on conflict (id) do nothing`,
      [PLANO_TROCA],
    );
    for (const id of [ORG_TROCA, ORG_NOVO_EPISODIO]) {
      await pool.query(
        `insert into cobranca_assinaturas (organization_id, plano_id, estado)
         values ($1, $2, 'em_atraso') on conflict (organization_id) do nothing`,
        [id, PLANO_TROCA],
      );
    }
  });

  afterAll(async () => {
    await pool.query("delete from cobranca_assinaturas where organization_id = any($1)", [[ORG_TROCA, ORG_NOVO_EPISODIO]]);
    await pool.query("delete from organizations where id = any($1)", [[ORG_TROCA, ORG_NOVO_EPISODIO]]);
    await pool.query("delete from cobranca_planos where id = $1", [PLANO_TROCA]);
    await pool.query("delete from api_audit_log where resource_id = any($1)", [[ORG_TROCA, ORG_NOVO_EPISODIO]]);
    await pool.query("delete from auth.users where id = $1", [ATOR_REAL]);
  });

  it("cobrança → /suspend administrativa troca o tipo, e a exclusão continua recusada (PT409)", async () => {
    const porCobranca = await suspender(ORG_TROCA, "cobranca");
    // Controle: a suspensão por cobrança aconteceu de fato (sem assinatura ela
    // seria `org_isenta`, e o caso passaria a medir uma org nunca cobrada).
    expect(porCobranca.rows[0]!.r).toMatchObject({ changed: true });
    const troca = await suspender(ORG_TROCA, "administrativa");
    expect(troca.rows[0]!.r).toMatchObject({ changed: true });
    const { rows } = await pool.query<{ suspended_kind: string }>(
      "select suspended_kind from organizations where id = $1",
      [ORG_TROCA],
    );
    // Controle: o rótulo, sozinho, já não diz cobrança.
    expect(rows[0]!.suspended_kind).toBe("administrativa");

    await expect(
      pool.query("select public.fn_excluir_organizacao($1, $2, $3, $4)", [
        ORG_TROCA,
        ATOR_REAL,
        "exclusao-troca-de-rotulo",
        MOTIVO,
      ]),
    ).rejects.toMatchObject({ code: "PT409", message: "organizacao_com_cobranca_pendente" });
    const { rows: ainda } = await pool.query("select 1 from organizations where id = $1", [ORG_TROCA]);
    expect(ainda).toHaveLength(1);
  });

  it("controle: cobrança resolvida (reativada) e suspensão administrativa NOVA — a exclusão segue", async () => {
    expect((await suspender(ORG_NOVO_EPISODIO, "cobranca")).rows[0]!.r).toMatchObject({ changed: true });
    await pool.query("select public.fn_reativar_organizacao($1, 'cobranca', null)", [ORG_NOVO_EPISODIO]);
    await suspender(ORG_NOVO_EPISODIO, "administrativa");
    const { rows } = await pool.query<{ r: { slug: string } }>(
      "select public.fn_excluir_organizacao($1, $2, $3, $4) as r",
      [ORG_NOVO_EPISODIO, ATOR_REAL, "exclusao-novo-episodio", MOTIVO],
    );
    expect(rows[0]!.r.slug).toBe("exclusao-novo-episodio");
  });
});

/**
 * A ASSINATURA VIVA BARRA A EXCLUSÃO DO PAINEL, E A LÁPIDE SAI JUNTO. A
 * suspensão administrativa passa pelas recusas da própria função, mas o
 * gatilho da migration 0601 (`organizacao_com_assinatura_viva`) recusa o
 * `delete from organizations` dentro da MESMA transação: a lápide
 * `organization.deleted`, gravada antes, é desfeita com o resto. A aplicação
 * traduz esse PT409 com código próprio (`exclusao_com_assinatura_viva`).
 */
describe("fn_excluir_organizacao: empresa suspensa pelo administrador com assinatura viva", () => {
  const ORG_VIVA = "7e0b0000-0000-4000-8000-0000000000d0";
  const PLANO = "7e0b0000-0000-4000-8000-0000000000d1";
  const ATOR_REAL = "7e0b1111-0000-4000-8000-0000000000fd";
  const SLUG_VIVA = "exclusao-assinatura-viva";

  beforeAll(async () => {
    await pool.query(
      `insert into auth.users (id, email) values ($1, 'exclusao-viva@invariant.test') on conflict (id) do nothing`,
      [ATOR_REAL],
    );
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Exclusão viva', 'Exclusão viva') on conflict (id) do nothing`,
      [ORG_VIVA, SLUG_VIVA],
    );
    await pool.query(
      `update organizations set status = 'suspended', suspended_kind = 'administrativa',
              suspended_at = now(), suspended_reason = 'contrato encerrado'
        where id = $1`,
      [ORG_VIVA],
    );
    await pool.query(
      `insert into cobranca_planos (id, nome, preco_cents, intervalo)
       values ($1, 'Plano da exclusão', 9900, 'mes') on conflict (id) do nothing`,
      [PLANO],
    );
    await pool.query(
      `insert into cobranca_assinaturas
         (organization_id, plano_id, estado, provedor, provedor_cliente_id, modo, assinaturas_vivas, cancela_no_fim)
       values ($1, $2, 'ativa', 'stripe', 'cus_exclusao_viva', 'teste', 1, false)
       on conflict (organization_id) do nothing`,
      [ORG_VIVA, PLANO],
    );
  });

  afterAll(async () => {
    await pool.query("delete from cobranca_assinaturas where organization_id = $1", [ORG_VIVA]);
    await pool.query("delete from organizations where id = $1", [ORG_VIVA]);
    await pool.query("delete from cobranca_planos where id = $1", [PLANO]);
    await pool.query("delete from api_audit_log where resource_id = $1", [ORG_VIVA]);
    await pool.query("delete from auth.users where id = $1", [ATOR_REAL]);
  });

  it("PT409 organizacao_com_assinatura_viva, a empresa fica e a lápide é desfeita", async () => {
    await expect(
      pool.query("select public.fn_excluir_organizacao($1, $2, $3, $4)", [ORG_VIVA, ATOR_REAL, SLUG_VIVA, MOTIVO]),
    ).rejects.toMatchObject({ code: "PT409", message: "organizacao_com_assinatura_viva" });
    const { rows } = await pool.query("select 1 from organizations where id = $1", [ORG_VIVA]);
    expect(rows).toHaveLength(1);
    const lapide = await pool.query(
      "select 1 from api_audit_log where action = 'organization.deleted' and resource_id = $1",
      [ORG_VIVA],
    );
    expect(lapide.rowCount).toBe(0);
  });
});
