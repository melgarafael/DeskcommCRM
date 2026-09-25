import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

vi.mock("../edge/llm/run-model-call", () => ({ runModelCall: vi.fn() }));

import { runModelCall } from "../edge/llm/run-model-call";
import {
  montarMensagemDoValidador,
  parseLeituraDoValidador,
  validarRespostaDoFluxo,
  type PerguntaDoFluxo,
} from "./flow-validate";

const runModelCallMock = vi.mocked(runModelCall);
const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;
const db = {} as pg.Pool;
const cfg = {} as never;

const PERGUNTA: PerguntaDoFluxo = { key: "troca_ano", label: "Ano", type: "number" };

describe("montarMensagemDoValidador", () => {
  it("traz as perguntas pendentes, os preenchidos e as últimas mensagens", () => {
    const msg = montarMensagemDoValidador(
      [PERGUNTA, { key: "troca_km", label: "Km", type: "number" }],
      [{ key: "moto_troca", label: "Moto", valor: "CG 125" }],
      [
        { de: "loja", texto: "De que ano ela é?" },
        { de: "cliente", texto: "é 2019" },
      ],
    );
    expect(msg).toContain("chave: troca_ano, tipo: number");
    expect(msg).toContain("chave: troca_km, tipo: number");
    expect(msg).toContain("chave: moto_troca): CG 125");
    expect(msg).toContain("CLIENTE: é 2019");
  });

  it("sem pendentes, declara que não há perguntas", () => {
    const msg = montarMensagemDoValidador([], [{ key: "ano", label: "Ano", valor: "2019" }], []);
    expect(msg).toContain("(nenhuma)");
  });

  it("select lista as opções", () => {
    const msg = montarMensagemDoValidador(
      [{ key: "cor", label: "Cor", type: "select", options: ["Azul", "Vermelha"] }],
      [],
      [],
    );
    expect(msg).toContain("uma de: Azul, Vermelha");
  });

  it("lista os campos ENCERRADOS por não resposta (resposta tardia)", () => {
    const msg = montarMensagemDoValidador([], [], [], [
      { key: "cpf", label: "CPF", type: "text", question: "Pode me passar seu CPF?" },
    ]);
    expect(msg).toContain("encerrados por não resposta");
    expect(msg).toContain("chave: cpf");
  });

  /**
   * C-082 — o cliente manda em rajada ("Sou Vander" + "Sao paulo"). A instrução
   * dizia "a mais recente é a que importa", e o validador descartava a 1ª
   * mensagem: o nome se perdia. Agora a instrução manda ler TODAS as do cliente.
   */
  it("manda ler TODAS as mensagens do cliente, não só a última (C-082)", () => {
    const msg = montarMensagemDoValidador(
      [
        { key: "nome", label: "Nome", type: "text" },
        { key: "cidade", label: "Cidade", type: "text" },
      ],
      [],
      [
        { de: "cliente", texto: "Sou Vander" },
        { de: "cliente", texto: "Sao paulo" },
      ],
    );
    expect(msg).toMatch(/TODAS as mensagens do CLIENTE/);
    expect(msg).not.toMatch(/a mais recente é a que importa/);
    // As duas mensagens da rajada estão no texto entregue.
    expect(msg).toContain("CLIENTE: Sou Vander");
    expect(msg).toContain("CLIENTE: Sao paulo");
  });
});

describe("parseLeituraDoValidador", () => {
  it("lê o formato novo (lista de respostas) mesmo com cerca em volta", () => {
    expect(
      parseLeituraDoValidador(
        '```json\n{"respostas":[{"campo":"troca_ano","valor":"2019"},{"campo":"troca_km","valor":"120"}]}\n```',
      ),
    ).toEqual({
      respostas: [
        { campo: "troca_ano", valor: "2019" },
        { campo: "troca_km", valor: "120" },
      ],
    });
  });

  it("aceita o formato antigo (campo/respondeu/valor) por compatibilidade", () => {
    expect(
      parseLeituraDoValidador('{"campo":"troca_ano","respondeu":true,"valor":"2019"}'),
    ).toEqual({ respostas: [{ campo: "troca_ano", valor: "2019" }] });
    expect(parseLeituraDoValidador('{"campo":"","respondeu":false,"valor":""}')).toEqual({
      respostas: [],
    });
  });

  it("saída sem JSON vira null", () => {
    expect(parseLeituraDoValidador("não sei")).toBeNull();
  });
});

describe("validarRespostaDoFluxo", () => {
  const base = {
    perguntas: [PERGUNTA] as readonly PerguntaDoFluxo[],
    preenchidos: [] as readonly { key: string; label: string; valor: string }[],
    mensagens: [] as readonly { de: "cliente" | "loja"; texto: string }[],
  };

  it("respondeu a pendente com valor válido → respondeu", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"respostas":[{"campo":"troca_ano","valor":"2019"}]}' },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      base,
      { log: logger },
    );
    expect(r).toEqual({ resultado: "respondeu", respostas: [{ campo: "troca_ano", valor: "2019" }] });
  });

  it("MÚLTIPLOS campos de uma vez (ordem livre) → devolve todos os válidos", async () => {
    runModelCallMock.mockResolvedValue({
      result: {
        text: '{"respostas":[{"campo":"troca_km","valor":"120"},{"campo":"troca_ano","valor":"2015"}]}',
      },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      {
        perguntas: [
          { key: "troca_ano", label: "Ano", type: "number" },
          { key: "troca_km", label: "Km", type: "number" },
        ],
        preenchidos: [],
        mensagens: [],
      },
      { log: logger },
    );
    expect(r).toEqual({
      resultado: "respondeu",
      respostas: [
        { campo: "troca_km", valor: "120" },
        { campo: "troca_ano", valor: "2015" },
      ],
    });
  });

  it("valor incompatível com o tipo é DESCARTADO (não grava lixo)", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"respostas":[{"campo":"troca_ano","valor":"ok"}]}' },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      base,
      { log: logger },
    );
    expect(r).toEqual({ resultado: "nao_respondeu" });
  });

  it("CORREÇÃO: campo preenchido corrigível é aceito", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"respostas":[{"campo":"moto_troca","valor":"CG 150"}]}' },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      { ...base, preenchidos: [{ key: "moto_troca", label: "Moto", valor: "CG 125" }] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "respondeu", respostas: [{ campo: "moto_troca", valor: "CG 150" }] });
  });

  it("campo desconhecido (nem pendente nem corrigível) é ignorado", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"respostas":[{"campo":"outro_campo","valor":"x"}]}' },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      base,
      { log: logger },
    );
    expect(r).toEqual({ resultado: "nao_respondeu" });
  });

  it("lista vazia → nao_respondeu", async () => {
    runModelCallMock.mockResolvedValue({ result: { text: '{"respostas":[]}' } } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      base,
      { log: logger },
    );
    expect(r).toEqual({ resultado: "nao_respondeu" });
  });

  it("falha do modelo → indefinido (o turno segue)", async () => {
    runModelCallMock.mockRejectedValue(new Error("sem chave"));
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      base,
      { log: logger },
    );
    expect(r).toEqual({ resultado: "indefinido" });
  });

  it("sem pendente e sem corrigível não chama o modelo", async () => {
    runModelCallMock.mockReset();
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      { perguntas: [], preenchidos: [], mensagens: [] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "nao_respondeu" });
    expect(runModelCallMock).not.toHaveBeenCalled();
  });

  it("RESPOSTA TARDIA: campo encerrado por não resposta é aceito se a mensagem o informar", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"respostas":[{"campo":"cpf","valor":"12345678900"}]}' },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      {
        perguntas: [],
        preenchidos: [],
        esgotados: [{ key: "cpf", label: "CPF", type: "text" }],
        mensagens: [{ de: "cliente", texto: "meu cpf é 12345678900" }],
      },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "respondeu", respostas: [{ campo: "cpf", valor: "12345678900" }] });
  });
});
