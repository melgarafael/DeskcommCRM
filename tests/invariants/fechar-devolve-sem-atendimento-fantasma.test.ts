/**
 * FECHAR COM "DEVOLVER AO AUTOMÁTICO" NÃO PODE CRIAR ATENDIMENTO FANTASMA.
 *
 * ─── O defeito, medido pelo mantenedor no CR do #3323 ───────────────────────
 *
 * A primeira versão da rota fechava a conversa e devolvia em seguida. Numa
 * conversa COM DONO HUMANO (`assigned_to_user_id` preenchido), o release de
 * `fn_conversation_assign` grava `status='open'` — e gravar `open` numa conversa
 * que acabou de virar `closed` é REABERTURA para `fn_service_stamp_status`. No
 * banco isso aparece como:
 *
 *     fechada:      status=closed  service_revision=2  service_started_at=null
 *     após release: status=open    service_revision=3  service_started_at=<agora>
 *                   eventos=[conversation.routing_requested]
 *     fim:          status=closed  service_revision=4  service_closed_at regravado
 *
 * ou seja: um atendimento fantasma (revisão +2 e início do atendimento
 * regravado), um pedido de roteamento para uma conversa encerrada, e o
 * `current_demanda_id` anulado pela reabertura e não devolvido pelo UPDATE
 * final. O `tests/unit/escalacao-retomada.test.ts` não vê nada disso porque a
 * conversa dele tem `assigned_to_user_id` NULO — o caso em que o release não
 * roda.
 *
 * ─── Por que um invariante de BANCO, e não mais um unitário ─────────────────
 *
 * Quem reabre a conversa são os GATILHOS (`trg_service_stamp_status`), e o
 * dublê não tem gatilho. Aqui o `POST` de verdade — a rota inteira, com
 * `devolverAtendimentoAoAgente` e as funções do `baseline.sql` — roda contra o
 * Postgres do harness. O que é dublê é só o TRANSPORTE: o client do Supabase,
 * que vira um tradutor para SQL (mesma ideia de
 * `webhooks-trigger-events.test.ts`), e as três guardas de sessão (suporte,
 * papel e usuário), que exigiriam cookie e JWT. Nenhuma regra de negócio é
 * substituída. O client fala como superusuário — RLS fora do caminho, que é o
 * certo para um invariante sobre ATENDIMENTO, não sobre visibilidade.
 *
 * ─── SABOTAGEM que este arquivo tem de saber pegar ──────────────────────────
 *
 * `git checkout HEAD~1 -- app/api/v1/conversations/[id]/close/route.ts` (a
 * ordem antiga: fechar primeiro, devolver depois) tem de deixar VERMELHOS os
 * quatro casos que medem a ordem — a revisão (+1 vira +3), o
 * `service_started_at`, o `current_demanda_id` e o log de transições (a
 * conversa volta a `open` depois de fechada). Os dois casos de guarda (a
 * devolução acontece e fecha; e a escolha "Manter com a equipe") seguem verdes,
 * porque nenhum dos dois depende da ordem.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => null,
  readSupportContext: async () => null,
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: atendenteDaVez(), idioma: "pt-BR" },
    org: { orgId: organizacaoDaVez(), role: "agent" },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteDoSgbd() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteDoSgbd() }));

import { POST } from "@/app/api/v1/conversations/[id]/close/route";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
// O `pg` devolve `bigint` (OID 20) como STRING e o PostgREST o devolve como
// NÚMERO — a diferença não é cosmética aqui: a rota compara a revisão lida com
// a que o cliente mandou (`expected_revision`). Sem isto o dublê inventaria uma
// quarta linha de defeito que o produto não tem.
pg.types.setTypeParser(20, (valor) => (valor === null ? null : Number(valor)));
afterAll(() => pool.end());

/** A org e o atendente da vez — o `requireRole` dublado lê daqui. */
let orgAtual = "";
let atendenteAtual = "";
const organizacaoDaVez = () => orgAtual;
const atendenteDaVez = () => atendenteAtual;

type Resposta<T = unknown> = { data: T | null; error: { message: string; code?: string } | null };

/** O erro do `pg` já traz o SQLSTATE em `.code` — é ele que a rota lê como 409. */
function erroDoBanco(err: unknown): { message: string; code?: string } {
  const e = err as { message?: string; code?: string };
  return { message: e?.message ?? "erro no banco", ...(e?.code ? { code: e.code } : {}) };
}

/**
 * O mínimo do `PostgrestQueryBuilder` que este caminho usa, preso ao pool do
 * harness: select/insert/update com eq/is/in/order/limit, `maybeSingle()` e a
 * forma thenável (`await client.from(...).update(...).eq(...)`).
 */
class Consulta {
  private modo: "select" | "update" | "insert" = "select";
  private colunas = "*";
  private retorno = "*";
  private dados: Record<string, unknown> | null = null;
  private filtros: string[] = [];
  private params: unknown[] = [];
  private ordenacao = "";
  private teto = "";

  constructor(private readonly tabela: string) {}

  select(colunas = "*"): this {
    if (this.modo === "select") this.colunas = colunas;
    else this.retorno = colunas;
    return this;
  }

  insert(dados: Record<string, unknown>): this {
    this.modo = "insert";
    this.dados = dados;
    return this;
  }

  update(dados: Record<string, unknown>): this {
    this.modo = "update";
    this.dados = dados;
    return this;
  }

  eq(coluna: string, valor: unknown): this {
    this.filtros.push(`${coluna} = $${this.params.length + 1}`);
    this.params.push(valor);
    return this;
  }

  is(coluna: string, valor: null): this {
    this.filtros.push(valor === null ? `${coluna} is null` : `${coluna} is not null`);
    return this;
  }

  in(coluna: string, valores: unknown[]): this {
    this.filtros.push(`${coluna} = any($${this.params.length + 1})`);
    this.params.push(valores);
    return this;
  }

  order(coluna: string, opcoes?: { ascending?: boolean }): this {
    this.ordenacao = ` order by ${coluna}${opcoes?.ascending === false ? " desc" : ""}`;
    return this;
  }

  limit(n: number): this {
    this.teto = ` limit ${n}`;
    return this;
  }

  private where(): string {
    return this.filtros.length ? ` where ${this.filtros.join(" and ")}` : "";
  }

  private async executar(): Promise<Resposta<unknown>> {
    try {
      if (this.modo === "select") {
        const r = await pool.query(
          `select ${this.colunas} from public.${this.tabela}${this.where()}${this.ordenacao}${this.teto}`,
          this.params,
        );
        return { data: r.rows, error: null };
      }
      if (this.modo === "update") {
        const colunas = Object.keys(this.dados!);
        const sets = colunas.map((c, i) => `${c} = $${this.params.length + i + 1}`).join(", ");
        const r = await pool.query(
          `update public.${this.tabela} set ${sets}${this.where()} returning ${this.retorno}`,
          [...this.params, ...colunas.map((c) => this.dados![c])],
        );
        return { data: r.rows, error: null };
      }
      const colunas = Object.keys(this.dados!);
      const marca = colunas.map((_, i) => `$${i + 1}`).join(", ");
      const r = await pool.query(
        `insert into public.${this.tabela} (${colunas.join(", ")}) values (${marca})`,
        colunas.map((c) => this.dados![c]),
      );
      return { data: r.rows, error: null };
    } catch (err) {
      return { data: null, error: erroDoBanco(err) };
    }
  }

  async maybeSingle(): Promise<Resposta<unknown>> {
    const r = await this.executar();
    if (r.error) return r;
    const linhas = (r.data ?? []) as unknown[];
    return { data: linhas[0] ?? null, error: null };
  }

  async single(): Promise<Resposta<unknown>> {
    return this.maybeSingle();
  }

  then<R1 = Resposta<unknown>, R2 = never>(
    ok?: ((v: Resposta<unknown>) => R1 | PromiseLike<R1>) | null,
    falha?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.executar().then(ok, falha);
  }
}

/** As quatro RPCs que este caminho usa — nada além delas deve ser chamado. */
async function rpcDoSgbd(
  nome: string,
  params: Record<string, unknown>,
): Promise<Resposta<unknown>> {
  const rodar = async (sql: string, valores: unknown[]): Promise<Resposta<unknown[]>> => {
    try {
      const r = await pool.query(sql, valores);
      return { data: r.rows, error: null };
    } catch (err) {
      return { data: null, error: erroDoBanco(err) };
    }
  };
  switch (nome) {
    case "fn_service_status": {
      const r = await rodar(
        "select * from public.fn_service_status($1::uuid, $2::uuid, $3::text, $4::bigint)",
        [params.p_org, params.p_conversation, params.p_status, params.p_expected],
      );
      return r.error ? r : { data: r.data?.[0] ?? null, error: null };
    }
    case "fn_conversation_assign":
      return rodar(
        "select * from public.fn_conversation_assign($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::boolean)",
        [
          params.p_organization_id,
          params.p_conversation_id,
          params.p_to_user_id,
          params.p_reason,
          params.p_expected_assignee,
          params.p_enforce_expected,
        ],
      );
    case "fn_passagem_devolvida":
      return rodar("select public.fn_passagem_devolvida($1::uuid, $2::uuid)", [
        params.p_organization_id,
        params.p_conversation_id,
      ]);
    case "emit_event":
      return rodar(
        "select public.emit_event($1::text, $2::text, $3::uuid, $4::jsonb, $5::jsonb, $6::uuid)",
        [
          params.p_event_type,
          params.p_entity_kind,
          params.p_entity_id,
          JSON.stringify(params.p_payload ?? {}),
          JSON.stringify(params.p_metadata ?? {}),
          params.p_organization_id,
        ],
      );
    default:
      return { data: null, error: { message: `dublê: rpc não dublada ${nome}` } };
  }
}

function clienteDoSgbd(): unknown {
  return {
    from: (tabela: string) => new Consulta(tabela),
    rpc: (nome: string, params: Record<string, unknown>) => rpcDoSgbd(nome, params),
    // `audit()` lê a sessão para saber se há acompanhamento de suporte: sem
    // usuário lido, nenhum metadata de suporte é anexado (é o caminho de sempre
    // para um ator que não é sessão de cookie).
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
}

interface Fixture {
  org: string;
  atendente: string;
  contato: string;
  conversa: string;
  demanda: string;
  /** Revisão do atendimento em curso, lida do banco antes do POST. */
  revisao: number;
  /** Início do atendimento em curso: 10 minutos atrás, para "não mudou" doer. */
  iniciadoEm: Date;
}

let migalhasCriadas = false;

beforeAll(async () => {
  if (migalhasCriadas) return;
  migalhasCriadas = true;
  // O LOG DE TRANSIÇÕES: a afirmação "nunca volta a `open` depois de fechada" só
  // é verificável se alguém contar as transições. O gatilho é só observação —
  // grava o status novo a cada mudança de status em QUALQUER conversa, e cada
  // caso lê o rastro da SUA conversa.
  await pool.query(`
    create table if not exists test_db.fechar_devolve_transicoes (
      id bigserial primary key,
      conversation_id uuid not null,
      status text not null,
      registrado_em timestamptz not null default clock_timestamp()
    );
    create or replace function test_db.fechar_devolve_loga_transicao()
    returns trigger language plpgsql as $fn$
    begin
      if new.status is distinct from old.status then
        insert into test_db.fechar_devolve_transicoes (conversation_id, status)
          values (new.id, new.status);
      end if;
      return null;
    end;
    $fn$;
    drop trigger if exists trg_fechar_devolve_loga_transicao on public.conversations;
    create trigger trg_fechar_devolve_loga_transicao
      after update of status on public.conversations
      for each row execute function test_db.fechar_devolve_loga_transicao();
  `);
});

/**
 * Conversa COM DONO HUMANO e atendimento em curso: contato travado por humano
 * (`force_human`), dono assumido pela MESMA função da tela (`claim`), uma
 * demanda viva em `current_demanda_id`, `service_started_at` de 10 minutos
 * atrás e revisão já carimbada. O rastro de transições da conversa é apagado no
 * fim, para o log começar no POST.
 */
async function fixture(): Promise<Fixture> {
  const org = randomUUID();
  const atendente = randomUUID();
  const contato = randomUUID();
  const sessao = randomUUID();
  const conversa = randomUUID();
  const demanda = randomUUID();
  orgAtual = org;
  atendenteAtual = atendente;

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
      values ($1, $2, 'Fechar Devolve', 'Fechar Devolve')`,
    [org, `fechar-devolve-${org.slice(0, 8)}`],
  );
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [
    atendente,
    `atendente-${atendente}@invariant.test`,
  ]);
  await pool.query(
    `insert into user_organizations (organization_id, user_id, role, accepted_at)
      values ($1, $2, 'agent', now())`,
    [org, atendente],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name, force_human, ai_opt_out)
      values ($1, $2, 'Cliente Travado', true, false)`,
    [contato, org],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ($1, $2, $3, '\\x00'::bytea)`,
    [sessao, org, `fechar-devolve-${sessao.slice(0, 8)}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status)
      values ($1, $2, $3, $4, 'open')`,
    [conversa, org, contato, sessao],
  );
  // O dono humano entra pela função de produção (`claim`), e não por um UPDATE
  // à mão: é ela que move `open → claimed` e grava o evento de atribuição.
  await pool.query("select id from public.fn_conversation_assign($1, $2, $3, 'claim', null, true)", [
    org,
    conversa,
    atendente,
  ]);
  await pool.query(
    `insert into demandas (id, organization_id, contact_id, origem, estado, dono_kind, dono_user_id, proximo_passo)
      values ($1, $2, $3, 'inbound', 'em_atendimento', 'humano', $4, 'Responder ao cliente')`,
    [demanda, org, contato, atendente],
  );
  await pool.query(
    `insert into demanda_conversas (organization_id, demanda_id, conversation_id, service_revision)
      values ($1, $2, $3, 7)`,
    [org, demanda, conversa],
  );
  await pool.query(
    `update conversations
        set current_demanda_id = $3,
            service_started_at = now() - interval '10 minutes',
            service_revision = 7,
            service_closed_at = null
      where id = $1 and organization_id = $2`,
    [conversa, org, demanda],
  );
  await pool.query("delete from test_db.fechar_devolve_transicoes where conversation_id = $1", [
    conversa,
  ]);

  const { rows } = await pool.query(
    `select service_revision::int as revisao, service_started_at as iniciado_em
       from conversations where id = $1`,
    [conversa],
  );
  return {
    org,
    atendente,
    contato,
    conversa,
    demanda,
    revisao: rows[0].revisao as number,
    iniciadoEm: rows[0].iniciado_em as Date,
  };
}

interface EstadoConversa {
  status: string;
  service_revision: number;
  service_started_at: Date | null;
  service_closed_at: Date | null;
  current_demanda_id: string | null;
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
}

async function estado(f: Fixture): Promise<EstadoConversa> {
  const { rows } = await pool.query(
    `select status, service_revision::int as service_revision, service_started_at,
            service_closed_at, current_demanda_id, assigned_to_user_id, assignee_kind
       from conversations where id = $1 and organization_id = $2`,
    [f.conversa, f.org],
  );
  return rows[0] as EstadoConversa;
}

async function travaDoContato(f: Fixture): Promise<boolean> {
  const { rows } = await pool.query("select force_human from contacts where id = $1", [f.contato]);
  return rows[0].force_human as boolean;
}

async function transicoes(f: Fixture): Promise<string[]> {
  const { rows } = await pool.query(
    "select status from test_db.fechar_devolve_transicoes where conversation_id = $1 order by id",
    [f.conversa],
  );
  return rows.map((r) => r.status as string);
}

type Corpo = { data: Record<string, unknown> & { devolucao?: { ok: boolean; motivo?: string } } };

async function fechar(
  f: Fixture,
  corpo: Record<string, unknown>,
): Promise<{ status: number; corpo: Corpo }> {
  const res = await POST(
    new NextRequest(`http://localhost/api/v1/conversations/${f.conversa}/close`, {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: f.conversa }) },
  );
  return { status: res.status, corpo: (await res.json()) as Corpo };
}

const ESTADO_EM_CURSO = { status: "claimed", assignee_kind: "user" };

describe("fechar com devolução ao automático numa conversa com dono humano", () => {
  it("a devolução é atendida (dono solto, trava do contato limpa) e a conversa encerra", async () => {
    const f = await fixture();
    const antes = await estado(f);
    expect(antes).toMatchObject(ESTADO_EM_CURSO);
    expect(await travaDoContato(f)).toBe(true);

    const { status, corpo } = await fechar(f, {
      expected_revision: f.revisao,
      devolver_ao_automatico: true,
    });

    expect(status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: true });
    expect(corpo.data.status).toBe("closed");

    const depois = await estado(f);
    expect(depois).toMatchObject({
      status: "closed",
      assigned_to_user_id: null,
      assignee_kind: "ai",
    });
    expect(await travaDoContato(f)).toBe(false);
  });

  it("sobe UM atendimento só: a revisão avança exatamente 1", async () => {
    const f = await fixture();
    await fechar(f, { expected_revision: f.revisao, devolver_ao_automatico: true });

    const depois = await estado(f);
    expect(depois.service_revision).toBe(f.revisao + 1);
  });

  it("o atendimento em curso não é regravado: `service_started_at` não muda", async () => {
    const f = await fixture();
    await fechar(f, { expected_revision: f.revisao, devolver_ao_automatico: true });

    const depois = await estado(f);
    expect(depois.service_started_at?.toISOString()).toBe(f.iniciadoEm.toISOString());
    expect(depois.service_closed_at).not.toBeNull();
  });

  it("o vínculo com a demanda sobrevive ao fechamento (`current_demanda_id` se mantém)", async () => {
    const f = await fixture();
    await fechar(f, { expected_revision: f.revisao, devolver_ao_automatico: true });

    const depois = await estado(f);
    expect(depois.status, "o fechamento aconteceu nesta rodada").toBe("closed");
    expect(depois.current_demanda_id).toBe(f.demanda);
  });

  it("a conversa nunca volta a `open` depois de fechada, e fecha UMA vez", async () => {
    const f = await fixture();
    await fechar(f, { expected_revision: f.revisao, devolver_ao_automatico: true });

    const rastro = await transicoes(f);
    expect(rastro.at(-1), "o rastro tem de terminar em closed").toBe("closed");
    expect(rastro.filter((s) => s === "closed")).toHaveLength(1);
    expect(
      rastro.slice(rastro.indexOf("closed") + 1),
      "nada muda o status depois do fechamento — nem reabertura, nem re-fechamento",
    ).toEqual([]);
    // O rastro inteiro, para quem lê o PR sabê-lo: o release move `claimed →
    // open` ANTES do fechamento (é o que o botão "Devolver ao automático" faz
    // hoje), e o fechamento é a última palavra.
    expect(rastro).toEqual(["open", "ai_handling", "closed"]);
  });

  it("guarda: 'Manter com a equipe' não devolve nada e fecha do mesmo jeito", async () => {
    const f = await fixture();
    const { status, corpo } = await fechar(f, {
      expected_revision: f.revisao,
      devolver_ao_automatico: false,
    });

    expect(status).toBe(200);
    expect(corpo.data.devolucao).toBeUndefined();

    const depois = await estado(f);
    expect(depois.status).toBe("closed");
    expect(depois.service_revision).toBe(f.revisao + 1);
    expect(depois.service_started_at?.toISOString()).toBe(f.iniciadoEm.toISOString());
    expect(await travaDoContato(f)).toBe(true);
  });
});
