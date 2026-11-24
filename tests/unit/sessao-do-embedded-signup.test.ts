import { describe, expect, it } from "vitest";

import { lerMensagemDoEmbeddedSignup } from "@/lib/channels/meta/sessao-do-embedded-signup";

const META = "https://www.facebook.com";
const msg = (event: string, data: Record<string, unknown> = {}) => ({ type: "WA_EMBEDDED_SIGNUP", event, data });

describe("lerMensagemDoEmbeddedSignup", () => {
  it("FINISH com número e conta é conexão padrão", () => {
    expect(lerMensagemDoEmbeddedSignup(META, msg("FINISH", { phone_number_id: "111111", waba_id: "222222" }))).toEqual({
      tipo: "sessao",
      modo: "padrao",
      waba_id: "222222",
      phone_number_id: "111111",
    });
  });

  it("aceita a mensagem como string JSON", () => {
    const r = lerMensagemDoEmbeddedSignup(META, JSON.stringify(msg("FINISH", { phone_number_id: "1", waba_id: "2" })));
    expect(r.tipo).toBe("sessao");
  });

  it("FINISH sem número é ignorado", () => {
    expect(lerMensagemDoEmbeddedSignup(META, msg("FINISH", { waba_id: "222222" }))).toEqual({ tipo: "ignorar" });
  });

  it("coexistência sem phone_number_id vale, só com a conta", () => {
    const r = lerMensagemDoEmbeddedSignup(META, msg("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "222222" }));
    expect(r).toEqual({ tipo: "sessao", modo: "coexistencia", waba_id: "222222" });
    expect(r).not.toHaveProperty("phone_number_id");
  });

  it("coexistência com número guarda o número", () => {
    const r = lerMensagemDoEmbeddedSignup(
      META,
      msg("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "222222", phone_number_id: "333333" }),
    );
    expect(r).toMatchObject({ modo: "coexistencia", phone_number_id: "333333" });
  });

  it("FINISH_ONLY_WABA conclui só com a conta, em modo padrão", () => {
    expect(lerMensagemDoEmbeddedSignup(META, msg("FINISH_ONLY_WABA", { waba_id: "222222" }))).toEqual({
      tipo: "sessao",
      modo: "padrao",
      waba_id: "222222",
    });
  });

  it("conclusão sem conta é ignorada", () => {
    expect(lerMensagemDoEmbeddedSignup(META, msg("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", {}))).toEqual({ tipo: "ignorar" });
  });

  it("CANCEL", () => {
    expect(lerMensagemDoEmbeddedSignup(META, msg("CANCEL", { current_step: "x" }))).toEqual({ tipo: "cancelado" });
  });

  it("ERROR devolve a mensagem da Meta", () => {
    expect(lerMensagemDoEmbeddedSignup(META, msg("ERROR", { error_message: "falhou" }))).toEqual({
      tipo: "erro",
      mensagem: "falhou",
    });
  });

  it("origem que não é da Meta é ignorada, mesmo com mensagem válida", () => {
    const valida = msg("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "222222" });
    expect(lerMensagemDoEmbeddedSignup("https://evil.example.com", valida)).toEqual({ tipo: "ignorar" });
    expect(lerMensagemDoEmbeddedSignup("https://facebook.com.evil.example", valida)).toEqual({ tipo: "ignorar" });
    expect(lerMensagemDoEmbeddedSignup("lixo", valida)).toEqual({ tipo: "ignorar" });
  });

  it("tipo errado, evento desconhecido e lixo são ignorados", () => {
    expect(lerMensagemDoEmbeddedSignup(META, { type: "OUTRA", event: "FINISH", data: { waba_id: "1" } })).toEqual({ tipo: "ignorar" });
    expect(lerMensagemDoEmbeddedSignup(META, msg("PAGE_LOADED", { waba_id: "1" }))).toEqual({ tipo: "ignorar" });
    expect(lerMensagemDoEmbeddedSignup(META, "não é json")).toEqual({ tipo: "ignorar" });
    expect(lerMensagemDoEmbeddedSignup(META, null)).toEqual({ tipo: "ignorar" });
  });
});
