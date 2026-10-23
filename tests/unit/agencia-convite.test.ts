import { describe, expect, it } from "vitest";

import {
  gerarTokenDeConvite,
  hashDoToken,
  linkDoConvite,
  mesmoEmail,
  normalizarWhatsapp,
  situacaoDoConvite,
  tokenTemFormatoValido,
} from "@/lib/agencia/convite";

const AGORA = new Date("2026-10-23T12:00:00Z");
const DEPOIS = "2026-10-30T12:00:00Z";
const ANTES = "2026-10-22T12:00:00Z";

describe("token do convite", () => {
  it("o banco guarda o hash, nunca o token", () => {
    const { token, hash } = gerarTokenDeConvite();
    expect(hash).toBe(hashDoToken(token));
    expect(hash).not.toContain(token);
    expect(tokenTemFormatoValido(token)).toBe(true);
  });

  it("dois convites nunca têm o mesmo token", () => {
    expect(gerarTokenDeConvite().token).not.toBe(gerarTokenDeConvite().token);
  });

  it("recusa formato que não é o gerado", () => {
    expect(tokenTemFormatoValido("abc")).toBe(false);
    expect(tokenTemFormatoValido("../../etc/passwd".padEnd(43, "a"))).toBe(false);
  });

  it("o link aponta para a área da agência, sem barra dupla", () => {
    expect(linkDoConvite("https://teste.exemplo/", "tok")).toBe("https://teste.exemplo/agencia/convite/tok");
  });
});

describe("situacaoDoConvite", () => {
  it("vale dentro do prazo", () => {
    expect(situacaoDoConvite({ expira_em: DEPOIS, aceito_em: null, revogado_em: null }, AGORA)).toBe("valido");
  });
  it("expira", () => {
    expect(situacaoDoConvite({ expira_em: ANTES, aceito_em: null, revogado_em: null }, AGORA)).toBe("expirado");
  });
  it("vale uma vez só", () => {
    expect(situacaoDoConvite({ expira_em: DEPOIS, aceito_em: ANTES, revogado_em: null }, AGORA)).toBe("aceito");
  });
  it("revogado vence tudo", () => {
    expect(situacaoDoConvite({ expira_em: DEPOIS, aceito_em: ANTES, revogado_em: ANTES }, AGORA)).toBe("revogado");
  });
  it("sem linha", () => {
    expect(situacaoDoConvite(null, AGORA)).toBe("inexistente");
  });
});

describe("normalizarWhatsapp", () => {
  it.each([
    ["(11) 91234-5678", "+5511912345678"],
    ["11912345678", "+5511912345678"],
    ["+55 11 91234-5678", "+5511912345678"],
    ["5511912345678", "+5511912345678"],
    ["(11) 3123-4567", "+551131234567"],
    ["+1 415 555 0100", "+14155550100"],
  ])("%s → %s", (entrada, saida) => {
    expect(normalizarWhatsapp(entrada)).toBe(saida);
  });

  it.each(["", "123", "abc", "+0 11 9999"])("recusa %s", (entrada) => {
    expect(normalizarWhatsapp(entrada)).toBeNull();
  });
});

describe("mesmoEmail", () => {
  it("ignora caixa e espaço", () => {
    expect(mesmoEmail(" Ana@Agencia.com ", "ana@agencia.com")).toBe(true);
    expect(mesmoEmail("ana@agencia.com", "bia@agencia.com")).toBe(false);
  });
});
