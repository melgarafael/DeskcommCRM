/**
 * Unit do `scripts/ativar-gate-elegibilidade-ia.ts` — as peças puras
 * (`scripts/lib/gate-ativacao.ts`), com um `pg.Pool` falso.
 *
 * O comportamento com Postgres real (baseline + dados semeados) mora em
 * `tests/invariants/gate-ativacao.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  campanhaPerigosa,
  checkCampanhas,
  checkPlanoDeEscrita,
  checkSchema0203,
  checkDenyByDefault,
  type ConsultaPg,
  type CtxAtivacao,
} from "./lib/gate-ativacao";
import type { CampanhaWhatsapp } from "../lib/ai/elegibilidade/campanha";

const DIA = 86_400_000;

function camp(over: Partial<CampanhaWhatsapp> & { valor: string; tipo?: "contains" | "starts_with" }): CampanhaWhatsapp {
  return {
    id: over.id ?? "c1",
    match: { tipo: over.tipo ?? "contains", valor: over.valor },
    ...(over.channel_session_id ? { channel_session_id: over.channel_session_id } : {}),
  };
}

describe("campanhaPerigosa", () => {
  it("frase específica e longa → segura", () => {
    expect(campanhaPerigosa(camp({ valor: "Quero saber mais sobre marketing para incorporadoras" }))).toBeNull();
  });
  it("'contains' com frase curta → perigosa", () => {
    expect(campanhaPerigosa(camp({ valor: "bom dia" }))).toMatch(/casa conversa comum/);
  });
  it("'contains' com só 2 palavras → perigosa", () => {
    expect(campanhaPerigosa(camp({ valor: "quero orçamento" }))).toMatch(/palavra/);
  });
  it("'contains' longa mas toda de palavras genéricas → perigosa", () => {
    expect(campanhaPerigosa(camp({ valor: "quero saber mais informações sobre orçamento" }))).toMatch(/genéricas/);
  });
  it("'starts_with' com prefixo específico → segura", () => {
    expect(campanhaPerigosa(camp({ tipo: "starts_with", valor: "Campanha Meta Incorporadoras 2026" }))).toBeNull();
  });
  it("'starts_with' com prefixo curto → perigosa", () => {
    expect(campanhaPerigosa(camp({ tipo: "starts_with", valor: "oi tudo" }))).toMatch(/prefixo de/);
  });
});

// ── pool falso ────────────────────────────────────────────────────────────

function poolFake(rotas: Array<{ casa: RegExp; rows: Array<Record<string, unknown>> }>): ConsultaPg {
  return {
    query: async (texto: string) => {
      for (const r of rotas) if (r.casa.test(texto)) return { rows: r.rows };
      return { rows: [] };
    },
  };
}

function ctx(pool: ConsultaPg, over: Partial<CtxAtivacao> = {}): CtxAtivacao {
  return {
    pool,
    organizationId: "org-1",
    channelSessionId: "chan-1",
    channelMetadata: {},
    raiz: "/nao-existe",
    ttlMs: 21 * DIA,
    alvoModo: "allowlist",
    rollback: false,
    opcoes: { permitirSemAgente: false, campanhasPerigosasOk: false, tamAmostra: 25 },
    ...over,
  };
}

describe("checkSchema0203", () => {
  it("colunas ausentes → FAIL", async () => {
    const r = await checkSchema0203(ctx(poolFake([{ casa: /information_schema/, rows: [] }])));
    expect(r.status).toBe("FAIL");
    expect(r.detalhe).toMatch(/migration 0203/);
  });
  it("colunas certas → PASS", async () => {
    const r = await checkSchema0203(
      ctx(
        poolFake([
          {
            casa: /information_schema/,
            rows: [
              { column_name: "ai_authorized_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
              { column_name: "ai_authorized_reason", data_type: "text", is_nullable: "YES", column_default: null },
            ],
          },
        ]),
      ),
    );
    expect(r.status).toBe("PASS");
  });
  it("coluna com NOT NULL ou default → FAIL", async () => {
    const r = await checkSchema0203(
      ctx(
        poolFake([
          {
            casa: /information_schema/,
            rows: [
              { column_name: "ai_authorized_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
              { column_name: "ai_authorized_reason", data_type: "text", is_nullable: "YES", column_default: null },
            ],
          },
        ]),
      ),
    );
    expect(r.status).toBe("FAIL");
  });
});

describe("checkCampanhas", () => {
  const rota = (c: unknown) => poolFake([{ casa: /campanhas_whatsapp/, rows: [{ c }] }]);
  it("sem campanhas → INFO (não bloqueia)", async () => {
    expect((await checkCampanhas(ctx(rota(null)))).status).toBe("INFO");
  });
  it("campanha genérica → FAIL", async () => {
    const r = await checkCampanhas(ctx(rota([{ id: "x", match: { tipo: "contains", valor: "bom dia" } }])));
    expect(r.status).toBe("FAIL");
  });
  it("campanha genérica + flag → WARN", async () => {
    const r = await checkCampanhas(
      ctx(rota([{ id: "x", match: { tipo: "contains", valor: "bom dia" } }]), {
        opcoes: { permitirSemAgente: false, campanhasPerigosasOk: true, tamAmostra: 25 },
      }),
    );
    expect(r.status).toBe("WARN");
  });
  it("campanha genérica presa a OUTRO canal → não bloqueia este", async () => {
    // `channel_session_id` precisa de UUID válido e `match.valor` de >= 3 chars
    // (schema Zod) — senão a entrada é DESCARTADA e vira WARN de "inválida",
    // não o cenário que se quer testar. "bom dia" é genérica (perigosa) mas
    // presa a outro canal, então não deve bloquear ESTE.
    const r = await checkCampanhas(
      ctx(rota([{ id: "x", channel_session_id: "00000000-0000-4000-8000-0000000000ff", match: { tipo: "contains", valor: "bom dia" } }])),
    );
    expect(r.status).toBe("PASS");
  });
  it("campanha específica → PASS", async () => {
    const r = await checkCampanhas(
      ctx(rota([{ id: "incorp", match: { tipo: "contains", valor: "marketing para incorporadoras premium" } }])),
    );
    expect(r.status).toBe("PASS");
  });
  it("valor não-array → FAIL", async () => {
    expect((await checkCampanhas(ctx(rota({ foo: 1 })))).status).toBe("FAIL");
  });
});

describe("checkPlanoDeEscrita", () => {
  it("descreve a única escrita e afirma que NÃO toca contacts", () => {
    const r = checkPlanoDeEscrita(ctx(poolFake([]), { channelMetadata: {} }));
    expect(r.linhas?.join("\n")).toMatch(/update channel_sessions/);
    expect(r.linhas?.join("\n")).toMatch(/ZERO autorização em massa/);
    expect(r.linhas?.join("\n")).not.toMatch(/update contacts/);
  });
  it("gate já em allowlist → WARN (no-op)", () => {
    const r = checkPlanoDeEscrita(ctx(poolFake([]), { channelMetadata: { ai_gate: "allowlist" } }));
    expect(r.status).toBe("WARN");
  });
});

describe("checkDenyByDefault", () => {
  it("autorização rebelde (reason fora do vocabulário) → FAIL", async () => {
    const r = await checkDenyByDefault(ctx(poolFake([{ casa: /count\(\*\)/, rows: [{ n: 3 }] }])));
    expect(r.status).toBe("FAIL");
    expect(r.detalhe).toMatch(/fora do produto/);
  });
  it("contato antigo sem autorização → não autorizado, PASS", async () => {
    const r = await checkDenyByDefault(
      ctx(
        poolFake([
          { casa: /count\(\*\)/, rows: [{ n: 0 }] },
          {
            casa: /order by ct\.created_at/,
            rows: [
              { id: "velho", created_at: "2024-01-01T00:00:00Z", ai_authorized_at: null, force_human: false, assignee_kind: "ai", bot_silenced_until: null },
            ],
          },
        ]),
      ),
    );
    expect(r.status).toBe("PASS");
    expect(r.linhas?.join("\n")).toMatch(/contato velho.*não autorizado \(sem_autorizacao\)/);
    expect(r.linhas?.join("\n")).not.toMatch(/AUTORIZADO\?!/);
  });
});
