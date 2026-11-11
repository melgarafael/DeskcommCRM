import { describe, expect, it } from "vitest";

import { recusaDaChamada, rotuloDaRecusa } from "../../lib/mcp/desfecho-da-chamada";

/**
 * O INVENTÁRIO DE FORMATOS DE RECUSA (#4342 / #4343), por leitura do catálogo.
 *
 * As tools do MCP recusam em mais de um formato — e cada ingresso conhecia um
 * deles só. Esta tabela é o contrato: um formato novo que apareça no catálogo
 * e não esteja aqui volta a ser auditado como sucesso.
 */
describe("recusaDaChamada — os formatos do catálogo", () => {
  it("`{ erro, mensagem }` (dados externos, receitas, conhecimento)", () => {
    expect(
      recusaDaChamada({ erro: "sem_destino", mensagem: "nenhum funil nesta receita." }),
    ).toEqual({ codigo: "sem_destino", mensagem: "nenhum funil nesta receita.", origem: "erro" });
  });

  it("`{ erro }` sem mensagem usa o próprio código como texto", () => {
    expect(recusaDaChamada({ erro: "tabela_nao_encontrada" })).toEqual({
      codigo: "tabela_nao_encontrada",
      mensagem: "tabela_nao_encontrada",
      origem: "erro",
    });
  });

  it("`{ permitido: false, motivo }` (escopo de contato e de funil)", () => {
    expect(
      recusaDaChamada({ permitido: false, motivo: "fora_da_conversa", mensagem: "não é seu." }),
    ).toEqual({ codigo: "fora_da_conversa", mensagem: "não é seu.", origem: "permitido" });
  });

  it("`{ error: string }` (o que a ponte devolve ao modelo)", () => {
    expect(recusaDaChamada({ error: "circuit_breaker_same_tool" })).toEqual({
      codigo: "circuit_breaker_same_tool",
      mensagem: "circuit_breaker_same_tool",
      origem: "error",
    });
  });

  it("`{ error: { code, message } }` — guarda o código e a mensagem", () => {
    expect(recusaDaChamada({ ok: false, error: { code: "x", message: "sem canal" } })).toEqual({
      codigo: "x",
      mensagem: "sem canal",
      origem: "error",
    });
  });

  it("`{ ok: false }` (tools nativas do run)", () => {
    expect(recusaDaChamada({ ok: false, motivo: "reabertura_cria_novo" })).toEqual({
      codigo: "reabertura_cria_novo",
      mensagem: "reabertura_cria_novo",
      origem: "ok",
    });
  });

  it("escrita sem desfecho tem código próprio — não é sucesso nem falha comum", () => {
    expect(recusaDaChamada({ error: "prazo", resultado_incerto: true, mensagem: "sem desfecho" })).toEqual({
      codigo: "resultado_incerto",
      mensagem: "sem desfecho",
      origem: "incerto",
    });
  });

  it("texto solto não vira código — `motivo` só recebe código legível por máquina", () => {
    expect(recusaDaChamada({ error: "Negócio não encontrado nesta organização." })).toEqual({
      codigo: null,
      mensagem: "Negócio não encontrado nesta organização.",
      origem: "error",
    });
  });

  describe("sucesso continua sucesso (controle positivo contra vacuidade)", () => {
    it.each([
      { lead: { id: "l1" } },
      { lead: { id: "l1" }, erro: null },
      { ok: true, dados: 42 },
      { erro: "" },
      [1, 2, 3],
      null,
      "texto",
    ])("%j", (resultado) => {
      expect(recusaDaChamada(resultado)).toBeNull();
    });
  });
});

describe("rotuloDaRecusa — o nome que o painel já lê", () => {
  it("recusa de escopo mantém `contato_da_conversa:`", () => {
    expect(
      rotuloDaRecusa({ codigo: "fora_da_conversa", mensagem: "x", origem: "permitido" }),
    ).toBe("contato_da_conversa:fora_da_conversa");
  });

  it("as demais usam `recusa_da_ferramenta:` — sem_destino não é recusa de contato", () => {
    expect(rotuloDaRecusa({ codigo: "sem_destino", mensagem: "x", origem: "erro" })).toBe(
      "recusa_da_ferramenta:sem_destino",
    );
  });

  it("sem código, o rótulo leva a mensagem", () => {
    expect(rotuloDaRecusa({ codigo: null, mensagem: "sem canal", origem: "error" })).toBe(
      "recusa_da_ferramenta:sem canal",
    );
  });
});
