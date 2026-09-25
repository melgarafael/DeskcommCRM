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
      { ...base, textoAtual: "é 2019" },
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
        mensagens: [{ de: "cliente", texto: "é de 2015 e rodou 120 km" }],
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
      {
        ...base,
        preenchidos: [{ key: "moto_troca", label: "Moto", valor: "CG 125" }],
        textoAtual: "na verdade é uma CG 150",
      },
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
    runModelCallMock.mockReset();
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

  it("usa o modelo auxiliar do turno — sem ele, instalação sem default_model nunca teria validador", async () => {
    runModelCallMock.mockReset();
    runModelCallMock.mockResolvedValue({ result: { text: '{"respostas":[]}' } } as never);
    await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      base,
      { log: logger, aux: { model: "gpt-5.4-mini", llmOverride: { provider: "openai", credentialId: null } } },
    );
    expect(runModelCallMock.mock.calls[0]![2]).toMatchObject({
      purpose: "flow_validate",
      model: "gpt-5.4-mini",
      llmOverride: { provider: "openai", credentialId: null },
    });
  });

  describe("lastro na mensagem (achado 4 da prova do #1130)", () => {
    const respostaDoModelo = (json: unknown) =>
      runModelCallMock.mockResolvedValue({ result: { text: JSON.stringify(json) } } as never);

    it('"moto de uns 15 mil" não vira a opção "Outra"', async () => {
      respostaDoModelo({ respostas: [{ campo: "modelo_interesse", valor: "Outra" }] });
      const r = await validarRespostaDoFluxo(db, cfg, { tenantId: "o", leadId: "l", jobId: "j" }, {
        perguntas: [
          { key: "cpf", label: "CPF", type: "cpf" },
          { key: "modelo_interesse", label: "Modelo de interesse", type: "select", options: ["CG 160", "Fazer 250", "XRE 300", "Outra"] },
        ],
        preenchidos: [],
        mensagens: [],
        textoAtual: "oi, voltei. então, como fica a parcela de uma moto de uns 15 mil?",
      }, { log: logger });
      expect(r).toEqual({ resultado: "nao_respondeu" });
    });

    it('"Honda CG 125" dá a moto, mas não vira ANO 125', async () => {
      respostaDoModelo({ respostas: [{ campo: "moto_troca", valor: "Honda CG 125" }, { campo: "ano_troca", valor: "125" }] });
      const r = await validarRespostaDoFluxo(db, cfg, { tenantId: "o", leadId: "l", jobId: "j" }, {
        perguntas: [
          { key: "moto_troca", label: "Moto na troca", type: "text" },
          { key: "ano_troca", label: "Ano da moto", type: "number" },
        ],
        preenchidos: [],
        mensagens: [],
        textoAtual: "tenho uma Honda CG 125 pra troca",
      }, { log: logger });
      expect(r).toEqual({ resultado: "respondeu", respostas: [{ campo: "moto_troca", valor: "Honda CG 125" }] });
    });

    it("CPF com dígito errado é recusado; o certo entra, e a correção confere o dígito", async () => {
      const perguntas = [{ key: "cpf", label: "CPF", type: "cpf" as const }];
      respostaDoModelo({ respostas: [{ campo: "cpf", valor: "12345678900" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, { tenantId: "o", leadId: "l", jobId: "j" },
          { perguntas, preenchidos: [], mensagens: [], textoAtual: "meu cpf é 123.456.789-00" }, { log: logger }),
      ).toEqual({ resultado: "nao_respondeu" });

      respostaDoModelo({ respostas: [{ campo: "cpf", valor: "52998224725" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, { tenantId: "o", leadId: "l", jobId: "j" },
          { perguntas, preenchidos: [], mensagens: [], textoAtual: "529.982.247-25" }, { log: logger }),
      ).toEqual({ resultado: "respondeu", respostas: [{ campo: "cpf", valor: "52998224725" }] });

      respostaDoModelo({ respostas: [{ campo: "cpf", valor: "11144477735" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, { tenantId: "o", leadId: "l", jobId: "j" },
          {
            perguntas: [],
            preenchidos: [{ key: "cpf", label: "CPF", valor: "52998224725", type: "cpf" }],
            mensagens: [],
            textoAtual: "opa, digitei errado, o certo é 111.444.777-35",
          }, { log: logger }),
      ).toEqual({ resultado: "respondeu", respostas: [{ campo: "cpf", valor: "11144477735" }] });
    });

    it("sem a mensagem do cliente, nada tem lastro", async () => {
      respostaDoModelo({ respostas: [{ campo: "troca_ano", valor: "2019" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, { tenantId: "o", leadId: "l", jobId: "j" }, base, { log: logger }),
      ).toEqual({ resultado: "nao_respondeu" });
    });
  });

  describe("revisão adversarial do PR 2", () => {
    const ids = { tenantId: "o", leadId: "l", jobId: "j" };
    const modelo = (json: unknown) =>
      runModelCallMock.mockResolvedValue({ result: { text: JSON.stringify(json) } } as never);

    it('turno sem pergunta feita: "sim, quero financiar" não vira tem_cnh e "quero financiar" não vira nome', async () => {
      modelo({ respostas: [{ campo: "tem_cnh", valor: "true" }, { campo: "nome_completo", valor: "Lia Mendes" }] });
      const perguntas = [
        { key: "tem_cnh", label: "Tem CNH", type: "boolean" as const },
        { key: "nome_completo", label: "Nome completo", type: "text" as const },
      ];
      expect(
        await validarRespostaDoFluxo(db, cfg, ids, { perguntas, preenchidos: [], mensagens: [], textoAtual: "sim, quero financiar", perguntaAtual: null }, { log: logger }),
      ).toEqual({ resultado: "nao_respondeu" });
      expect(
        await validarRespostaDoFluxo(db, cfg, ids, { perguntas, preenchidos: [], mensagens: [], textoAtual: "quero financiar", perguntaAtual: null }, { log: logger }),
      ).toEqual({ resultado: "nao_respondeu" });
    });

    it("com a pergunta FEITA, o sim solto responde a ela", async () => {
      modelo({ respostas: [{ campo: "tem_cnh", valor: "true" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, ids, {
          perguntas: [{ key: "tem_cnh", label: "Tem CNH", type: "boolean" }],
          preenchidos: [], mensagens: [], textoAtual: "sim", perguntaAtual: "tem_cnh",
        }, { log: logger }),
      ).toEqual({ resultado: "respondeu", respostas: [{ campo: "tem_cnh", valor: "true" }] });
    });

    it('data: "nasci em 12/03/1990" não sustenta 1985-07-20; a data escrita entra', async () => {
      const perguntas = [{ key: "nascimento", label: "Data de nascimento", type: "date" as const }];
      modelo({ respostas: [{ campo: "nascimento", valor: "1985-07-20" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, ids, { perguntas, preenchidos: [], mensagens: [], textoAtual: "nasci em 12/03/1990", perguntaAtual: "nascimento" }, { log: logger }),
      ).toEqual({ resultado: "nao_respondeu" });
      expect(
        await validarRespostaDoFluxo(db, cfg, ids, { perguntas, preenchidos: [], mensagens: [], textoAtual: "a revisão foi 10/05/2023", perguntaAtual: null }, { log: logger }),
      ).toEqual({ resultado: "nao_respondeu" });
      modelo({ respostas: [{ campo: "nascimento", valor: "1990-03-12" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, ids, { perguntas, preenchidos: [], mensagens: [], textoAtual: "nasci em 12 de março de 1990", perguntaAtual: "nascimento" }, { log: logger }),
      ).toEqual({ resultado: "respondeu", respostas: [{ campo: "nascimento", valor: "1990-03-12" }] });
    });

    it("rajada: o CPF da segunda mensagem do lote tem lastro", async () => {
      modelo({ respostas: [{ campo: "cpf", valor: "529.982.247-25" }] });
      expect(
        await validarRespostaDoFluxo(db, cfg, ids, {
          perguntas: [{ key: "cpf", label: "CPF", type: "cpf" }],
          preenchidos: [], mensagens: [], textoAtual: "oi\nmeu cpf é 529.982.247-25", perguntaAtual: "cpf",
        }, { log: logger }),
      ).toEqual({ resultado: "respondeu", respostas: [{ campo: "cpf", valor: "52998224725" }] });
    });
  });
});

