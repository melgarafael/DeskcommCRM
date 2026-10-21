/**
 * A contagem de condições que a tela de operação mostra (#2727).
 *
 * `semConfig` contava `conditions.length` — e o formato novo guarda um grupo
 * `{any:[…]}` em `conditions`, que é OBJETO e não tem comprimento. A regra
 * "qualquer uma" com duas condições aparecia como ZERO condição: quem decide
 * ligar ou desligar uma regra lia "sem condições" numa regra que filtra.
 *
 * O teste roda o `listarRegrasAutomaticas` DE VERDADE, com um banco falso que
 * devolve as linhas: o que se prende aqui é a contagem que a função produz, não
 * um helper isolado.
 */
import { describe, expect, it } from "vitest";

import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";

import { listarRegrasAutomaticas } from "./regras-automaticas";

/** A cadeia do PostgREST que `listarRegrasAutomaticas` percorre, até o `await`. */
function bancoCom(linhas: Array<Record<string, unknown>>): DepsDaOperacao["supabase"] {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    order: () => cadeia,
    then: (resolver: (valor: unknown) => unknown) =>
      Promise.resolve({ data: linhas, error: null }).then(resolver),
  };
  return { from: () => cadeia } as unknown as DepsDaOperacao["supabase"];
}

const deps = (linhas: Array<Record<string, unknown>>) =>
  ({
    supabase: bancoCom(linhas),
    organizationId: "org-1",
    actor: { type: "user", id: "u-1" },
    requestId: "req-1",
  }) as unknown as DepsDaOperacao;

const REGRA = (conditions: unknown) => ({
  id: "r1",
  name: "Regra 1",
  is_active: true,
  trigger_event: "lead.created",
  conditions,
  actions: [{ type: "add_tag" }],
  last_run_at: null,
  run_count: 0,
  last_change_actor_kind: null,
  last_change_at: null,
});

const contagem = async (conditions: unknown) => {
  const regras = await listarRegrasAutomaticas(deps([REGRA(conditions)]));
  return regras[0]!.quantidade_de_condicoes;
};

describe("quantidade_de_condicoes (#2727)", () => {
  it("conta a lista simples como sempre contou", async () => {
    expect(await contagem([])).toBe(0);
    expect(await contagem([{ field: "a", op: "eq", value: "1" }])).toBe(1);
  });

  it("conta 2 num grupo `{any:[…]}` — antes devolvia 0", async () => {
    expect(
      await contagem({
        any: [
          { field: "a", op: "eq", value: "1" },
          { field: "b", op: "gte", value: "5" },
        ],
      }),
    ).toBe(2);
  });

  it("conta as folhas de um grupo `{all:[…]}`", async () => {
    expect(
      await contagem({
        all: [
          { field: "a", op: "is_empty", value: "" },
          { field: "b", op: "eq", value: "2" },
          { field: "c", op: "eq", value: "3" },
        ],
      }),
    ).toBe(3);
  });

  it("o que não é lista nem grupo conta 0, sem estourar a listagem", async () => {
    expect(await contagem(null)).toBe(0);
    expect(await contagem(undefined)).toBe(0);
    expect(await contagem("lixo")).toBe(0);
  });
});
