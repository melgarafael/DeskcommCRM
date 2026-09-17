import { describe, expect, it } from "vitest";

import { causaSegura, ExtensionError } from "./errors";

describe("causaSegura", () => {
  it("guarda o código e o status de uma causa estruturada", () => {
    const erro = new ExtensionError("extension_download_failed", {
      cause: { code: "http_status", status: 404 },
    });
    expect(causaSegura(erro)).toEqual({ cause_code: "http_status", cause_status: 404 });
  });

  it("guarda o código de erro de rede do Node", () => {
    const rede = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const erro = new ExtensionError("extension_download_failed", { cause: rede });
    expect(causaSegura(erro)).toEqual({ cause_code: "ECONNREFUSED", cause_status: null });
  });

  it("descarta texto livre: só código de forma estável e status inteiro saem daqui", () => {
    const erro = new ExtensionError("extension_download_failed", {
      cause: { code: "resposta <html> com dado do servidor", status: 404.5, message: "segredo" },
    });
    expect(causaSegura(erro)).toEqual({ cause_code: null, cause_status: null });
  });

  it("sem causa, devolve os dois campos nulos em vez de omiti-los", () => {
    expect(causaSegura(new ExtensionError("extension_digest_mismatch"))).toEqual({
      cause_code: null,
      cause_status: null,
    });
    expect(causaSegura("não é erro")).toEqual({ cause_code: null, cause_status: null });
  });
});
