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
  it("traz a pergunta, o tipo, os preenchidos e as últimas mensagens", () => {
    const msg = montarMensagemDoValidador(
      PERGUNTA,
      [{ key: "moto_troca", label: "Moto", valor: "CG 125" }],
      [
        { de: "loja", texto: "De que ano ela é?" },
        { de: "cliente", texto: "é 2019" },
      ],
    );
    expect(msg).toContain("chave: troca_ano, tipo: number");
    expect(msg).toContain("chave: moto_troca): CG 125");
    expect(msg).toContain("CLIENTE: é 2019");
  });

  it("sem pendente, declara que só pode estar corrigindo", () => {
    const msg = montarMensagemDoValidador(null, [{ key: "ano", label: "Ano", valor: "2019" }], []);
    expect(msg).toContain("nenhuma — o fluxo só pode estar corrigindo");
  });

  it("select lista as opções", () => {
    const msg = montarMensagemDoValidador(
      { key: "cor", label: "Cor", type: "select", options: ["Azul", "Vermelha"] },
      [],
      [],
    );
    expect(msg).toContain("uma de: Azul, Vermelha");
  });
});

describe("parseLeituraDoValidador", () => {
  it("lê o JSON mesmo com prosa/cerca em volta", () => {
    expect(
      parseLeituraDoValidador('```json\n{"campo":"troca_ano","respondeu":true,"valor":"2019"}\n```'),
    ).toEqual({ campo: "troca_ano", respondeu: true, valor: "2019" });
  });

  it("saída sem JSON/ sem `respondeu` booleano vira null", () => {
    expect(parseLeituraDoValidador("não sei")).toBeNull();
    expect(parseLeituraDoValidador('{"valor":"x"}')).toBeNull();
  });
});

describe("validarRespostaDoFluxo", () => {
  const base = {
    pergunta: PERGUNTA,
    preenchidos: [] as readonly { key: string; label: string; valor: string }[],
    mensagens: [] as readonly { de: "cliente" | "loja"; texto: string }[],
  };

  it("respondeu a pendente com valor válido → respondeu", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"campo":"troca_ano","respondeu":true,"valor":"2019"}' },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      base,
      { log: logger },
    );
    expect(r).toEqual({ resultado: "respondeu", valor: "2019", campo: "troca_ano" });
  });

  it("valor incompatível com o tipo vira nao_respondeu (não grava lixo)", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"campo":"troca_ano","respondeu":true,"valor":"ok"}' },
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
      result: { text: '{"campo":"moto_troca","respondeu":true,"valor":"CG 150"}' },
    } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      { ...base, preenchidos: [{ key: "moto_troca", label: "Moto", valor: "CG 125" }] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "respondeu", valor: "CG 150", campo: "moto_troca" });
  });

  it("campo desconhecido (nem pendente nem corrigível) → nao_respondeu", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"campo":"outro_campo","respondeu":true,"valor":"x"}' },
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

  it("respondeu=false → nao_respondeu", async () => {
    runModelCallMock.mockResolvedValue({
      result: { text: '{"campo":"","respondeu":false,"valor":""}' },
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
      { pergunta: null, preenchidos: [], mensagens: [] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "nao_respondeu" });
    expect(runModelCallMock).not.toHaveBeenCalled();
  });
});
