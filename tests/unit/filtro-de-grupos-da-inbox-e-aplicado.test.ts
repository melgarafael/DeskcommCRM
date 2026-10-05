/**
 * #2103 — a aba "Grupos" do inbox está vazia: onde a cadeia QUEBRA?
 *
 * A cadeia tem quatro elos, e só dois tinham cerca (`schema` e
 * `rota-le-todo-filtro-do-schema`). Este arquivo prende os DOIS últimos:
 * o schema entrega `"true"` (string) e o handler transforma em
 * `.eq("is_group", true)` (booleano do banco).
 *
 * O dublê APLICA os predicados capturados, como o PostgREST aplicaria — sem
 * isto um `.eq("is_group", …)` que nunca chegasse a ser chamado passaria
 * em silêncio, que é exatamente o defeito que a issue relata.
 *
 * Medido em 2026-10-03: os quatro casos abaixo passam — o filtro em si NÃO é
 * a causa da aba vazia (ver "O que medi" no PR #2200).
 */
import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { listConversationsQuerySchema } from "@/lib/schemas";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "55555555-5555-4555-8555-555555555555";

interface Linha extends Record<string, unknown> {
  id: string;
}

/** Banco em memória: aplica eq/in/is/gt/lt, como o PostgREST. */
function bancoDeLista(rows: Linha[]) {
  const aplicados: Record<string, unknown[]> = {};
  let dados = rows;
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    order: () => cadeia,
    limit: () => cadeia,
    eq: (col: string, val: unknown) => {
      (aplicados[`eq:${col}`] ??= []).push(val);
      dados = dados.filter((r) => r[col] === val);
      return cadeia;
    },
    in: (col: string, vals: unknown[]) => {
      (aplicados[`in:${col}`] ??= []).push(vals);
      dados = dados.filter((r) => vals.includes(r[col]));
      return cadeia;
    },
    is: (col: string, val: unknown) => {
      (aplicados[`is:${col}`] ??= []).push(val);
      dados = dados.filter((r) => (val === null ? r[col] === null : r[col] === val));
      return cadeia;
    },
    gt: (col: string, val: unknown) => {
      (aplicados[`gt:${col}`] ??= []).push(val);
      dados = dados.filter((r) => (r[col] as number) > (val as number));
      return cadeia;
    },
    lt: (col: string, val: unknown) => {
      (aplicados[`lt:${col}`] ??= []).push(val);
      dados = dados.filter((r) => (r[col] as number) < (val as number));
      return cadeia;
    },
    not: () => cadeia,
    or: (expr: string) => {
      (aplicados["or"] ??= []).push(expr);
      return cadeia;
    },
    ilike: () => cadeia,
    then: (
      resolve: (v: { data: unknown; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve({ data: dados, error: null }).then(resolve, reject),
  };
  const supabase = {
    from: () => cadeia,
  } as never;
  return { supabase, aplicados, resultado: () => dados };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "req-1",
};

/** Monta o objeto EXATAMENTE como `route.ts` monta antes do `safeParse`. */
function montarQ(params: Record<string, string>) {
  const url = new URL("http://x/api/v1/conversations");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return listConversationsQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    exclude_finished: url.searchParams.get("exclude_finished") === "true" ? true : undefined,
    assigned_to: url.searchParams.get("assigned_to") ?? undefined,
    comando: url.searchParams.get("comando") ?? undefined,
    tag: url.searchParams.getAll("tag"),
    modo: url.searchParams.get("modo") ?? undefined,
    unread: url.searchParams.get("unread") ?? undefined,
    channel_session_id: url.searchParams.get("channel_session_id") ?? undefined,
    is_group: url.searchParams.get("is_group") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
}

const FIXTURE: Linha[] = [
  { id: "grupo-1", organization_id: ORG, is_group: true, group_chat_id: "1@g.us", contact_id: "ct-g", status: "open", comando_da_conversa: "aguardando", last_message_at: "2026-10-01T00:00:00Z", awaiting_since: "2026-10-01T00:00:00Z" },
  { id: "pessoa-1", organization_id: ORG, is_group: false, group_chat_id: null, contact_id: "ct-p", status: "open", comando_da_conversa: "aguardando", last_message_at: "2026-10-02T00:00:00Z", awaiting_since: "2026-10-02T00:00:00Z" },
];

describe("a cadeia do filtro is_group (#2103)", () => {
  it('o schema entrega `is_group` como STRING "true" (o handler compara com string)', () => {
    const parsed = montarQ({ is_group: "true", limit: "50" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.is_group).toBe("true");
  });

  it("aba Grupos na FILA: devolve só conversas de grupo", async () => {
    const parsed = montarQ({ is_group: "true", comando: "aguardando", limit: "50" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { supabase } = bancoDeLista(FIXTURE.map((r) => ({ ...r })));
    const r = await listConversationsHandler(supabase, ctx, parsed.data);
    expect(r.conversations.map((c) => c.id)).toEqual(["grupo-1"]);
  });

  it("aba Grupos em TODAS: devolve só conversas de grupo", async () => {
    const parsed = montarQ({ is_group: "true", limit: "50" });
    if (!parsed.success) throw new Error("parse falhou");
    const { supabase } = bancoDeLista(FIXTURE.map((r) => ({ ...r })));
    const r = await listConversationsHandler(supabase, ctx, parsed.data);
    expect(r.conversations.map((c) => c.id)).toEqual(["grupo-1"]);
  });

  it("sem grupo na base: lista vazia, sem erro", async () => {
    const parsed = montarQ({ is_group: "true", limit: "50" });
    if (!parsed.success) throw new Error("parse falhou");
    const { supabase } = bancoDeLista(FIXTURE.filter((r) => r.is_group === false).map((r) => ({ ...r })));
    const r = await listConversationsHandler(supabase, ctx, parsed.data);
    expect(r.conversations).toEqual([]);
  });

  it("sem filtro is_group: continua mostrando todo mundo", async () => {
    const parsed = montarQ({ limit: "50" });
    if (!parsed.success) throw new Error("parse falhou");
    const { supabase } = bancoDeLista(FIXTURE.map((r) => ({ ...r })));
    const r = await listConversationsHandler(supabase, ctx, parsed.data);
    expect(r.conversations.map((c) => c.id).sort()).toEqual(["grupo-1", "pessoa-1"]);
  });
});
