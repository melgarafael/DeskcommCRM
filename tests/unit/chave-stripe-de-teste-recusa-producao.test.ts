import { describe, expect, it } from "vitest";

import { lerChaveStripeDeTeste } from "../e2e/helpers/chave-stripe-de-teste";

const TESTE = "sk_test_51AbCdEfGhIjKlMnOp";
// Montadas em tempo de execução: um literal `sk_live_…`/`rk_live_…` no repositório dispara a varredura de segredo do GitHub no push.
const PRODUCAO = ["sk", "live", "51AbCdEfGhIjKlMnOp"].join("_");
const RESTRITA_DE_PRODUCAO = ["rk", "live", "51AbCdEfGhIjKlMnOp"].join("_");

describe("a chave do teste de verdade é SEMPRE de teste", () => {
  it("ausente pula (o placar diz skipped)", () => expect(lerChaveStripeDeTeste(undefined)).toEqual({ tipo: "ausente" }));
  it("sk_test_ e rk_test_ passam, sem espaços", () => {
    expect(lerChaveStripeDeTeste(` ${TESTE} `)).toEqual({ tipo: "teste", chave: TESTE });
    expect(lerChaveStripeDeTeste("rk_test_51AbCdEfGhIjKl")).toEqual({ tipo: "teste", chave: "rk_test_51AbCdEfGhIjKl" });
  });
  it.each([PRODUCAO, RESTRITA_DE_PRODUCAO])("%s é recusada, e a mensagem não repete a chave", (chave) => {
    expect(() => lerChaveStripeDeTeste(chave)).toThrow(/PRODUÇÃO recusada/);
    try { lerChaveStripeDeTeste(chave); } catch (e) { expect(String(e)).not.toContain(chave); }
  });
  it("forma estranha é recusada", () => expect(() => lerChaveStripeDeTeste("pk_test_51AbCdEfGhIjKl")).toThrow(/forma/));
});
