/**
 * O dono da carteira na importação (A23 parte 2, #4888): só os contatos CRIADOS
 * pelo lote entram na carteira, pela porta única (`fn_definir_carteira_do_cliente`),
 * com a origem `importacao` e o ator passado de fora.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { definirCarteiraDoLote } from "./import-carteira";

const ORG = "22222222-2222-4222-8222-222222222222";
const LOTE = "33333333-3333-4333-8333-333333333333";
const ATOR = "11111111-1111-4111-8111-111111111111";
const DONO = "44444444-4444-4444-8444-444444444444";

function admin(opcoes: { ids?: string[]; erroDeLeitura?: boolean; recusas?: Set<string> } = {}) {
  const filtros: Array<[string, unknown]> = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const consulta = {
    select: () => consulta,
    eq: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return consulta;
    },
    is: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return Promise.resolve(
        opcoes.erroDeLeitura
          ? { data: null, error: { message: "falhou" } }
          : { data: (opcoes.ids ?? []).map((id) => ({ id })), error: null },
      );
    },
  };
  const cliente = {
    from: () => consulta,
    rpc: vi.fn(async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      return { error: opcoes.recusas?.has(args.p_contact as string) ? { message: "carteira_fora_da_posse" } : null };
    }),
  } as unknown as SupabaseClient;
  return { cliente, filtros, rpcs };
}

describe("definirCarteiraDoLote", () => {
  it("lê só os contatos criados por este lote e sem dono, na organização do chamador", async () => {
    const { cliente, filtros } = admin({ ids: [] });
    await definirCarteiraDoLote(cliente, { organizationId: ORG, batchId: LOTE, atorId: ATOR, donoId: DONO });
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["source", "import_csv"],
        ["created_by_user_id", ATOR],
        ["source_metadata->>import_batch_id", LOTE],
        ["carteira_user_id", null],
      ]),
    );
  });

  it("passa cada contato pela porta única, com o ator, o dono e a origem importacao", async () => {
    const { cliente, rpcs } = admin({ ids: ["c1", "c2", "c3"] });
    const r = await definirCarteiraDoLote(cliente, { organizationId: ORG, batchId: LOTE, atorId: ATOR, donoId: DONO });

    expect(r).toEqual({ definidos: 3, falhas: 0 });
    expect(rpcs.map((x) => x.nome)).toEqual(Array(3).fill("fn_definir_carteira_do_cliente"));
    expect(rpcs[0]?.args).toEqual({ p_org: ORG, p_actor: ATOR, p_contact: "c1", p_dono: DONO, p_origem: "importacao" });
  });

  it("uma recusa da função conta como falha e não derruba o resto do lote", async () => {
    const { cliente } = admin({ ids: ["c1", "c2"], recusas: new Set(["c2"]) });
    expect(
      await definirCarteiraDoLote(cliente, { organizationId: ORG, batchId: LOTE, atorId: ATOR, donoId: DONO }),
    ).toEqual({ definidos: 1, falhas: 1 });
  });

  it("falha de leitura devolve falhas = -1 e não chama a função", async () => {
    const { cliente, rpcs } = admin({ erroDeLeitura: true });
    expect(
      await definirCarteiraDoLote(cliente, { organizationId: ORG, batchId: LOTE, atorId: ATOR, donoId: DONO }),
    ).toEqual({ definidos: 0, falhas: -1 });
    expect(rpcs).toEqual([]);
  });
});
