// @vitest-environment node
import { describe, expect, it } from "vitest";
import { falhaDeExecucaoParaRecibo, resultadoParaRecibo } from "./resultado-para-recibo";
import type { ActionResultDetail } from "./types";

const PESSOAL = "Joana Sintética pessoa.sintetica@example.test +5511999990000";

describe("recibo técnico de automação não guarda a frase do provedor", () => {
  it.each(["error", "erro", "reason", "error_code", "code"])(
    "protege detail.%s sem perder metadados de entrega",
    (campo) => {
      const original: ActionResultDetail = {
        type: "call_webhook",
        status: "failed",
        detail: {
          [campo]: PESSOAL,
          delivery_id: "entrega-sintetica",
          attempt: 2,
          attempts: 3,
          response_status: 503,
        },
      };
      const seguro = resultadoParaRecibo(original);
      expect(JSON.stringify(seguro)).not.toContain(PESSOAL);
      expect(seguro.detail).toMatchObject({
        delivery_id: "entrega-sintetica",
        attempt: 2,
        attempts: 3,
        response_status: 503,
        error_code: "internal_error",
      });
      expect(original.detail?.[campo]).toBe(PESSOAL);
    },
  );

  it("protege error no topo e objeto aninhado em detail.error", () => {
    const seguro = resultadoParaRecibo({
      type: "send_email",
      status: "failed",
      error: PESSOAL,
      detail: {
        error: { body: PESSOAL, token: "segredo-sintetico" },
        destinatario: "contato",
        via: "smtp",
      },
    });
    expect(seguro).toEqual({
      type: "send_email",
      status: "failed",
      error: "internal_error",
      detail: {
        error: "internal_error",
        error_code: "internal_error",
        destinatario: "contato",
        via: "smtp",
      },
    });
  });

  it("código parecido com token/PII não vira código confiável pelo formato", () => {
    for (const valor of [
      "cpf_12345678901",
      "JOANA",
      "5511999990000",
      "pessoa_sintetica_example_test",
    ]) {
      expect(
        resultadoParaRecibo({ type: "send_email", status: "failed", error: valor }).error,
      ).toBe("internal_error");
    }
  });

  it("a trava uma vez, o adiamento e a identidade da entrega ficam iguais", () => {
    const exemplos: ActionResultDetail[] = [
      { type: "call_webhook", status: "skipped", error: "uma_vez_por_contato" },
      {
        type: "send_whatsapp_message",
        status: "postponed",
        detail: {
          reason: "fora_da_janela_de_envio",
          retry_at: "2026-10-26T22:00:00Z",
          message_id: "mensagem-sintetica",
        },
      },
      {
        type: "call_webhook",
        status: "failed",
        error: "http_503",
        detail: { delivery_id: "entrega-sintetica", attempt: 2, response_status: 503 },
      },
    ];
    for (const exemplo of exemplos) expect(resultadoParaRecibo(exemplo)).toEqual(exemplo);
  });

  it("motivo de set_lead_date_field chega ao recibo com o próprio código", () => {
    const pulado: ActionResultDetail = {
      type: "set_lead_date_field",
      status: "skipped",
      detail: { reason: "sem_negocio_aberto" },
    };
    expect(resultadoParaRecibo(pulado).detail?.reason).toBe("sem_negocio_aberto");
  });

  it("falha lançada preserva código conhecido e classe, sem ler a mensagem", () => {
    const erro = Object.assign(new TypeError(PESSOAL), { code: "ECONNREFUSED" });
    expect(falhaDeExecucaoParaRecibo("call_webhook", erro)).toEqual({
      type: "call_webhook",
      status: "failed",
      error: "ECONNREFUSED",
      detail: { error_code: "ECONNREFUSED", error_type: "TypeError" },
    });
  });

  it("nome/código arbitrários e valores primitivos também ficam fora do recibo", () => {
    const erro = Object.assign(new Error(PESSOAL), { name: PESSOAL, code: PESSOAL });
    for (const entrada of [erro, PESSOAL, { message: PESSOAL, code: PESSOAL }, null]) {
      const seguro = falhaDeExecucaoParaRecibo("send_email", entrada);
      expect(seguro.error).toBe("internal_error");
      expect(JSON.stringify(seguro)).not.toContain(PESSOAL);
    }
  });
  it("a causa conhecida continua legível para Atividade e MCP, sem o texto privado", () => {
    const seguro = resultadoParaRecibo({
      type: "notify_team",
      status: "failed",
      detail: { reason: "whatsapp_falhou", error: PESSOAL },
    });
    expect(seguro.error).toBe("whatsapp_falhou");
    expect(seguro.detail).toMatchObject({
      reason: "whatsapp_falhou",
      error_code: "whatsapp_falhou",
    });
    expect(JSON.stringify(seguro)).not.toContain(PESSOAL);
  });
  it("código numérico não ganha precedência técnica; código string conhecido ganha", () => {
    const entrada = (codigo: unknown): ActionResultDetail => ({ type: "send_email", status: "failed",
      detail: { error_code: codigo, reason: "http_503", error: PESSOAL } });
    const numerico = resultadoParaRecibo(entrada(131026));
    expect(numerico.error).toBe("http_503");
    expect(numerico.detail?.error_code).toBe("http_503");
    const texto = resultadoParaRecibo(entrada("131026"));
    expect(texto.error).toBe("131026");
    expect(texto.detail?.error_code).toBe("131026");
  });

  it("reaplicar o saneamento não altera um recibo já protegido", () => {
    const seguro = resultadoParaRecibo({
      type: "send_email",
      status: "failed",
      error: PESSOAL,
      detail: { error: PESSOAL, delivery_id: "entrega-sintetica", attempt: 2 },
    });
    expect(resultadoParaRecibo(seguro)).toEqual(seguro);
  });

  it.each(["carteira_nao_passou", "conversas_nao_passaram"])(
    "a passagem parcial do assign_owner (%s) grava o código, e não a mensagem do banco",
    (codigo) => {
      const seguro = resultadoParaRecibo({
        type: "assign_owner",
        status: "failed",
        error: codigo,
        detail: { user_id: "dono-sintetico", carteira: "falhou", erro: `conversa x: ${PESSOAL}` },
      });
      // O código fica: é ele que a Atividade traduz na frase da falha parcial.
      expect(seguro.error).toBe(codigo);
      expect(seguro.detail).toMatchObject({ user_id: "dono-sintetico", carteira: "falhou", erro: codigo });
      expect(JSON.stringify(seguro)).not.toContain(PESSOAL);
    },
  );
});
