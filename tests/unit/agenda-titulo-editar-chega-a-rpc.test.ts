import { beforeEach, describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * O TÍTULO CHEGA À RPC — e o vazio morre ANTES de qualquer escrita (#3776).
 *
 * ─── O buraco que este arquivo tapa ────────────────────────────────────────
 *
 * A rota valida a FORMA; quem monta o `p_patch` é o handler. Um `title` aceito
 * na rota e esquecido aqui devolveria `200` sem mudar nada — exatamente o
 * "no-op silencioso" que a #3776 descreve do lado da RPC. Os dois testes de
 * rota (`route.test.ts`) usam um dublê de handler e por construção NÃO veem
 * isso; o invariante vê a RPC, mas não o caminho do handler até ela.
 *
 * ─── O que ele mede ────────────────────────────────────────────────────────
 *
 * 1. `title` informado viaja em `p_patch.title`, APARADO, e sozinho — sem
 *    inventar `starts_at`/`status` que ninguém pediu (remarcar é outra coisa);
 * 2. `title` vazio é recusa de negócio com código próprio
 *    (`agenda_titulo_vazio`), ANTES do `rpc` — a guarda tem de impedir a
 *    escrita, não reclamar depois dela;
 * 3. patch sem `title` não põe a chave no `p_patch`: "não mandou" não pode virar
 *    "limpe o título" (o `?` do jsonb na RPC distingue os dois).
 */

const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { ApiError } = await import("@/lib/api/types");

const ORG = "aaaaaaaa-2222-4000-8000-00000000000a";
const AGENDAMENTO = "ffffffff-2222-4000-8000-00000000000f";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "bbbbbbbb-2222-4000-8000-00000000000b", role: "manager" },
  requestId: "req-titulo",
} as unknown as HandlerCtx;

/** O `p_patch` que chegou à RPC — nulo se a RPC não foi chamada. */
let patchDaRpc: Record<string, unknown> | null;
let rpcChamada = 0;

function cliente(): SupabaseClient {
  const linha = {
    id: AGENDAMENTO,
    revision: 1,
    event_type_id: "cccccccc-2222-4000-8000-00000000000c",
    owner_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    contact_id: null,
    title: "Avaliação inicial",
    starts_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    ends_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
    service_occurrence_id: null,
  };
  const leitura = () => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "order", "limit", "in", "is", "not"]) cadeia[m] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: linha, error: null });
    cadeia.single = async () => ({ data: linha, error: null });
    return cadeia;
  };
  return {
    from: () => ({
      select: () => leitura(),
      update: () => {
        const cadeia: Record<string, unknown> = {};
        for (const m of ["eq"]) cadeia[m] = () => cadeia;
        cadeia.select = () => cadeia;
        cadeia.single = async () => ({ data: linha, error: null });
        return cadeia;
      },
      insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "fn_appointment_change") return { data: null, error: null };
      rpcChamada += 1;
      patchDaRpc = args.p_patch as Record<string, unknown>;
      return { data: { ...linha, ...patchDaRpc, revision: 2 }, error: null };
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  patchDaRpc = null;
  rpcChamada = 0;
});

describe("editar só o título chega à RPC (#3776)", () => {
  it("`title` vai em `p_patch.title`, aparado e SOZINHO", async () => {
    const salvo = await alterarAgendamentoHandler(cliente(), ctx, {
      id: AGENDAMENTO,
      title: "  Consulta de retorno  ",
    });

    expect(patchDaRpc).toEqual({ title: "Consulta de retorno" });
    expect(salvo.title).toBe("Consulta de retorno");
  });

  it("`title` vazio é recusa ANTES da escrita — e a RPC não é chamada", async () => {
    const erro = await alterarAgendamentoHandler(cliente(), ctx, {
      id: AGENDAMENTO,
      title: "   ",
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).code).toBe("agenda_titulo_vazio");
    expect((erro as InstanceType<typeof ApiError>).status).toBe(422);
    expect(rpcChamada).toBe(0);
  });

  it("patch sem `title` NÃO põe a chave no `p_patch` — ausente não é vazio", async () => {
    await alterarAgendamentoHandler(cliente(), ctx, {
      id: AGENDAMENTO,
      notes: "anotação interna",
    });

    expect(patchDaRpc).toEqual({ notes: "anotação interna" });
    expect(patchDaRpc).not.toHaveProperty("title");
  });
});
