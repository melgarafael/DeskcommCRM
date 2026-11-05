/**
 * A LIGAÇÃO PRESA EM TOQUE SAI POR PRAZO — de ponta a ponta, contra o Postgres
 * do harness (issue #3977).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A linha de `voice_calls` só sai de `starting`/`ringing` quando chega o evento
 * de fim de canal ou quando alguém atende/recusa pela tela. Se o worker de voz
 * está reiniciando/deploy/fora do ar no instante em que o canal cai, o evento se
 * PERDE e a linha fica `ringing` para sempre: não existe prazo de saída, e as
 * linhas que já estão presas nas instalações não são destravadas por ninguém.
 *
 * ─── Por que um invariante de BANCO, e não só o unitário ────────────────────
 *
 * O unitário (`tests/unit/cron-ligacao-presa.test.ts`) mede a REGRA com um dublê
 * que aplica filtros em memória. Aqui quem responde é o banco de verdade: o
 * recorte por estado/idade, o claim do UPDATE (uma ligação atendida entre o
 * SELECT e o UPDATE não é encerrada por baixo de quem fala), o encadeamento com
 * as telas — e o principal, que nenhum dublê prova: **a linha que já estava
 * presa antes da atualização é destravada pela mesma rodada**, porque o prazo é
 * lido de `started_at` e não de um estado novo que só nasceria daqui para
 * frente.
 *
 * Dublê é só o TRANSPORTE (o client do Supabase vira tradutor para SQL, mesma
 * ideia de `tests/invariants/fechar-devolve-sem-atendimento-fantasma.test.ts`),
 * a auditoria (que aqui TAMBÉM é medida: rodada sem efeito não audita) e o
 * relógio das linhas semeadas, que é o `now()` do banco.
 *
 * ─── SABOTAGEM que este arquivo tem de saber pegar ──────────────────────────
 *
 * - `.in("status", ESTADOS_DE_TOQUE)` trocado por `["starting","ringing","connected"]`
 *   no SELECT ou no UPDATE: vermelho em "atendida nunca é tocada";
 * - tirar o `.in("status", ...)` do UPDATE (o claim): vermelho em "quem foi
 *   atendida no meio da rodada não é encerrada";
 * - trocar `lt("started_at", ...)` por `gt(...)` (ou por `updated_at`): vermelho
 *   em "40 minutos vira terminal" e em "toque recente não é tocado";
 * - gravar `end_reason = 'timeout'` em vez do motivo próprio: vermelho no motivo
 *   literal e no mapeamento da lista de Chamadas;
 * - devolver o prazo para dentro do SELECT sem organização no UPDATE: vermelho
 *   em "nenhuma escrita atravessa organização".
 */
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/cron/ligacao-presa/route";
import { MOTIVO_PRAZO_SEM_EVENTO, PRAZO_PADRAO_MIN } from "@/lib/voice/ligacao-presa";

import { seedGov } from "./gov-helpers";

// `vi.hoisted`: as fábricas de `vi.mock` rodam ANTES das declarações do módulo,
// então um `const` comum cairia em TDZ na primeira importação.
const h = vi.hoisted(() => ({
  segredo: "segredo-do-cron-da-voz-3977",
  /** A trilha de auditoria, capturada em memória: só o EFEITO dela interessa aqui. */
  auditadas: [] as Record<string, unknown>[],
}));

const SEGREDO = h.segredo;
const OUTRO_SEGREDO = "segredo-que-nao-vale";
const auditadas = h.auditadas;

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: h.segredo,
    INTERNAL_SECRET: "",
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: (entrada: Record<string, unknown>) => {
    h.auditadas.push(entrada);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteDoSgbd() }));

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 4,
});
afterAll(() => pool.end());

type Resposta = { data: unknown; error: { message: string; code?: string } | null };

/**
 * O mínimo do `PostgrestQueryBuilder` que esta rota usa, preso ao pool:
 * `select(...).in().lt().limit()` e `update().in().eq().in().select()`.
 * Colunas de texto comparadas com lista viram `::text = any($n)` para não brigar
 * com o tipo `uuid` de `id`/`organization_id`.
 */
class Consulta {
  private modo: "select" | "update" = "select";
  private retorno = "*";
  private dados: Record<string, unknown> | null = null;
  private filtros: string[] = [];
  private params: unknown[] = [];
  private teto = "";

  constructor(private readonly tabela: string) {}

  select(colunas = "*"): this {
    if (this.modo === "update") this.retorno = colunas;
    return this;
  }

  update(dados: Record<string, unknown>): this {
    this.modo = "update";
    this.dados = dados;
    return this;
  }

  eq(coluna: string, valor: unknown): this {
    this.filtros.push(`${coluna}::text = $${this.params.length + 1}`);
    this.params.push(valor);
    return this;
  }

  in(coluna: string, valores: unknown[]): this {
    this.filtros.push(`${coluna}::text = any($${this.params.length + 1})`);
    this.params.push(valores);
    return this;
  }

  lt(coluna: string, valor: unknown): this {
    this.filtros.push(`${coluna} < $${this.params.length + 1}`);
    this.params.push(valor);
    return this;
  }

  limit(n: number): this {
    this.teto = ` limit ${n}`;
    return this;
  }

  private async executar(): Promise<Resposta> {
    const onde = this.filtros.length > 0 ? ` where ${this.filtros.join(" and ")}` : "";
    try {
      if (this.modo === "select") {
        const { rows } = await pool.query(`select * from public.${this.tabela}${onde}${this.teto}`, this.params);
        return { data: rows, error: null };
      }
      const colunas = Object.keys(this.dados ?? {});
      const sets = colunas.map((c, i) => `${c} = $${i + 1}`).join(", ");
      const valores = colunas.map((c) => (this.dados ?? {})[c]);
      const deslocados = this.filtros.map((f) => f.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + colunas.length}`));
      const { rows } = await pool.query(
        `update public.${this.tabela} set ${sets}${deslocados.length > 0 ? ` where ${deslocados.join(" and ")}` : ""} returning ${this.retorno}`,
        [...valores, ...this.params],
      );
      return { data: rows, error: null };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return { data: null, error: { message: e?.message ?? "erro no banco", ...(e?.code ? { code: e.code } : {}) } };
    }
  }

  then(resolve: (r: Resposta) => unknown): Promise<unknown> {
    return this.executar().then(resolve);
  }
}

function clienteDoSgbd() {
  return { from: (tabela: string) => new Consulta(tabela) };
}

const ORG_A = "cccccccc-0000-4000-8000-000000000001"; // GOV_ORG (seedGov)
const ORG_B = "cccccccc-0000-4000-8000-0000000000b2";

const ID = {
  presaComeco: "eeeeeeee-0000-4000-8000-000000000001", // starting 40 min (org A)
  presaAntiga: "eeeeeeee-0000-4000-8000-000000000002", // ringing 3 dias (backfill)
  tocandoAgora: "eeeeeeee-0000-4000-8000-000000000003", // ringing 45 s
  quaseNoPrazo: "eeeeeeee-0000-4000-8000-000000000004", // ringing 14 min
  atendida: "eeeeeeee-0000-4000-8000-000000000005", // connected 90 min
  jaEncerrada: "eeeeeeee-0000-4000-8000-000000000006", // ended, user_ended
  outraOrg: "eeeeeeee-0000-4000-8000-000000000007", // starting 70 min, org B
} as const;

const TODAS = Object.values(ID);

async function semear(): Promise<void> {
  seedGov();

  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
       values ($1, 'inv-3977-b', 'Invariante 3977 B', 'Inv 3977 B')
       on conflict do nothing`,
    [ORG_B],
  );

  await pool.query(`delete from public.voice_calls where id = any($1::uuid[])`, [TODAS]);

  // `started_at` é o ÚNICO relógio que a varredura lê — e é o certo: ninguém o
  // reescreve (o gatilho mexe em `updated_at`).
  const linhas: Array<[string, string, string, string, string, string | null]> = [
    [ID.presaComeco, ORG_A, "sip", "starting", "now() - interval '40 minutes'", null],
    [ID.presaAntiga, ORG_A, "sip", "ringing", "now() - interval '3 days'", null],
    [ID.tocandoAgora, ORG_A, "wacalls", "ringing", "now() - interval '45 seconds'", null],
    [ID.quaseNoPrazo, ORG_A, "wacalls", "ringing", "now() - interval '14 minutes'", null],
    [ID.atendida, ORG_A, "sip", "connected", "now() - interval '90 minutes'", "user_ended"],
    [ID.jaEncerrada, ORG_A, "sip", "ended", "now() - interval '2 days'", "user_ended"],
    [ID.outraOrg, ORG_B, "sip", "starting", "now() - interval '70 minutes'", null],
  ];

  for (const [id, org, provider, status, idade, motivo] of linhas) {
    await pool.query(
      `insert into public.voice_calls
         (id, organization_id, provider, direction, peer_phone, status, end_reason, started_at, answered_at, ended_at)
       values ($1, $2, $3, 'inbound', '+5511900000000', $4, $5, ${idade},
               ${status === "ended" || status === "connected" ? "now() - interval '85 minutes'" : "null"},
               ${status === "ended" ? "now() - interval '89 minutes'" : "null"})`,
      [id, org, provider, status, motivo],
    );
  }
}

interface Instantaneo {
  id: string;
  status: string;
  end_reason: string | null;
  started_at: Date;
  ended_at: Date | null;
  updated_at: Date;
}

async function retrato(): Promise<Instantaneo[]> {
  const { rows } = await pool.query<Instantaneo>(
    `select id, status, end_reason, started_at, ended_at, updated_at
       from public.voice_calls where id = any($1::uuid[]) order by id`,
    [TODAS],
  );
  return rows;
}

async function linha(id: string): Promise<Instantaneo> {
  const { rows } = await pool.query<Instantaneo>(
    `select id, status, end_reason, started_at, ended_at, updated_at
       from public.voice_calls where id = $1`,
    [id],
  );
  const primeira = rows[0];
  if (!primeira) throw new Error(`linha ${id} não existe — a semente não rodou`);
  return primeira;
}

function chamar(segredo: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (segredo) headers.authorization = `Bearer ${segredo}`;
  return GET(new NextRequest("http://local/api/v1/cron/ligacao-presa", { headers }));
}

const corpo = async (res: Response) =>
  ((await res.json()) as { data: { varridas: number; encerradas: number; organizacoes: number; prazo_min: number } })
    .data;

beforeAll(async () => {
  await semear();
  // Controle do instrumento: se o pool não enxerga a semente, todo caso abaixo
  // passaria por vacuidade (linha ausente ⇒ "não mudou").
  expect((await retrato())).toHaveLength(TODAS.length);
});

describe("cron ligacao-presa contra o banco", () => {
  it("sem segredo, recusa (403) e não escreve nada", async () => {
    const antes = await retrato();

    const semSegredo = await chamar(null);
    expect(semSegredo.status).toBe(403);

    const errado = await chamar(OUTRO_SEGREDO);
    expect(errado.status).toBe(403);

    // A recusa tem de vir ANTES de qualquer varredura: nada pode ter mudado.
    expect(await retrato()).toEqual(antes);
  });

  it("a linha em `starting` há 40 minutos vira terminal, com motivo literal e `ended_at`", async () => {
    const res = await chamar(SEGREDO);
    expect(res.status).toBe(200);
    const dados = await corpo(res);
    expect(dados.prazo_min).toBe(PRAZO_PADRAO_MIN);
    expect(dados.encerradas).toBeGreaterThanOrEqual(1);

    const presa = await linha(ID.presaComeco);
    expect(presa.status).toBe("ended");
    expect(presa.end_reason).toBe(MOTIVO_PRAZO_SEM_EVENTO);
    expect(MOTIVO_PRAZO_SEM_EVENTO).toBe("encerrada_por_prazo_sem_evento");
    expect(presa.ended_at).not.toBeNull();
    // Não é `timeout`: `timeout` é fato do provedor ("ninguém atendeu"), e aqui o
    // fato é que o CRM não soube como a ligação acabou.
    expect(presa.end_reason).not.toBe("timeout");

    // E a varredura que fez efeito deixa rastro na trilha.
    expect(auditadas.some((a) => a.action === "voice.recover_stuck_run")).toBe(true);
  });

  it("destrava de graça a linha que já estava presa antes da atualização (backfill)", async () => {
    const antiga = await linha(ID.presaAntiga);
    expect(antiga.status).toBe("ended");
    expect(antiga.end_reason).toBe(MOTIVO_PRAZO_SEM_EVENTO);
    expect(antiga.ended_at).not.toBeNull();
  });

  it("toque recente fica intacto — o prazo não mata ligação viva", async () => {
    // 45 s: abaixo do toque real do provedor (~60 s) e muito abaixo do prazo.
    const agora = await linha(ID.tocandoAgora);
    expect(agora.status).toBe("ringing");
    expect(agora.end_reason).toBeNull();
    expect(agora.ended_at).toBeNull();

    // 14 min: a borda. Um `lte` no corte, ou um prazo de 10 min, cairia aqui.
    const quase = await linha(ID.quaseNoPrazo);
    expect(quase.status).toBe("ringing");
    expect(quase.end_reason).toBeNull();
  });

  it("ligação ATENDIDA nunca é tocada, nem com 90 minutos de idade", async () => {
    const atendida = await linha(ID.atendida);
    expect(atendida.status).toBe("connected");
    expect(atendida.end_reason).toBe("user_ended");
    expect(atendida.ended_at).toBeNull();
  });

  it("linha já terminal não muda, e a segunda rodada é um no-op (idempotência)", async () => {
    const antes = await retrato();

    const primeira = await corpo(await chamar(SEGREDO));
    const depoisDaPrimeira = await retrato();
    const segunda = await corpo(await chamar(SEGREDO));
    const depoisDaSegunda = await retrato();

    // Duas execuções seguidas: nem `ended_at` nem motivo se movem, e a segunda
    // rodada não encontra nada para encerrar.
    expect(primeira.encerradas).toBe(0);
    expect(segunda.encerradas).toBe(0);
    expect(segunda.varridas).toBe(0);
    expect(depoisDaPrimeira).toEqual(antes);
    expect(depoisDaSegunda).toEqual(antes);

    const encerrada = await linha(ID.jaEncerrada);
    expect(encerrada.end_reason).toBe("user_ended");
  });

  it("outra organização é tratada pela MESMA varredura, sem escrita atravessada", async () => {
    const outra = await linha(ID.outraOrg);
    expect(outra.status).toBe("ended");
    expect(outra.end_reason).toBe(MOTIVO_PRAZO_SEM_EVENTO);

    // A varredura é global, mas a escrita não vaza: as linhas da org A seguem
    // exatamente no estado que cada uma tinha. Se o UPDATE não levasse
    // `organization_id`, a rodada da org B carimbaria linha da org A.
    expect((await linha(ID.tocandoAgora)).status).toBe("ringing");
    expect((await linha(ID.atendida)).status).toBe("connected");
    expect((await linha(ID.jaEncerrada)).end_reason).toBe("user_ended");
  });

  it("rodada sem nada para encerrar NÃO audita", async () => {
    auditadas.length = 0;
    const dados = await corpo(await chamar(SEGREDO));

    expect(dados.encerradas).toBe(0);
    expect(auditadas).toEqual([]);
  });
});
