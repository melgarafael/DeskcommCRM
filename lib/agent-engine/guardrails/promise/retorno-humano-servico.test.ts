import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { casePromiseGate, type GateContext } from "../before-send";
import { detectHumanPromise } from "../human-promise";
import { classifyPromise, parsePromiseClassification } from "./semantic";
import { runModelCall } from "../../edge/llm/run-model-call";
import { createLogger } from "../../obs/logger";

vi.mock("../../edge/llm/run-model-call", () => ({ runModelCall: vi.fn() }));
const call = vi.mocked(runModelCall);
beforeEach(() => call.mockReset());

function ctx(body: string, semantic: boolean): GateContext {
  return {
    body,
    casesEnabled: true,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    semanticPromise: {
      isPromise: false,
      suspectPhrase: null,
      prometeuRetornoHumano: semantic,
      retornoSoDoAssistente: false,
    },
  } as GateContext;
}

describe("consentimento junto de descrição não cria promessa de retaguarda", () => {
  const consentimento = "Quer que eu transfira para a equipe?";
  for (const body of [
    "Aceitamos essa idade. A vaga precisa de avaliação humana. " + consentimento,
    "A piscina é aquecida. Gostaria que eu encaminhasse para o responsável?",
    "Isso depende da disponibilidade. Posso consultar a equipe?",
    "Sim. Quer que eu transfira para o Fabio?",
    "A piscina é aquecida. Posso transferir para a equipe agora?",
    "A equipe retorna à sala em 10 minutos. Posso transferir para o responsável?",
  ]) {
    it(body, () => {
      expect(detectHumanPromise(body, ["Fabio"])).toBe(false);
      expect(
        casePromiseGate.evaluate({ ...ctx(body, false), humanPromiseExtraTargets: ["Fabio"] }),
      ).toEqual({ pass: true });
    });
  }
  for (const body of [
    "Já acionei a equipe para te responder. " + consentimento,
    consentimento + " Vou verificar com o responsável e te retorno.",
    "Quer que eu transfira para a equipe? A equipe vai te responder hoje.",
    "Posso consultar a equipe? Já está em análise pela equipe.",
    "Quer que eu transfira para o Fabio? Vou confirmar com o Fabio.",
    "Posso garantir que a equipe vai te retornar hoje?",
    "A equipe vai te atender agora.",
    "Quer que eu transfira para a equipe? Vou passar o pedido para eles resolverem.",
    "Posso transferir para a equipe? Eles te retornam ainda hoje.",
    "Quer que eu encaminhe para a equipe? A equipe vai te ligar amanhã.",
    "Posso encaminhar para o setor? O responsável retorna em 10 minutos.",
  ]) {
    it("não apaga compromisso real: " + body, () => {
      expect(detectHumanPromise(body, ["Fabio"])).toBe(true);
      expect(
        casePromiseGate.evaluate({ ...ctx(body, false), humanPromiseExtraTargets: ["Fabio"] }),
      ).toMatchObject({ pass: false, code: "case_promise_without_case" });
    });
  }
  it("semântico positivo continua suficiente quando o léxico não casa", () => {
    expect(casePromiseGate.evaluate(ctx("Te retorno com a proposta.", true))).toMatchObject({
      pass: false,
      code: "case_promise_without_case",
    });
  });
  it("case real continua atendendo a condição operacional", () => {
    expect(
      casePromiseGate.evaluate({
        ...ctx("Vou verificar com a equipe.", true),
        openedCaseThisTurn: true,
      }),
    ).toEqual({ pass: true });
  });
});

describe("diagnóstico de retorno não cria uma liberação alternativa", () => {
  const candidate = "Vou verificar com a equipe e te retorno.";
  const raw = {
    isPromise: false,
    suspectPhrase: null,
    prometeuRetornoHumano: true,
    retornoSoDoAssistente: false,
    humanReturnPhrase: "verificar com a equipe e te retorno",
    humanReturnCategory: "internal_action",
  };
  it("preserva trecho literal e categoria emitidos na revisão", () => {
    const result = parsePromiseClassification(JSON.stringify(raw), candidate);
    expect(result).toMatchObject(raw);
    expect(
      casePromiseGate.evaluate({ ...ctx(candidate, false), semanticPromise: result }),
    ).toMatchObject({ pass: false, code: "case_promise_without_case" });
  });
  it.each([
    { humanReturnPhrase: "texto que não existe", humanReturnCategory: "internal_action" },
    { humanReturnPhrase: "verificar com a equipe e te retorno", humanReturnCategory: "inventada" },
    { humanReturnPhrase: 2, humanReturnCategory: "internal_action" },
  ])("diagnóstico inválido não desliga o boolean $humanReturnCategory", (diagnostic) => {
    const result = parsePromiseClassification(JSON.stringify({ ...raw, ...diagnostic }), candidate);
    expect(result.prometeuRetornoHumano).toBe(true);
    expect(result.humanReturnPhrase).toBeUndefined();
    expect(result.humanReturnCategory).toBeUndefined();
  });
  it("campos ausentes continuam compatíveis com o veredito antigo", () => {
    expect(
      parsePromiseClassification(
        '{"isPromise":false,"suspectPhrase":null,"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}',
        candidate,
      ),
    ).toEqual({
      isPromise: false,
      suspectPhrase: null,
      prometeuRetornoHumano: true,
      retornoSoDoAssistente: false,
    });
  });
  it("JSON quebrado continua caindo no detector com compromisso real", () => {
    expect(parsePromiseClassification("sem JSON", candidate).prometeuRetornoHumano).toBe(true);
  });
  it("JSON quebrado não inventa compromisso em descrição mais consentimento", () => {
    expect(
      parsePromiseClassification(
        "sem JSON",
        "Aceitamos essa idade. Quer que eu transfira para a equipe?",
      ).prometeuRetornoHumano,
    ).toBe(false);
  });
});

it("mantém contexto/evidências e diagnósticos na mesma chamada do classificador", async () => {
  const candidate =
    "O instrutor avalia seu nível na aula gratuita. Me avise quando concluir o formulário.";
  const conversationContext = {
    mensagens: [{ papel: "cliente" as const, texto: "Aceito conhecer." }],
    resumo: null,
    limitado: false,
    momento: "2026-10-09T19:00:00Z",
    fuso: "America/Sao_Paulo",
  };
  const commercialEvidence = [
    {
      origem: "conhecimento" as const,
      referencia: "regra:teste",
      titulo: "Aula de apresentação",
      conteudo: "Aula gratuita com avaliação pelo instrutor e cadastro prévio.",
    },
  ];
  call.mockResolvedValue({
    result: {
      text: '{"isPromise":false,"suspectPhrase":null,"prometeuRetornoHumano":false,"retornoSoDoAssistente":false,"humanReturnPhrase":null,"humanReturnCategory":null}',
    },
  } as Awaited<ReturnType<typeof runModelCall>>);
  const result = await classifyPromise(
    {} as pg.Pool,
    {},
    { tenantId: "org-do-servidor" },
    { candidate, commercialEvidence, conversationContext },
    { log: createLogger() },
  );
  expect(call).toHaveBeenCalledOnce();
  const request = call.mock.calls[0]![2];
  expect(JSON.parse(request.messages[0]!.content as string)).toEqual({
    mensagem: candidate,
    evidencias: commercialEvidence.map(({ origem, titulo, conteudo }) => ({ origem, titulo, conteudo })),
    contexto_conversa: conversationContext,
  });
  expect(request.system).toContain("humanReturnPhrase");
  expect(result.prometeuRetornoHumano).toBe(false);
});

it("um registro interno positivo segue ao gate sem segunda chamada nem veto comercial", async () => {
  const candidate = "Registrei sua solicitação para que a situação seja verificada.";
  call.mockResolvedValue({
    result: {
      text: JSON.stringify({
        isPromise: false,
        suspectPhrase: null,
        prometeuRetornoHumano: true,
        retornoSoDoAssistente: false,
        humanReturnPhrase: candidate,
        humanReturnCategory: "internal_action",
      }),
    },
  } as Awaited<ReturnType<typeof runModelCall>>);
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const result = await classifyPromise(
    { query } as unknown as pg.Pool,
    {},
    { tenantId: "org-do-servidor" },
    { candidate, model: "modelo-escolhido" },
    { log: createLogger() },
  );
  expect(call).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledWith(expect.stringContaining("organization_id = $1"), [
    "org-do-servidor",
    "human_return_confirmation",
  ]);
  expect(call.mock.calls[0]![2]).toMatchObject({
    purpose: "promise_semantic",
    model: "modelo-escolhido",
  });
  expect(result.isPromise).toBe(false);
  expect(result.retornoSoDoAssistente).toBe(false);
  expect(
    casePromiseGate.evaluate({ ...ctx(candidate, false), semanticPromise: result }),
  ).toMatchObject({ pass: false, code: "case_promise_without_case" });
});

describe("segunda opinião configurável só de retorno humano", () => {
  const original = {
    isPromise: true,
    suspectPhrase: "oferta não aprovada",
    prometeuRetornoHumano: true,
    retornoSoDoAssistente: false,
  };
  const args = {
    candidate: "Quer que eu encaminhe para a equipe? Oferta não aprovada.",
    commercialEvidence: [
      {
        origem: "conhecimento" as const,
        referencia: "regra:teste",
        titulo: "Regra",
        conteudo: "A equipe confirma disponibilidade.",
      },
    ],
    conversationContext: {
      mensagens: [{ papel: "cliente" as const, texto: "Quero conhecer." }],
      resumo: null,
      limitado: false,
      momento: "2026-10-09T19:00:00Z",
      fuso: "America/Sao_Paulo",
    },
  };
  const binding = {
    purpose: "human_return_confirmation",
    provider: "provedor-do-teste",
    credential_id: "credencial-do-teste",
    model_id: "modelo-confirmador",
    base_url: null,
    is_enabled: true,
  };
  async function evaluate(response: string | Error, enabled = true) {
    call.mockResolvedValueOnce({ result: { text: JSON.stringify(original) } } as Awaited<
      ReturnType<typeof runModelCall>
    >);
    if (response instanceof Error) call.mockRejectedValueOnce(response);
    else
      call.mockResolvedValueOnce({ result: { text: response } } as Awaited<
        ReturnType<typeof runModelCall>
      >);
    return classifyPromise({} as pg.Pool, {}, { tenantId: "org-do-servidor" }, args, {
      log: createLogger(),
      loadHumanReturnBinding: async () => ({ ...binding, is_enabled: enabled }),
    });
  }
  it("confirma falso positivo sem modificar comercial nem reduzir o pacote recebido", async () => {
    const result = await evaluate(
      '{"prometeuRetornoHumano":false,"retornoSoDoAssistente":false,"isPromise":false}',
    );
    expect(result).toEqual({ ...original, prometeuRetornoHumano: false });
    expect(call).toHaveBeenCalledTimes(2);
    const second = call.mock.calls[1]![2];
    expect(second).toMatchObject({ purpose: binding.purpose, tenantId: "org-do-servidor" });
    expect(second.model).toBeUndefined();
    expect(second.llmOverride).toBeUndefined();
    expect(JSON.parse(second.messages[0]!.content as string)).toEqual({
      mensagem: args.candidate,
      evidencias: args.commercialEvidence.map(({ origem, titulo, conteudo }) => ({ origem, titulo, conteudo })),
      contexto_conversa: args.conversationContext,
    });
  });
  it("compromisso real continua positivo", async () => {
    expect(
      (await evaluate('{"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}'))
        .prometeuRetornoHumano,
    ).toBe(true);
  });
  it.each(["sem JSON", "{}", '{"prometeuRetornoHumano":"false"}'])(
    "saída inválida preserva a primeira marcação: %s",
    async (raw) => {
      expect(await evaluate(raw)).toEqual(original);
    },
  );
  it("fornecedor/budget com falha preserva a primeira marcação sem repetição", async () => {
    expect(await evaluate(new Error("falha simulada"))).toEqual(original);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("binding desligado não dispara segunda leitura", async () => {
    expect(await evaluate("{}", false)).toEqual(original);
    expect(call).toHaveBeenCalledOnce();
  });
  it("primeiro sinal negativo não carrega confirmação", async () => {
    call.mockResolvedValueOnce({
      result: { text: '{"isPromise":false,"prometeuRetornoHumano":false}' },
    } as Awaited<ReturnType<typeof runModelCall>>);
    const loader = vi.fn();
    await classifyPromise({} as pg.Pool, {}, { tenantId: "org-do-servidor" }, args, {
      log: createLogger(),
      loadHumanReturnBinding: loader,
    });
    expect(loader).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledOnce();
  });
});
