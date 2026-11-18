/**
 * Issue #4313 — o limite da senha é de 72 BYTES, não de 72 caracteres.
 *
 * O bcrypt (e o GoTrue, que o usa) só considera os primeiros 72 bytes da
 * senha. A régua importa porque acento conta 2 bytes em UTF-8 e emoji conta 4:
 * uma senha de 38 caracteres pode estourar o limite que 72 letras ASCII não
 * estouram. Por isso o caso multibyte é testado à parte — um `.max(72)` cru
 * (caracteres) passaria nele e a pessoa só descobriria no erro genérico.
 *
 * Os casos da action (recusa sem chamar o GoTrue e mapeamento do erro do
 * provedor) ficam em `app/actions/auth/updatePassword.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { resetPasswordSchema } from "./schemas";

/** A mesma frase da mensagem do schema — a chave do dicionário (pt → es). */
const MENSAGEM = "Senha longa demais: o limite é de 72 bytes";

/** 72 bytes exatos: 4 + 68 caracteres ASCII, um byte cada. */
const SENHA_72_BYTES = `Aa1!${"b".repeat(68)}`;

describe("resetPasswordSchema — teto de 72 bytes (bcrypt)", () => {
  it("aceita 72 bytes exatos", () => {
    expect(Buffer.byteLength(SENHA_72_BYTES, "utf8")).toBe(72);

    const parsed = resetPasswordSchema.safeParse({
      password: SENHA_72_BYTES,
      password_confirm: SENHA_72_BYTES,
    });

    expect(parsed.success).toBe(true);
  });

  it("recusa senha multibyte com menos de 72 caracteres e mais de 72 bytes", () => {
    // 36 "á" (2 bytes cada) + "1" + "!" = 38 caracteres e 74 bytes.
    const senha = `${"á".repeat(36)}1!`;
    expect(senha.length).toBe(38);
    expect(Buffer.byteLength(senha, "utf8")).toBe(74);

    const parsed = resetPasswordSchema.safeParse({
      password: senha,
      password_confirm: senha,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.flatten().fieldErrors.password).toContain(MENSAGEM);
  });

});
