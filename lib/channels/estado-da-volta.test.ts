/**
 * O estado da conexão por um clique: só volta o que a ida assinou, íntegro e no prazo.
 */
import { describe, expect, it } from "vitest";

import {
  FORMATO_DO_ESTADO,
  VALIDADE_DO_ESTADO_MS,
  emitirEstadoDaVolta,
  verificarEstadoDaVolta,
} from "./estado-da-volta";

const SEGREDO = "segredo-de-teste-com-mais-de-16";
const AGORA = new Date("2026-10-20T20:00:00Z");
const DADOS = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  profileId: "a".repeat(24),
};

describe("estado da volta", () => {
  it("o que a ida assina volta igual, e cabe num segmento de URL", () => {
    const token = emitirEstadoDaVolta(DADOS, { segredo: SEGREDO, agora: AGORA });
    expect(FORMATO_DO_ESTADO.test(token)).toBe(true);
    expect(verificarEstadoDaVolta(token, { segredo: SEGREDO, agora: AGORA })).toEqual({
      ...DADOS,
      expiraEmMs: AGORA.getTime() + VALIDADE_DO_ESTADO_MS,
    });
  });

  it("vencido não vale", () => {
    const token = emitirEstadoDaVolta(DADOS, { segredo: SEGREDO, agora: AGORA });
    const depois = new Date(AGORA.getTime() + VALIDADE_DO_ESTADO_MS + 1);
    expect(verificarEstadoDaVolta(token, { segredo: SEGREDO, agora: depois })).toBeNull();
  });

  it("assinado com outro segredo não vale", () => {
    const token = emitirEstadoDaVolta(DADOS, {
      segredo: "outro-segredo-qualquer-123",
      agora: AGORA,
    });
    expect(verificarEstadoDaVolta(token, { segredo: SEGREDO, agora: AGORA })).toBeNull();
  });

  it("carga trocada (outro perfil) com a assinatura antiga não vale", () => {
    const token = emitirEstadoDaVolta(DADOS, { segredo: SEGREDO, agora: AGORA });
    const [carga = "", assinatura = ""] = token.split(".");
    const outra = Buffer.from(
      Buffer.from(carga, "base64url").toString("utf8").replace("a".repeat(24), "b".repeat(24)),
    ).toString("base64url");
    expect(
      verificarEstadoDaVolta(`${outra}.${assinatura}`, { segredo: SEGREDO, agora: AGORA }),
    ).toBeNull();
  });

  it.each([null, "", "lixo", "a.b", `${"x".repeat(30)}.${"0".repeat(64)}`])(
    "entrada ruim (%s) devolve null sem lançar",
    (token) => {
      expect(verificarEstadoDaVolta(token, { segredo: SEGREDO, agora: AGORA })).toBeNull();
    },
  );

  it("recusa emitir sem segredo forte ou com campo que quebraria a carga", () => {
    expect(() => emitirEstadoDaVolta(DADOS, { segredo: "curto", agora: AGORA })).toThrow();
    expect(() =>
      emitirEstadoDaVolta({ ...DADOS, profileId: "a.b" }, { segredo: SEGREDO, agora: AGORA }),
    ).toThrow();
  });
});
