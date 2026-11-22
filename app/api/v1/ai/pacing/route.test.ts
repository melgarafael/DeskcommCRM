/**
 * PATCH/GET /api/v1/ai/pacing — o teto do follow-up (#4063) pela rota.
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * `channel_knobs.followup_daily_cap` existe desde a migration
 * `20261121120000_1043_teto_do_followup.sql` e o motor JÁ o respeita
 * (`decidePacing` veta o 201º follow-up com `followup_cap`), mas a rota não o
 * conhecia: o `KNOB_COLUMNS` do GET não pedia a coluna e o schema `.strict()`
 * do PATCH/PUT recusava o campo com 422. Na prática o teto era 200/dia fixo
 * para toda empresa — a única forma de mudar era `UPDATE` no banco.
 *
 * ─── O que este teste trava ────────────────────────────────────────────────
 *
 * 1. o PATCH grava 350 e a LEITURA SEGUINTE (GET) traz 350 — não adianta
 *    aceitar o campo e não devolvê-lo: a tela voltaria a mostrar 200;
 * 2. quem nunca mexeu lê o default 200, sem override nenhum;
 * 3. o seletor do GET pede a coluna de verdade — o dublê de PostgREST projeta
 *    a linha nas colunas pedidas, como o PostgREST faz; um GET que "lembra" de
 *    um campo que não pediu ao banco passaria aqui sem existir em produção.
 *
 * O dublê é o mesmo padrão de `tests/unit/protecao-de-envio-aceita-data-em-branco.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

interface Registro {
  knobs: Linha | null;
  sessao: Linha;
  /** Cargas entregues ao upsert de `channel_knobs`, na ordem. */
  upserts: Linha[];
}

/** Colunas pedidas no `select("a, b, c")` — o PostgREST só devolve estas. */
function projetar(linha: Linha | null, colunas: string | null): Linha | null {
  if (!linha || !colunas || colunas === "*") return linha;
  const pedidas = colunas
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
  const saida: Linha = {};
  for (const c of pedidas) if (c in linha) saida[c] = linha[c];
  return saida;
}

function makeDb(): Registro {
  const registro: Registro = {
    upserts: [],
    knobs: null,
    sessao: {
      id: CANAL,
      organization_id: ORG,
      archived_at: null,
      waha_session_name: "canal-1",
      display_name: "Canal 1",
      phone_number: null,
      status: "connected",
      daily_message_limit: null,
    },
  };

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private colunas: string | null = null;
    private unico = false;

    constructor(
      private readonly table: string,
      private readonly op: "select" | "update" | "upsert",
      private readonly patch: Linha | null = null,
    ) {}

    select(colunas?: string): this {
      if (colunas) this.colunas = colunas;
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
    in(): this {
      return this;
    }
    order(): this {
      return this;
    }
    maybeSingle(): this {
      this.unico = true;
      return this;
    }

    private casa(linha: Linha): boolean {
      return this.filtros.every(([c, v]) => (linha[c] ?? null) === v);
    }

    private executar(): { data: unknown; error: unknown } {
      if (this.table === "organizations") return { data: null, error: null };

      if (this.op === "select") {
        const linhas =
          this.table === "channel_sessions"
            ? [registro.sessao].filter((l) => this.casa(l))
            : registro.knobs && this.casa(registro.knobs)
              ? [registro.knobs]
              : [];
        const projetadas = linhas.map((l) => projetar(l, this.colunas));
        return { data: this.unico ? (projetadas[0] ?? null) : projetadas, error: null };
      }

      if (this.op === "update") {
        if (this.table === "channel_sessions" && this.casa(registro.sessao)) {
          Object.assign(registro.sessao, this.patch);
        }
        return { data: null, error: null };
      }

      const carga = this.patch ?? {};
      registro.upserts.push(carga);
      registro.knobs = { ...(registro.knobs ?? {}), ...carga };
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
      select: (colunas?: string) => new Q(table, "select").select(colunas),
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

async function corpo(res: Response): Promise<Linha> {
  return ((await res.json()) as { data: Linha }).data;
}

const pedido = (metodo: string, body: Linha) =>
  new NextRequest("http://localhost/api/v1/ai/pacing", {
    method: metodo,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH/GET /api/v1/ai/pacing — teto do follow-up (#4063)", () => {
  it("⭐ PATCH com followup_daily_cap 350 devolve 200 e o GET seguinte traz 350", async () => {
    authOk();
    const db = makeDb();
    const { PATCH, GET } = await import("@/app/api/v1/ai/pacing/route");

    const res = await PATCH(pedido("PATCH", { channel_session_id: CANAL, followup_daily_cap: 350 }));

    expect(res.status).toBe(200);
    expect(db.upserts[0]).toMatchObject({ followup_daily_cap: 350 });
    expect((await corpo(res)).effective).toMatchObject({ followupDailyCap: 350 });

    // A segunda leitura é a prova que importa: é ela que a tela faz ao reabrir a ficha.
    const leitura = await corpo(await GET());
    const item = (leitura.items as Linha[])[0] as {
      effective: Linha;
      overrides: Linha | null;
    };
    expect(item.effective.followupDailyCap).toBe(350);
    expect(item.overrides?.followup_daily_cap).toBe(350);
  });

  it("quem nunca mexeu lê o default 200 — sem override, sem 0", async () => {
    authOk();
    makeDb();
    const { GET } = await import("@/app/api/v1/ai/pacing/route");

    const leitura = await corpo(await GET());
    const item = (leitura.items as Linha[])[0] as {
      effective: Linha;
      overrides: Linha | null;
      defaults: Linha;
    };

    expect(item.effective.followupDailyCap).toBe(200);
    expect(item.defaults.followupDailyCap).toBe(200);
    expect(item.overrides?.followup_daily_cap ?? null).toBeNull();
  });
});
