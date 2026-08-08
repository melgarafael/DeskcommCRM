import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type { HandlerCtx } from "@/lib/api/handlers/types";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * ARQUIVO DE TRIAGEM (PR #194) — NÃO É PARA MERGE.
 *
 * O que ele protege: a alegação do corpo do PR de que existiam TRÊS defeitos
 * vivos de escrita em coluna gerada, cada um com um efeito de usuário
 * diferente. Nenhum dos três tinha, na `main` 9249e6f2, teste que medisse
 * COMPORTAMENTO — o gate que o PR traz
 * (`colunas-geradas-nao-sao-escritas.test.ts`) varre TEXTO do fonte, e texto
 * não é comportamento.
 *
 * Por que merece catraca: `GENERATED ALWAYS ... STORED` faz o Postgres recusar
 * a INSTRUÇÃO INTEIRA (SQLSTATE 428C9). O campo que se perde não é o gerado —
 * é o UPDATE todo. Os três caminhos aqui chamam o CÓDIGO DE PRODUÇÃO
 * (`patchContactHandler`, a rota POST de anonimização, `dispatchWahaEvent`),
 * nunca SQL escrito à mão: SQL à mão prova que o banco se defende, e o que
 * está em disputa é o que o código manda.
 *
 * As duas bordas de autenticação da rota de LGPD são as ÚNICAS coisas
 * substituídas (`createClient` e `requireRole`). O corpo da rota — a cascata,
 * a ordem, o objeto do UPDATE — é o de produção.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "d194b000-0000-4000-8000-000000000001";
const USUARIO = "d194b000-0000-4000-8000-0000000000a1";

/**
 * A rota de LGPD é um Route Handler: ela busca o client dela sozinha. Trocamos
 * SÓ o transporte (o mesmo `pgComoSupabase` dos demais) e o `getUser`, que é
 * borda de autenticação e não tem nada a ver com o defeito medido.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const base = pgComoSupabase(
      new pg.Pool({
        connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(
          process.env.TEST_DB_PORT ?? 54329,
        )}/postgres`,
        max: 2,
      }),
    ) as unknown as Record<string, unknown>;
    return {
      ...base,
      from: base.from,
      rpc: base.rpc,
      auth: {
        getUser: async () => ({
          data: { user: { id: "d194b000-0000-4000-8000-0000000000a1" } },
          error: null,
        }),
      },
    };
  },
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true }),
}));

function ctx(): HandlerCtx {
  return {
    organization_id: ORG,
    actor: { type: "user", id: USUARIO },
    requestId: "req-triagem-194",
  };
}

async function criarContato(campos: Record<string, unknown> = {}): Promise<string> {
  const base: Record<string, unknown> = {
    organization_id: ORG,
    display_name: "Alvo da triagem",
    source: "manual",
    ...campos,
  };
  const chaves = Object.keys(base);
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (${chaves.map((k) => `"${k}"`).join(",")})
     values (${chaves.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    chaves.map((k) =>
      typeof base[k] === "object" && base[k] !== null ? JSON.stringify(base[k]) : base[k],
    ),
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-triagem-194', 'Triagem LTDA', 'Triagem') on conflict (id) do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

/* ══════════════════════ CONTROLE POSITIVO DO INSTRUMENTO ══════════════════════ */

describe("o instrumento", () => {
  it("as colunas geradas que este arquivo supõe EXISTEM no banco medido", async () => {
    // Sem isto, um banco sem as colunas geradas faria todos os casos abaixo
    // passarem verdes por ausência de causa — e o relatório diria "não
    // reproduz" onde o certo seria "não medi".
    const { rows } = await pool.query<{ chave: string }>(
      `select table_name || '.' || column_name as chave
         from information_schema.columns
        where table_schema='public' and is_generated='ALWAYS'`,
    );
    const chaves = rows.map((r) => r.chave);
    expect(chaves).toContain("contacts.email_normalized");
    expect(chaves).toContain("channel_sessions.is_warmup_complete");
  });
});

/* ═══════════════════════ DEFEITO 2 — e-mail do contato ═══════════════════════ */

describe("defeito 2 — salvar e-mail de contato", () => {
  it("o PATCH conclui e o e-mail fica gravado", async () => {
    const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const id = await criarContato();

    let erro: unknown = null;
    await patchContactHandler(db, ctx(), id, { email: "cliente@exemplo.com" } as never).catch(
      (e) => {
        erro = e;
      },
    );

    const { rows } = await pool.query<{ email: string | null; email_normalized: string | null }>(
      "select email, email_normalized from contacts where id = $1",
      [id],
    );
    expect(
      erro === null,
      `o handler lançou: ${(erro as { detail?: string; message?: string })?.detail ?? (erro as Error)?.message}`,
    ).toBe(true);
    expect(rows[0]!.email, "o e-mail não foi gravado").toBe("cliente@exemplo.com");
    // A derivada tem de sair do banco sozinha.
    expect(rows[0]!.email_normalized).toBe("cliente@exemplo.com");
  });

  it("o PATCH não leva junto os OUTROS campos da mesma instrução", async () => {
    // O que custa caro em coluna gerada não é o campo gerado: é a instrução
    // inteira abortando e derrubando campos que nada têm a ver com ela.
    const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const id = await criarContato();

    await patchContactHandler(db, ctx(), id, {
      email: "outro@exemplo.com",
      name: "Nome que precisa sobreviver",
    } as never).catch(() => null);

    const { rows } = await pool.query<{ name: string | null }>(
      "select name from contacts where id = $1",
      [id],
    );
    expect(rows[0]!.name, "o campo vizinho morreu junto com o e-mail").toBe(
      "Nome que precisa sobreviver",
    );
  });
});

/* ═══════════════════════ DEFEITO 3 — anonimização LGPD ═══════════════════════ */

describe("defeito 3 — anonimização LGPD", () => {
  it("o contato SAI anonimizado do banco", async () => {
    const { POST } = await import("@/app/api/v1/lgpd/anonymize/route");
    const id = await criarContato({ name: "Titular Real", email: "titular@exemplo.com" });

    const req = {
      json: async () => ({ contact_id: id, justification: "pedido do titular via triagem" }),
      headers: new Headers(),
    } as unknown as Request;

    const res = await POST(req as never);
    const corpo = (await res.json()) as Record<string, unknown>;

    const { rows } = await pool.query<{
      is_anonymized: boolean;
      name: string | null;
      email: string | null;
    }>("select is_anonymized, name, email from contacts where id = $1", [id]);

    expect(
      rows[0]!.is_anonymized,
      `a anonimização NÃO aconteceu — resposta ${res.status} ${JSON.stringify(corpo)}`,
    ).toBe(true);
    expect(rows[0]!.name, "o nome do titular continua no banco").toBeNull();
    expect(rows[0]!.email, "o e-mail do titular continua no banco").toBeNull();
  });
});

/* ══════════════════ DEFEITO 4 — fim do warm-up congela o canal ══════════════════ */

describe("defeito 4 — fim do warm-up", () => {
  it("o status do canal ainda é atualizado quando o aquecimento termina", async () => {
    const { dispatchWahaEvent } = await import("@/lib/waha/ingest");

    const { rows: s } = await pool.query<{ id: string }>(
      `insert into channel_sessions
         (organization_id, waha_session_name, webhook_secret_encrypted, status, warmup_started_at)
       values ($1, 'triagem-194', '\\x00'::bytea, 'STARTING', now() - interval '8 days')
       returning id`,
      [ORG],
    );
    const sessionId = s[0]!.id;

    await dispatchWahaEvent(
      db,
      {
        id: sessionId,
        organization_id: ORG,
        is_warmup_complete: false,
        warmup_started_at: new Date(Date.now() - 8 * 864e5).toISOString(),
      } as never,
      { event: "session.status", payload: { status: "WORKING" } } as never,
      "req-triagem-194",
    );

    const { rows } = await pool.query<{ status: string; is_warmup_complete: boolean | null }>(
      "select status, is_warmup_complete from channel_sessions where id = $1",
      [sessionId],
    );
    // O `status` é o dado que o produto mostra. Ele não tem nada a ver com
    // warm-up — e é ele que a instrução abortada levava junto, em silêncio:
    // `handleSessionStatus` não checa o erro do UPDATE.
    expect(rows[0]!.status, "o espelho do canal congelou no estado antigo").toBe("WORKING");
    expect(rows[0]!.is_warmup_complete, "o aquecimento não foi marcado como concluído").toBe(true);
  });
});
