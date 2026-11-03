import { describe, expect, it } from "vitest";

import {
  modeloServeAoLembrete,
  valoresDoModeloDoLembrete,
  variaveisQueOLembretePreenche,
  type ModeloDoLembrete,
} from "./lembrete-por-modelo";

/**
 * O que o lembrete sabe preencher num modelo aprovado: o corpo, por posição, com
 * primeiro nome, dia e hora, título e endereço. A leitura do contrato é a mesma
 * do pré-voo do envio (`deriveTemplateContract`) — um modelo que este arquivo
 * aceita e o envio recusa seria um lembrete carimbado que nunca chega.
 */
const modelo = (corpo: string, extra: Partial<ModeloDoLembrete> = {}): ModeloDoLembrete => ({
  id: "m1",
  name: "lembrete_da_consulta",
  language: "pt_BR",
  status: "APPROVED",
  channel_session_id: "oficial",
  parameter_format: "POSITIONAL",
  components: [{ type: "BODY", text: corpo }],
  ...extra,
});

const pecas = {
  primeiro_nome: "Ana",
  quando: "quinta-feira, 30/10 às 15:00",
  titulo: "Consulta de retorno",
  endereco: "",
};

describe("valores do lembrete por modelo", () => {
  it("preenche por posição: o nome e o dia e a hora", () => {
    expect(valoresDoModeloDoLembrete(modelo("Oi {{1}}, sua consulta: {{2}}."), pecas)).toEqual({
      valores: { "1": "Ana", "2": "quinta-feira, 30/10 às 15:00" },
      texto: "Oi Ana, sua consulta: quinta-feira, 30/10 às 15:00.",
    });
  });

  it("modelo sem variável sai como está", () => {
    expect(valoresDoModeloDoLembrete(modelo("Lembrete da sua consulta."), pecas)).toEqual({
      valores: {},
      texto: "Lembrete da sua consulta.",
    });
  });

  it("a mesma variável repetida usa o mesmo valor", () => {
    expect(valoresDoModeloDoLembrete(modelo("{{1}}, {{1}}!"), pecas)?.texto).toBe("Ana, Ana!");
  });

  it("peça vazia que o modelo pede: não serve (a plataforma recusa parâmetro vazio)", () => {
    // {{4}} é o endereço, vazio nesta reserva.
    expect(valoresDoModeloDoLembrete(modelo("{{1}} {{2}} {{3}} {{4}}"), pecas)).toBeNull();
    expect(
      valoresDoModeloDoLembrete(modelo("{{1}} {{2}} {{3}} {{4}}"), { ...pecas, endereco: "Rua A, 10" })?.valores,
    ).toEqual({ "1": "Ana", "2": "quinta-feira, 30/10 às 15:00", "3": "Consulta de retorno", "4": "Rua A, 10" });
  });

  it("quebra de linha e tabulação no título e no endereço viram espaço (a plataforma recusa o parâmetro)", () => {
    expect(
      valoresDoModeloDoLembrete(modelo("{{1}} {{2}} {{3}} {{4}}"), {
        ...pecas,
        titulo: "Consulta\nde\tretorno",
        endereco: "Rua A, 10\r\nSala 3\t\t     fundos",
      })?.valores,
    ).toEqual({
      "1": "Ana",
      "2": "quinta-feira, 30/10 às 15:00",
      "3": "Consulta de retorno",
      "4": "Rua A, 10 Sala 3 fundos",
    });
  });
});

describe("o modelo que o lembrete não tem como preencher", () => {
  it.each<[string, ModeloDoLembrete]>([
    ["buraco na numeração", modelo("Oi {{1}}, {{3}}")],
    ["mais variáveis do que a ordem cobre", modelo("{{1}} {{2}} {{3}} {{4}} {{5}}")],
    ["variável nomeada", modelo("Oi {{nome_do_cliente}}", { parameter_format: "NAMED" })],
    [
      "mídia no cabeçalho",
      modelo("Oi {{1}}", {
        components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Oi {{1}}" }],
      }),
    ],
    [
      "sufixo de link no botão",
      modelo("Oi {{1}}", {
        components: [
          { type: "BODY", text: "Oi {{1}}" },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Ver", url: "https://exemplo.test/{{1}}" }] },
        ],
      }),
    ],
    ["sem corpo de texto", modelo("", { components: [{ type: "HEADER", format: "TEXT", text: "Lembrete" }] })],
    [
      "variável no cabeçalho de texto",
      modelo("Oi", { components: [{ type: "HEADER", format: "TEXT", text: "Olá {{1}}" }, { type: "BODY", text: "Oi" }] }),
    ],
  ])("%s: não serve", (_caso, m) => {
    expect(variaveisQueOLembretePreenche(m)).toBeNull();
    expect(valoresDoModeloDoLembrete(m, { ...pecas, endereco: "Rua A, 10" })).toBeNull();
    expect(modeloServeAoLembrete(m)).toBe(false);
  });

  it("modelo nomeado SEM variável serve — não há nome de parâmetro a mandar", () => {
    expect(variaveisQueOLembretePreenche(modelo("Lembrete da sua consulta.", { parameter_format: "NAMED" }))).toBe(0);
  });

  it("só o aprovado é oferecido", () => {
    expect(modeloServeAoLembrete(modelo("Oi {{1}}"))).toBe(true);
    expect(modeloServeAoLembrete(modelo("Oi {{1}}", { status: "PENDING" }))).toBe(false);
    expect(modeloServeAoLembrete(modelo("Oi {{1}}", { status: "PAUSED" }))).toBe(false);
  });
});
