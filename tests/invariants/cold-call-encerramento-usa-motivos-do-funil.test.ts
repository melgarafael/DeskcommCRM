/**
 * OS RESULTADOS DO COLD CALL QUE ENCERRAM O LEAD PASSAM PELO BANCO (#3941).
 *
 * ─── O defeito, medido pela tela ────────────────────────────────────────────
 *
 * "Tirar da fila" respondia 422 `lost_reason_invalid` e o lead ficava na fila. O
 * resultado `removido` encerra com o motivo "Tirado da fila", e
 * `fn_validate_lost_reason_required` só aceita motivo canônico ou listado em
 * `settings.lost_reasons` do funil, lista que o funil do Cold Call nascia sem.
 * "Não tem interesse" e "Número errado" caíam no mesmo lugar.
 *
 * ─── Por que um invariante de BANCO ─────────────────────────────────────────
 *
 * Quem recusa é o gatilho, e o dublê do unitário não tem gatilho: lá
 * `encerraDemanda` é dublado e o defeito passava verde. Aqui as DUAS rotas de
 * verdade (criar o funil e registrar o resultado), com `encerraDemanda` de
 * verdade, rodam contra o Postgres do harness. Dublê é só o transporte (o client
 * vira tradutor para SQL, como em `fechar-devolve-sem-atendimento-fantasma`),
 * as guardas de sessão, a chave do módulo e os dois registros laterais (timeline
 * e audit), que não são o assunto.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *
 * Tirar `lost_reasons` do POST de `app/api/v1/cold-call/route.ts` deixa vermelho
 * "o funil nasce com os motivos". Tirar a chamada de `garanteMotivosDoColdCall`
 * de `app/api/v1/cold-call/resultado/route.ts` deixa vermelho o funil antigo
 * (422 `lost_reason_invalid` nos três resultados).
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => null,
  readSupportContext: async () => null,
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "00000000-0000-4000-8000-000000000001", idioma: "pt-BR" },
    org: { orgId: organizacaoDaVez(), role: "manager" },
  }),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: async () => ({ ok: true }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteDoSgbd() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteDoSgbd() }));

import { POST as criarFunil } from "@/app/api/v1/cold-call/route";
import { POST as registrarResultado } from "@/app/api/v1/cold-call/resultado/route";
import { ETAPAS_DO_COLD_CALL, MOTIVOS_DE_PERDA_DO_COLD_CALL, RESULTADOS } from "@/lib/cold-call/regras";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
afterAll(() => pool.end());

let orgAtual = "";
const organizacaoDaVez = () => orgAtual;

type Resposta = { data: unknown; error: { message: string; code?: string } | null };

/** O embed do PostgREST que a rota de resultado usa, traduzido para subconsulta. */
const EMBED_DO_FUNIL =
  "(select jsonb_build_object('settings', p.settings) from public.crm_pipelines p where p.id = crm_leads.pipeline_id) as crm_pipelines";

/** O mínimo do `PostgrestQueryBuilder` que este caminho usa, preso ao pool do harness. */
class Consulta {
  private modo: "select" | "update" | "insert" = "select";
  private colunas = "*";
  private retorno: string | null = null;
  private dados: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private filtros: string[] = [];
  private params: unknown[] = [];
  private ordenacao = "";
  private teto = "";

  constructor(private readonly tabela: string) {}

  select(colunas = "*"): this {
    const traduzidas = colunas.replace("crm_pipelines(settings)", EMBED_DO_FUNIL);
    if (this.modo === "select") this.colunas = traduzidas;
    else this.retorno = traduzidas;
    return this;
  }

  insert(dados: Record<string, unknown> | Record<string, unknown>[]): this {
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

  private async executar(): Promise<Resposta> {
    try {
      if (this.modo === "select") {
        const r = await pool.query(
          `select ${this.colunas} from public.${this.tabela}${this.where()}${this.ordenacao}${this.teto}`,
          this.params,
        );
        return { data: r.rows, error: null };
      }
      if (this.modo === "update") {
        const dados = this.dados as Record<string, unknown>;
        const colunas = Object.keys(dados);
        const sets = colunas.map((c, i) => `${c} = $${this.params.length + i + 1}`).join(", ");
        const r = await pool.query(
          `update public.${this.tabela} set ${sets}${this.where()} returning ${this.retorno ?? "*"}`,
          [...this.params, ...colunas.map((c) => dados[c])],
        );
        return { data: r.rows, error: null };
      }
      const linhas = Array.isArray(this.dados) ? this.dados : [this.dados!];
      const colunas = Object.keys(linhas[0]!);
      const valores: unknown[] = [];
      const tuplas = linhas.map((linha) => {
        const marcas = colunas.map((c) => {
          valores.push(linha[c]);
          return `$${valores.length}`;
        });
        return `(${marcas.join(", ")})`;
      });
      const r = await pool.query(
        `insert into public.${this.tabela} (${colunas.join(", ")}) values ${tuplas.join(", ")} returning ${this.retorno ?? "*"}`,
        valores,
      );
      return { data: r.rows, error: null };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return { data: null, error: { message: e?.message ?? "erro no banco", ...(e?.code ? { code: e.code } : {}) } };
    }
  }

  async maybeSingle(): Promise<Resposta> {
    const r = await this.executar();
    if (r.error) return r;
    return { data: (r.data as unknown[])[0] ?? null, error: null };
  }

  async single(): Promise<Resposta> {
    return this.maybeSingle();
  }

  then<R1 = Resposta, R2 = never>(
    ok?: ((v: Resposta) => R1 | PromiseLike<R1>) | null,
    falha?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.executar().then(ok, falha);
  }
}

function clienteDoSgbd(): unknown {
  return {
    from: (tabela: string) => new Consulta(tabela),
    rpc: async (nome: string) => ({ data: null, error: { message: `dublê: rpc não dublada ${nome}` } }),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
}

async function novaOrganizacao(): Promise<string> {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Cold LTDA', 'Cold')`,
    [org, `cold-${org.slice(0, 8)}`],
  );
  orgAtual = org;
  return org;
}

/** O funil como o POST da main o criava: marcado como cold call e SEM `lost_reasons`. */
async function funilAntigo(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position, settings)
     values ($1, 'Cold Call', $2, 100, $3) returning id`,
    [org, `cold-call-${org.slice(0, 8)}`, { cold_call: { ativo: true, roteiro: "" } }],
  );
  const funil = rows[0]!.id;
  for (const [i, e] of ETAPAS_DO_COLD_CALL.entries()) {
    await pool.query(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [org, funil, e.name, e.slug, (i + 1) * 1000, e.is_won, e.is_lost],
    );
  }
  return funil;
}

async function leadNaFila(org: string, funil: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status)
     select $1, $2, s.id, 'Padaria', 'open' from crm_stages s where s.pipeline_id = $2 and s.slug = 'na-fila'
     returning id`,
    [org, funil],
  );
  return rows[0]!.id;
}

async function registrar(leadId: string, resultado: string) {
  const resposta = await registrarResultado(
    new NextRequest("http://localhost/api/v1/cold-call/resultado", {
      method: "POST",
      body: JSON.stringify({ lead_id: leadId, resultado }),
      headers: { "content-type": "application/json" },
    }),
  );
  return { status: resposta.status, corpo: (await resposta.json()) as { error?: { code: string } } };
}

async function estadoDoLead(leadId: string) {
  const { rows } = await pool.query<{ status: string; lost_reason: string | null; slug: string }>(
    `select l.status, l.lost_reason, s.slug from crm_leads l join crm_stages s on s.id = l.stage_id where l.id = $1`,
    [leadId],
  );
  return rows[0]!;
}

async function motivosDoFunil(funil: string): Promise<unknown[]> {
  const { rows } = await pool.query<{ lista: unknown[] | null }>(
    `select settings->'lost_reasons' as lista from crm_pipelines where id = $1`,
    [funil],
  );
  return rows[0]!.lista ?? [];
}

const QUE_ENCERRAM = (Object.keys(RESULTADOS) as (keyof typeof RESULTADOS)[]).filter(
  (r) => "perde" in RESULTADOS[r],
);

describe("resultados do Cold Call que encerram o lead", () => {
  it("a lista vem das regras: três resultados encerram", () => {
    expect(QUE_ENCERRAM).toEqual(["sem_interesse", "numero_errado", "removido"]);
    expect(MOTIVOS_DE_PERDA_DO_COLD_CALL).toEqual(QUE_ENCERRAM.map((r) => RESULTADOS[r].rotulo));
  });

  it("o funil nasce com os motivos", async () => {
    await novaOrganizacao();
    const criado = await criarFunil();
    expect(criado.status).toBe(201);
    const { data } = (await criado.json()) as { data: { id: string } };
    expect(await motivosDoFunil(data.id)).toEqual(expect.arrayContaining([...MOTIVOS_DE_PERDA_DO_COLD_CALL]));
  });

  for (const resultado of QUE_ENCERRAM) {
    it(`funil recém-criado: ${resultado} responde 200 e o lead sai da fila`, async () => {
      const org = await novaOrganizacao();
      const criado = await criarFunil();
      const { data } = (await criado.json()) as { data: { id: string } };
      const lead = await leadNaFila(org, data.id);

      const r = await registrar(lead, resultado);
      expect(r.corpo.error?.code).toBeUndefined();
      expect(r.status).toBe(200);
      expect(await estadoDoLead(lead)).toEqual({ status: "lost", lost_reason: RESULTADOS[resultado].rotulo, slug: "perdido" });
    });

    it(`funil antigo sem os motivos: ${resultado} responde 200 e o lead sai da fila`, async () => {
      const org = await novaOrganizacao();
      const funil = await funilAntigo(org);
      const lead = await leadNaFila(org, funil);

      const r = await registrar(lead, resultado);
      expect(r.corpo.error?.code).toBeUndefined();
      expect(r.status).toBe(200);
      expect(await estadoDoLead(lead)).toEqual({ status: "lost", lost_reason: RESULTADOS[resultado].rotulo, slug: "perdido" });
    });
  }

  it("funil antigo: acrescentar é idempotente e preserva o que já estava", async () => {
    const org = await novaOrganizacao();
    const funil = await funilAntigo(org);
    await pool.query(
      `update crm_pipelines set settings = settings || '{"lost_reasons": [{"label": "Sem orçamento", "categoria": "Cliente"}]}'::jsonb where id = $1`,
      [funil],
    );
    for (const resultado of QUE_ENCERRAM) {
      expect((await registrar(await leadNaFila(org, funil), resultado)).status).toBe(200);
    }
    expect(await motivosDoFunil(funil)).toEqual([
      { label: "Sem orçamento", categoria: "Cliente" },
      ...MOTIVOS_DE_PERDA_DO_COLD_CALL,
    ]);
  });

  it("funil comum não ganha motivo: a rota recusa antes", async () => {
    const org = await novaOrganizacao();
    const funil = await funilAntigo(org);
    await pool.query(`update crm_pipelines set settings = '{}'::jsonb where id = $1`, [funil]);
    const r = await registrar(await leadNaFila(org, funil), "removido");
    expect(r.status).toBe(422);
    expect(await motivosDoFunil(funil)).toEqual([]);
  });
});
