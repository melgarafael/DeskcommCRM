/**
 * DOIS DRENOS NA MESMA LINHA NÃO RODAM O MESMO HANDLER DUAS VEZES.
 *
 * A intercalação que o revisor do PR #2337 reproduziu:
 *
 *   1. o laço do worker LÊ o lote (com o `consumed_by` daquele instante);
 *   2. o webhook roda o dreno escopado: reclama a mesma linha, roda o
 *      gatilho-retorno e a devolve a `pending` com o `consumed_by` acrescido;
 *   3. o worker faz o claim — passa, porque a linha está `pending` de novo;
 *   4. o despacho filtrava pelo `consumed_by` da leitura do passo 1 e rodava o
 *      gatilho outra vez: a mensagem proativa do "cliente voltou" saía em dobro.
 *
 * Drain e dispatcher REAIS; só o banco é uma tabela em memória que aplica os
 * filtros do PostgREST que o dreno usa. O mesmo vale para dois escopados
 * concorrentes (duas mensagens da mesma organização ao mesmo tempo).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));

import { registerHandler } from "@/lib/event-log/dispatcher";
import { drainEventLog, type EscopoDoDreno } from "@/lib/event-log/drain";

type Linha = Record<string, unknown>;
type Filtro = (l: Linha) => boolean;

/** `next_attempt_at.is.null,next_attempt_at.lte.<iso>` — a única `or` do dreno. */
function filtroOr(expr: string): Filtro {
  const partes = expr.split(",").map((p) => p.split("."));
  return (l) =>
    partes.some(([col, op, ...resto]) => {
      const v = resto.join(".");
      if (op === "is" && v === "null") return l[col!] == null;
      if (op === "lte") return l[col!] != null && String(l[col!]) <= v;
      throw new Error(`or não suportado: ${expr}`);
    });
}

/**
 * Fachada PostgREST sobre `tabelas`. `antesDoClaim` roda uma vez, logo antes do
 * primeiro claim (`update status=processing`) desta fachada — é onde o outro
 * dreno se intromete.
 */
function banco(tabelas: Record<string, Linha[]>, antesDoClaim?: () => Promise<unknown>) {
  let intromissao = antesDoClaim;
  function from(tabela: string) {
    const filtros: Filtro[] = [];
    let patch: Linha | null = null;
    let colunas: string | null = null;
    let ordem: { col: string; asc: boolean } | null = null;
    let teto = Infinity;
    const q: Record<string, unknown> = {
      select: (c: string) => ((colunas = c), q),
      update: (p: Linha) => ((patch = p), q),
      insert: async () => ({ data: null, error: null }),
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      lt: (c: string, v: unknown) => (filtros.push((l) => String(l[c]) < String(v)), q),
      in: (c: string, v: unknown[]) => (filtros.push((l) => v.includes(l[c])), q),
      or: (expr: string) => (filtros.push(filtroOr(expr)), q),
      order: (col: string, o: { ascending: boolean }) => ((ordem = { col, asc: o.ascending }), q),
      limit: (n: number) => ((teto = n), q),
      maybeSingle: async () => ({ data: null, error: null }),
      then: async (resolve: (r: unknown) => void) => {
        if (patch?.status === "processing" && intromissao) {
          const vez = intromissao;
          intromissao = undefined;
          await vez();
        }
        let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (patch) for (const l of linhas) Object.assign(l, patch);
        if (ordem) {
          const { col, asc } = ordem;
          linhas = [...linhas].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        const pick = (l: Linha) =>
          colunas
            ? Object.fromEntries(colunas.split(",").map((c) => [c.trim(), structuredClone(l[c.trim()])]))
            : structuredClone(l);
        resolve({ data: linhas.slice(0, teto).map(pick), error: null });
      },
    };
    return q;
  }
  return { from } as never;
}

const RETORNO = "followup-gatilho-retorno.v1";
const rodadas: Record<string, number> = {};

beforeAll(() => {
  for (const key of [RETORNO, "ai-sentiment.v1"]) {
    registerHandler({
      key,
      naOrgParada: "roda",
      events: ["message.received"],
      async handle() {
        rodadas[key] = (rodadas[key] ?? 0) + 1;
        return { consumer_key: key, status: "ok" };
      },
    });
  }
});

const ESCOPO: EscopoDoDreno = { organizationId: "org-1", handlers: [RETORNO] };

function cenario() {
  for (const k of Object.keys(rodadas)) delete rodadas[k];
  return {
    event_log: [
      {
        id: "e1",
        organization_id: "org-1",
        event_type: "message.received",
        entity_kind: "message",
        entity_id: "msg-1",
        payload: { contact_id: "contato-1" },
        metadata: {},
        consumed_by: [] as string[],
        attempts: 0,
        status: "pending",
        next_attempt_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    organizations: [{ id: "org-1", status: "active" }],
  };
}

describe("dreno que leu antes de outro dreno soltar a linha", () => {
  it.each([
    ["o laço do worker (global)", undefined],
    ["outro dreno escopado", ESCOPO],
  ])("%s não roda de novo o gatilho que o escopado já rodou", async (_nome, escopoDoAtrasado) => {
    const tabelas = cenario();
    const webhook = banco(tabelas);
    const atrasado = banco(tabelas, () => drainEventLog(webhook, { escopo: ESCOPO }));

    await drainEventLog(atrasado, { escopo: escopoDoAtrasado });

    expect(rodadas[RETORNO], "o gatilho-retorno rodou em dobro para o mesmo evento").toBe(1);
    const [linha] = tabelas.event_log;
    expect(linha!.consumed_by).toContain(RETORNO);
    if (!escopoDoAtrasado) {
      expect(rodadas["ai-sentiment.v1"]).toBe(1);
      expect(linha!.status).toBe("done");
    }
  });
});
