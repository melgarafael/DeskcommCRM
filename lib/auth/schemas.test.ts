/**
 * Issue #4313 — a senha acima do teto do bcrypt tem de ser recusada pelo
 * schema, com uma frase que diga o motivo, ANTES de qualquer chamada ao GoTrue.
 *
 * A régua é BYTES, não caracteres: o bcrypt (e o GoTrue, que o usa) só considera
 * os primeiros 72 bytes. Medido no GoTrue local: uma senha de 38 caracteres com
 * acento (74 bytes) volta `400 validation_failed`, "Password cannot be longer
 * than 72 characters". Por isso o caso multibyte é testado à parte — um
 * `.max(72)` cru (caracteres) passaria nele e a pessoa só descobriria no erro
 * genérico da tela.
 *
 * O mesmo teto vale nos TRÊS caminhos em que a pessoa escolhe a própria senha:
 * definir a nova senha, cadastro e aceite de convite. Os casos das actions
 * (recusa sem chamar o GoTrue e mapeamento do erro do provedor) ficam em
 * `app/actions/auth/updatePassword.test.ts` e `signUp.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  LIMITE_DA_SENHA_EM_BYTES,
  resetPasswordSchema,
  SENHA_LONGA_DEMAIS,
  signupComConviteSchema,
  signupSchema,
} from "./schemas";

/** A mesma frase que a tela mostra — chave do dicionário (pt → es). */
const MENSAGEM = SENHA_LONGA_DEMAIS;

/** 72 bytes exatos: 4 + 68 caracteres ASCII, um byte cada. */
const SENHA_72_BYTES = `Aa1!${"b".repeat(68)}`;
/** 73 bytes: um caractere ASCII acima do teto do bcrypt. */
const SENHA_73_BYTES = `${SENHA_72_BYTES}b`;
/** 80 caracteres — o caso relatado na issue. */
const SENHA_80 = `Aa1!${"b".repeat(76)}`;

const cadastro = (senha: string) => ({
  org_name: "Empresa Medida",
  email: "medida@example.com",
  password: senha,
  password_confirm: senha,
});

const convite = (senha: string) => ({
  full_name: "Ana Medida",
  email: "medida@example.com",
  password: senha,
  password_confirm: senha,
});

describe("senha — teto de 72 bytes (#4313)", () => {
  it("resetPasswordSchema recusa 73 caracteres com a mensagem nova", () => {
    expect(Buffer.byteLength(SENHA_73_BYTES, "utf8")).toBe(73);

    const parsed = resetPasswordSchema.safeParse({
      password: SENHA_73_BYTES,
      password_confirm: SENHA_73_BYTES,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.flatten().fieldErrors.password).toContain(MENSAGEM);
  });

  it("resetPasswordSchema aceita exatamente 72 bytes", () => {
    expect(Buffer.byteLength(SENHA_72_BYTES, "utf8")).toBe(LIMITE_DA_SENHA_EM_BYTES);

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

    const parsed = resetPasswordSchema.safeParse({ password: senha, password_confirm: senha });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.flatten().fieldErrors.password).toContain(MENSAGEM);
  });

  it("cadastro e aceite de convite recusam acima do limite com a mensagem nova", () => {
    for (const [nome, schema, entrada] of [
      ["cadastro", signupSchema, cadastro(SENHA_80)],
      ["convite", signupComConviteSchema, convite(SENHA_80)],
      ["cadastro (73 bytes)", signupSchema, cadastro(SENHA_73_BYTES)],
      ["convite (73 bytes)", signupComConviteSchema, convite(SENHA_73_BYTES)],
    ] as const) {
      const parsed = schema.safeParse(entrada);
      expect(parsed.success, `${nome} deveria recusar`).toBe(false);
      expect(parsed.error?.flatten().fieldErrors.password, nome).toContain(MENSAGEM);
    }
  });

  it("cadastro e aceite de convite aceitam 72 bytes e mantêm o mínimo de 8", () => {
    for (const [nome, schema, entrada] of [
      ["cadastro", signupSchema, cadastro(SENHA_72_BYTES)],
      ["convite", signupComConviteSchema, convite(SENHA_72_BYTES)],
    ] as const) {
      expect(schema.safeParse(entrada).success, `${nome} deveria aceitar 72 bytes`).toBe(true);
      // O teto NOVO não pode ter afrouxado o mínimo que já existia.
      expect(schema.safeParse(entrada && { ...entrada, password: "Aa1!", password_confirm: "Aa1!" }).success).toBe(
        false,
      );
    }
  });
});
