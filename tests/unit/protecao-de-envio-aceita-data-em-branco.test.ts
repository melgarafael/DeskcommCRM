/**
 * PROTEÇÃO DE ENVIO: SALVAR COM "NÚMERO EM USO DESDE" EM BRANCO (issue #419).
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * `channel_knobs.number_activated_at` é a ÚNICA coluna da tabela com `not null`,
 * e ela tem `default now()`. A ficha Anti-ban trata a data como opcional: com o
 * campo vazio, `AntiBanSheet` envia `number_activated_at: null`, e o texto de
 * ajuda promete que em branco o número "é tratado como recém-criado".
 *
 * Só que `null` EXPLÍCITO não cai no default — ele o anula. Reproduzido num
 * Postgres 17 com o DDL extraído verbatim de `supabase/baseline.sql` e o payload
 * exato que a rota monta:
 *
 *   ERROR:  null value in column "number_activated_at" of relation
 *           "channel_knobs" violates not-null constraint
 *
 * O mesmo payload SEM a chave insere e a coluna nasce preenchida pelo default —
 * é este o controle positivo que diz que o culpado é a chave, não o valor.
 *
 * Quem nunca declarou a data — toda instalação nova, já que `channel_knobs`
 * nasce vazia — não conseguia ajustar a janela anti-banimento pela tela. E o
 * agravante: sem linha, o motor lê idade 0 e aplica o degrau {minAgeDays: 0,
 * cap: 20} dos PACING_DEFAULTS. O operador que tentava corrigir o teto de 20
 * envios/dia esbarrava neste erro.
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * `number_activated_at: null` significa "não estou declarando esta data", e não
 * "grave nulo": a chave sai do upsert. Em linha nova o `default now()` age
 * (idade 0 = recém-criado, exatamente o que a tela promete); em linha existente
 * a data já salva é PRESERVADA — apagar o campo não rejuvenesce o número em
 * silêncio, que é o desfecho que voltaria a rebaixá-lo a 20 envios/dia.
 *
 * ─── E o erro do banco deixa de ser mistério ───────────────────────────────
 *
 * A rota descartava `upErr` e devolvia só "Falha ao salvar os knobs." — sem o
 * nome do campo que recusou, nem na tela nem no log. Foi essa ausência que
 * transformou um `not null` num diagnóstico de horas. O motivo cru do banco vai
 * em `details`, nunca na `message` traduzida que o operador lê.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";
const DATA_JA_SALVA = "2026-01-10T12:00:00.000Z";

type Linha = Record<string, unknown>;

/** O 23502 que o Postgres devolve para o payload da tela (medido, não inventado). */
const NAO_NULO = {
  code: "23502",
  message:
    'null value in column "number_activated_at" of relation "channel_knobs" violates not-null constraint',
};

interface Registro {
  /** Cargas entregues ao upsert de `channel_knobs`, na ordem. */
  upserts: Linha[];
  knobs: Linha | null;
  sessao: Linha;
}

/**
 * Dublê do PostgREST que faz o que o banco REAL faz com esta tabela: recusa o
 * upsert que carrega `number_activated_at: null` e, quando a chave está
 * ausente, aplica o `default now()` em linha nova e preserva o valor em linha
 * existente. Sem isso o teste mediria só a forma da carga, e um conserto que
 * mandasse null com outro nome passaria.
 */
function makeDb(knobsIniciais: Linha | null = null): Registro {
  const registro: Registro = {
    upserts: [],
    knobs: knobsIniciais,
    sessao: { id: CANAL, organization_id: ORG, archived_at: null, daily_message_limit: 250 },
  };

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];

    constructor(
      private readonly table: string,
      private readonly op: "select" | "update" | "upsert",
      private readonly patch: Linha | null = null,
    ) {}

    select(): this {
      return this;
    }
    eq(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    is(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    maybeSingle(): this {
      return this;
    }

    private casa(linha: Linha): boolean {
      return this.filtros.every(([c, v]) => (linha[c] ?? null) === v);
    }

    private executar(): { data: unknown; error: unknown } {
      if (this.op === "select") {
        const linha = this.table === "channel_sessions" ? registro.sessao : registro.knobs;
        return { data: linha && this.casa(linha) ? linha : null, error: null };
      }

      if (this.op === "update") {
        if (this.casa(registro.sessao)) Object.assign(registro.sessao, this.patch);
        return { data: null, error: null };
      }

      const carga = this.patch ?? {};
      registro.upserts.push(carga);
      // A constraint da coluna, exatamente como o Postgres a aplica.
      if ("number_activated_at" in carga && carga.number_activated_at === null) {
        return { data: null, error: NAO_NULO };
      }
      const anterior = registro.knobs;
      registro.knobs = {
        ...(anterior ?? { number_activated_at: "2026-09-01T00:00:00.000Z" /* default now() */ }),
        ...carga,
      };
      return { data: null, error: null };
    }

    then<R1 = unknown, R2 = never>(
      onOk?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
      onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.executar()).then(onOk, onErr);
    }
  }

  const client = {
    from: (table: string) => ({
      select: () => new Q(table, "select"),
      update: (patch: Linha) => new Q(table, "update", patch),
      upsert: (patch: Linha) => new Q(table, "upsert", patch),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return registro;
}

function authOk(): void {
  const user: AuthUser = {
    id: USER,
    email: "dono@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG, name: "Org", role: "admin" as const },
  } as never);
}

/** O corpo EXATO que `AntiBanSheet.handleSave` monta — nada aqui é simplificado. */
function corpoDaTela(over: Linha = {}): Linha {
  return {
    channel_session_id: CANAL,
    window_start_hour: 7,
    window_end_hour: 22,
    throttle_ms: 1200,
    jitter_max_ms: 800,
    allow_sunday: null,
    timezone: null,
    number_activated_at: null,
    skip_warmup: false,
    ...over,
  };
}

const put = (corpo: Linha) =>
  new NextRequest("http://localhost/api/v1/ai/pacing", {
    method: "PUT",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/v1/ai/pacing — data em branco não impede salvar a janela", () => {
  it("⭐ instalação nova (channel_knobs vazia): salva a janela com a data em branco", async () => {
    authOk();
    const db = makeDb(null);
    const { PUT } = await import("@/app/api/v1/ai/pacing/route");
    const res = await PUT(put(corpoDaTela()));

    expect(res.status).toBe(200);
    // A chave não pode chegar ao banco: `null` explícito anula o `default now()`.
    expect(db.upserts[0]).not.toHaveProperty("number_activated_at");
    // E o que o operador veio fazer tem de ter sido gravado.
    expect(db.knobs).toMatchObject({ window_start_hour: 7, window_end_hour: 22 });
  });

  it("data já salva sobrevive a um save com o campo em branco", async () => {
    authOk();
    const db = makeDb({
      organization_id: ORG,
      channel_session_id: CANAL,
      window_start_hour: 9,
      window_end_hour: 18,
      number_activated_at: DATA_JA_SALVA,
    });
    const { PUT } = await import("@/app/api/v1/ai/pacing/route");
    const res = await PUT(put(corpoDaTela()));

    expect(res.status).toBe(200);
    // Rejuvenescer o número em silêncio o rebaixaria a 20 envios/dia — o mesmo
    // teto que o operador abriu esta ficha para corrigir.
    expect(db.knobs?.number_activated_at).toBe(DATA_JA_SALVA);
  });

  it("data informada continua sendo gravada (o campo não virou decorativo)", async () => {
    authOk();
    const db = makeDb(null);
    const declarada = "2026-03-01T12:00:00.000Z";
    const { PUT } = await import("@/app/api/v1/ai/pacing/route");
    const res = await PUT(put(corpoDaTela({ number_activated_at: declarada })));

    expect(res.status).toBe(200);
    expect(db.upserts[0]?.number_activated_at).toBe(declarada);
    expect(db.knobs?.number_activated_at).toBe(declarada);
  });

  it("o audit não afirma ter gravado uma data que não gravou", async () => {
    authOk();
    makeDb(null);
    const { PUT } = await import("@/app/api/v1/ai/pacing/route");
    await PUT(put(corpoDaTela()));

    const metadata = vi.mocked(audit).mock.calls[0]?.[0]?.metadata as Linha | undefined;
    expect(metadata).toBeDefined();
    expect(metadata).not.toHaveProperty("number_activated_at");
  });
});

describe("PUT /api/v1/ai/pacing — erro do banco diz QUAL campo recusou", () => {
  it("⭐ o motivo cru do Postgres chega em details, e a mensagem lida segue humana", async () => {
    authOk();
    makeDb(null);
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => ({
        select: () => {
          const q = {
            eq: () => q,
            is: () => q,
            maybeSingle: async () =>
              table === "channel_sessions"
                ? { data: { id: CANAL, organization_id: ORG, archived_at: null }, error: null }
                : { data: null, error: null },
          };
          return q;
        },
        upsert: async () => ({ data: null, error: NAO_NULO }),
      }),
    } as never);

    const { PUT } = await import("@/app/api/v1/ai/pacing/route");
    const res = await PUT(put(corpoDaTela({ number_activated_at: null })));
    const corpo = await res.json();

    expect(res.status).toBe(500);
    // Sem isto, um `not null` vira "Falha ao salvar os knobs." e ninguém sabe
    // qual campo recusou — foi essa ausência que custou o diagnóstico.
    expect(corpo.error.details).toBeDefined();
    expect(JSON.stringify(corpo.error.details)).toContain("number_activated_at");
    // E o operador continua lendo português, não uma frase do Postgres.
    expect(corpo.error.message).toBe("Falha ao salvar os knobs.");
  });
});

describe("A TELA e o texto que ela promete", () => {
  it("o texto de ajuda não promete rejuvenescer um número cuja data já está salva", () => {
    const sheet = readFileSync(
      join(process.cwd(), "components/connections/AntiBanSheet.tsx"),
      "utf8",
    );
    // A promessa "em branco = recém-criado" vale para quem NUNCA declarou a
    // data. Para quem já declarou, o campo vazio preserva — e a tela precisa
    // dizer isso, senão ela oferece um apagamento que o código não faz.
    expect(
      /data já salva/i.test(sheet),
      "AntiBanSheet não explica que apagar o campo NÃO apaga a data já salva",
    ).toBe(true);
  });
});
