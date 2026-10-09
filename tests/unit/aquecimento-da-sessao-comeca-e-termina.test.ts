import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

/**
 * `warmup_started_at` NUNCA TEVE ESCRITOR — e sem ele `is_warmup_complete` é
 * uma constante `false` em toda instalação real (#2432).
 *
 * ─── A corrente quebrada ────────────────────────────────────────────────────
 *
 * `is_warmup_complete` é `GENERATED ALWAYS AS (warmup_completed_at IS NOT
 * NULL)`, e o único escritor de `warmup_completed_at` em produção fica em
 * `handleSessionStatus` atrás de
 *
 *     status === "WORKING" && session.warmup_started_at && !is_warmup_complete
 *
 * — cuja segunda metade só é verdadeira se alguém já tiver gravado
 * `warmup_started_at`. A spec 03 descreveu esse escritor
 * (`docs/specs/03-spec-whatsapp-waha.md:936-938`, "gravar `warmup_started_at`
 * na primeira transição para `WORKING`") e ele nunca foi implementado: quem lê
 * a coluna decide com um dado que nunca muda.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que a PRIMEIRA `WORKING` grave o início do aquecimento; que nenhum outro
 * status grave; que a mesma `WORKING` que começa NÃO conclua (começar e
 * terminar são dois eventos); que, com o escritor no lugar, `is_warmup_complete`
 * vira `true` quando o aquecimento termina — e que NINGUÉM atribua a coluna
 * gerada, porque atribuir aborta o UPDATE INTEIRO, inclusive o `status`.
 *
 * O evento entra por `dispatchWahaEvent` — o mesmo roteador que a rota do
 * webhook chama — e o que se afirma é o UPDATE gravado numa
 * `channel_sessions` de mentira, com a flag derivada da mesma forma que o
 * Postgres deriva a coluna gerada. Um teste que lesse o fonte provaria o
 * texto, não o caminho.
 */

/** Toda escrita que o caminho de produção fez, para conferir o payload. */
interface Escrita {
  tabela: string;
  op: string;
  payload?: unknown;
}
const escritas: Escrita[] = [];

/**
 * A linha de `channel_sessions`. As escritas do caminho são APLICADAS nela, e
 * `sessaoDaRota()` a devolve como a rota devolve do banco — é assim que o
 * segundo evento enxerga o que o primeiro gravou.
 */
const linha: Record<string, unknown> = {
  id: "sess-1",
  organization_id: "org-1",
  status: "STARTING",
  warmup_started_at: null,
  warmup_completed_at: null,
  display_name: "Vendas",
  phone_number: null,
};

/** É assim que o Postgres calcula `is_warmup_complete` — derivada, nunca gravada. */
function derivarFlagGerada(): void {
  linha.is_warmup_complete = linha.warmup_completed_at !== null;
}

function reiniciar(): void {
  escritas.length = 0;
  linha.status = "STARTING";
  linha.warmup_started_at = null;
  linha.warmup_completed_at = null;
  linha.display_name = "Vendas";
  linha.phone_number = null;
  derivarFlagGerada();
}

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  escritas.push({ tabela, op, payload });
  if (tabela === "channel_sessions" && op === "update" && payload && typeof payload === "object") {
    Object.assign(linha, payload);
    derivarFlagGerada();
  }
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_alvo, prop) {
        if (prop === "maybeSingle")
          return async () => ({ data: { ...linha, escalated_status: null }, error: null });
        if (prop === "then")
          return (ok: (v: unknown) => unknown) => ok({ data: null, error: null });
        return () => proxy;
      },
    },
  );
  return proxy;
}

const admin = {
  from: (tabela: string) => ({
    select: () => chain(tabela, "select"),
    update: (payload: unknown) => chain(tabela, "update", payload),
    insert: (payload: unknown) => chain(tabela, "insert", payload),
    upsert: (payload: unknown) => chain(tabela, "upsert", payload),
  }),
  rpc: async () => ({ data: null, error: null }),
} as never;

/** A sessão COMO A ROTA LÊ — do banco, não o objeto que o evento anterior gravou. */
function sessaoDaRota(): never {
  return { ...linha } as never;
}

function envelope(status: string): WahaEnvelope {
  return { event: "session.status", session: "default", payload: { status } };
}

async function despacha(status: string): Promise<void> {
  await dispatchWahaEvent(admin, sessaoDaRota(), envelope(status), `req-${status}`);
}

describe("o escritor de warmup_started_at (#2432)", () => {
  it("a primeira WORKING grava o início do aquecimento", async () => {
    reiniciar();
    await despacha("WORKING");

    expect(
      linha.warmup_started_at,
      "warmup_started_at continua null: a spec 03 manda gravar na primeira transição " +
        "para WORKING e nenhum código de produção grava esta coluna",
    ).toEqual(expect.any(String));
    expect(
      escritas.some((e) => e.tabela === "channel_sessions" && e.op === "update"),
      "o UPDATE de channel_sessions nem saiu",
    ).toBe(true);
  });

  it("nenhum outro status grava o início — é a PRIMEIRA transição para WORKING", async () => {
    reiniciar();
    for (const status of ["STARTING", "SCAN_QR_CODE", "STOPPED", "FAILED"]) {
      await despacha(status);
    }

    expect(
      linha.warmup_started_at,
      "grava o início do aquecimento num status que não é WORKING",
    ).toBeNull();
    expect(
      linha.is_warmup_complete,
      "conclui um aquecimento que não começou",
    ).toBe(false);
  });

  it("a mesma WORKING que começa NÃO conclui — começar e terminar são dois eventos", async () => {
    reiniciar();
    await despacha("WORKING");

    expect(linha.warmup_completed_at, "conclui o aquecimento no evento que o começou").toBeNull();
    expect(linha.is_warmup_complete, "a flag virou true junto com o início").toBe(false);
  });

  it("quando o aquecimento termina, is_warmup_complete vira true", async () => {
    reiniciar();
    // O aquecimento COMEÇA na primeira transição para WORKING…
    await despacha("WORKING");
    // …e TERMINA quando a sessão reporta WORKING de novo com o aquecimento já
    // iniciado — é o critério do próprio guard (o mesmo que o invariante
    // `triagem194-defeitos-alegados` exercita com `warmup_started_at` preenchido).
    await despacha("WORKING");

    expect(
      linha.warmup_completed_at,
      "warmup_completed_at nunca é gravado — é por isso que a flag é constante false",
    ).toEqual(expect.any(String));
    expect(
      linha.is_warmup_complete,
      "sem o escritor de warmup_started_at o guard nunca fica verdadeiro e a flag " +
        "permanece false para sempre",
    ).toBe(true);
  });

  it("ninguém atribui a coluna gerada — atribuir aborta o UPDATE INTEIRO", async () => {
    reiniciar();
    await despacha("WORKING");
    await despacha("WORKING");

    const atribuemAGerada = escritas.filter(
      (e) =>
        e.tabela === "channel_sessions" &&
        e.op === "update" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        "is_warmup_complete" in e.payload,
    );

    expect(
      atribuemAGerada,
      "atribuir is_warmup_complete aborta o UPDATE inteiro — inclusive o status, que " +
        "nada tem a ver com o aquecimento, e o espelho do canal congela sem erro visível",
    ).toHaveLength(0);
  });
});
