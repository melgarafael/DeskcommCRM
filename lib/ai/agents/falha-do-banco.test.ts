/**
 * A régua do "é o banco?" — e, principalmente, os casos em que ela tem de DIZER
 * que não sabe (#4020).
 *
 * O custo de um falso positivo é o defeito que a issue descreve de novo, só que
 * com o sinal trocado: em vez de mandar a pessoa conferir credencial por causa
 * de um timeout de banco, a tela diria "é o banco" para um 401 do provedor ou
 * para um `fetch failed` que ninguém sabe de quem é. Por isso metade dos casos
 * abaixo é de recusa.
 */
import { describe, expect, it } from "vitest";

import { ehFalhaDoBanco } from "./falha-do-banco";

describe("ehFalhaDoBanco", () => {
  it("reconhece o erro que a issue mediu: query_timeout do pg, sem `code`", () => {
    expect(ehFalhaDoBanco(new Error("Query read timeout"))).toBe(true);
  });

  it("reconhece o socket derrubado e o pooler saturado", () => {
    expect(ehFalhaDoBanco(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(ehFalhaDoBanco(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(ehFalhaDoBanco(new Error("sorry, too many clients already"))).toBe(true);
    expect(ehFalhaDoBanco(new Error("the database system is starting up"))).toBe(true);
  });

  it("reconhece o pool do engine sem endereço (não há banco para responder)", () => {
    expect(ehFalhaDoBanco(new Error("SUPABASE_DB_URL ausente — rascunho da IA indisponível"))).toBe(
      true,
    );
  });

  it("reconhece SQLSTATE de 'não consegui atender agora'", () => {
    // conexão (08), rollback de transação (40), recurso (53), intervenção do
    // operador (57 — é aqui que mora o 57014), erro de sistema (58).
    for (const code of ["08006", "08003", "40001", "40P01", "53300", "57014", "57P01", "58000"]) {
      expect(ehFalhaDoBanco(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("NÃO acusa banco em erro de dado ou de integridade — ali o banco respondeu", () => {
    for (const code of ["23505", "23514", "22001", "42P01", "P0001"]) {
      expect(ehFalhaDoBanco(Object.assign(new Error("x"), { code }))).toBe(false);
    }
  });

  it("NÃO acusa banco em erro de rede ambíguo — o mesmo código aparece no provedor", () => {
    // `ECONNREFUSED`/`ETIMEDOUT`/`fetch failed` são a marca de QUALQUER vizinho
    // fora do ar, inclusive o provedor de IA. Dizer "banco" aqui seria trocar
    // uma acusação errada por outra.
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(
        ehFalhaDoBanco(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code })),
      ).toBe(false);
    }
    expect(ehFalhaDoBanco(new TypeError("fetch failed"))).toBe(false);
  });

  it("NÃO acusa banco só porque a mensagem fala em timeout", () => {
    expect(ehFalhaDoBanco(new Error("request timed out after 30000ms"))).toBe(false);
    expect(
      ehFalhaDoBanco(
        Object.assign(new Error("401 Unauthorized: invalid api key"), { statusCode: 401 }),
      ),
    ).toBe(false);
    expect(ehFalhaDoBanco(new Error("modelo não habilitado para a org (enabled_models): x"))).toBe(
      false,
    );
  });

  it("indefinido não acusa: sem mensagem ou sem erro, é `false`", () => {
    expect(ehFalhaDoBanco(undefined)).toBe(false);
    expect(ehFalhaDoBanco(null)).toBe(false);
    expect(ehFalhaDoBanco(new Error(""))).toBe(false);
    expect(ehFalhaDoBanco({})).toBe(false);
  });
});
