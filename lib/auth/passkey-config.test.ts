/**
 * PASSKEY — a fatia 1 da #1164 medida em português de teste.
 *
 * O provider passkey só é registrado quando a instalação ligou e configurou o
 * RP (senão é um provider que só sabe falhar). Um fator webauthn verificado
 * conta como "MFA cadastrado" tanto quanto um TOTP. E o transporte binário
 * (server action ↔ navegador) preserva o JSON do browser em round-trip.
 */
import { describe, expect, it } from "vitest";

import {
  base64urlParaBytes,
  configPasskeyDoAmbiente,
  desserializarOpcoesCriacao,
  ENV_PASSKEY_LIGADO,
  ENV_RP_ID,
  reconstruirCredencialDeRegistro,
  serializarOpcoesCriacao,
  temSegundoFatorVerificado,
  type CredencialDeRegistroJSON,
} from "@/lib/auth/passkey-config";

describe("configPasskeyDoAmbiente — não oferecer provider que só sabe falhar", () => {
  it("desligado por padrão: sem a flag, passkey não aparece em instalação nenhuma", () => {
    expect(configPasskeyDoAmbiente({}).disponivel).toBe(false);
    expect(
      configPasskeyDoAmbiente({ [ENV_RP_ID]: "crm.exemplo.com" }).disponivel,
    ).toBe(false);
  });

  it("ligado exige o RP ID — sem ele o GoTrue recusa TODO challenge", () => {
    expect(
      configPasskeyDoAmbiente({ [ENV_PASSKEY_LIGADO]: "true" }).disponivel,
    ).toBe(false);
  });

  it("ligado E com RP ID: disponível, com o rpId para o GoTrue", () => {
    const c = configPasskeyDoAmbiente({
      [ENV_PASSKEY_LIGADO]: "true",
      [ENV_RP_ID]: "crm.exemplo.com",
    });
    expect(c).toEqual({ disponivel: true, rpId: "crm.exemplo.com", rpOrigins: [] });
  });

  it('flag diferente de "true" não liga — "false" e "TRUE" mantêm desligado', () => {
    for (const v of ["false", "TRUE", "1", ""]) {
      expect(
        configPasskeyDoAmbiente({ [ENV_PASSKEY_LIGADO]: v, [ENV_RP_ID]: "crm.exemplo.com" })
          .disponivel,
      ).toBe(false);
    }
  });

  it("origens opcionais; presentes, são separadas por vírgula/espaço", () => {
    const c = configPasskeyDoAmbiente({
      [ENV_PASSKEY_LIGADO]: "true",
      [ENV_RP_ID]: "crm.exemplo.com",
      DESKCOMM_MFA_WEBAUTHN_RP_ORIGINS: "https://crm.exemplo.com, https://admin.exemplo.com",
    });
    expect(c.rpOrigins).toEqual([
      "https://crm.exemplo.com",
      "https://admin.exemplo.com",
    ]);
  });
});

describe("temSegundoFatorVerificado — webauthn conta como TOTP", () => {
  const verificado = (factor_type: string) => ({ factor_type, status: "verified" });

  it("sem fatores, nada", () => {
    expect(temSegundoFatorVerificado(null)).toBe(false);
    expect(temSegundoFatorVerificado(undefined)).toBe(false);
    expect(temSegundoFatorVerificado([])).toBe(false);
  });

  it("TOTP verificado responde sim — o comportamento que JÁ existia", () => {
    expect(temSegundoFatorVerificado([verificado("totp")])).toBe(true);
  });

  it("webauthn verificado também responde sim — a mudança que esta issue traz", () => {
    // ANTES, o app olhava só `data.totp`; um fator passkey verificado era
    // invisível na pergunta "essa conta tem segundo fator?".
    expect(temSegundoFatorVerificado([verificado("webauthn")])).toBe(true);
    expect(
      temSegundoFatorVerificado([
        { factor_type: "webauthn", status: "unverified" },
        verificado("webauthn"),
      ]),
    ).toBe(true);
  });

  it("fator sem verificacao (unverified, ex.: cadastro incompleto) não basta", () => {
    expect(
      temSegundoFatorVerificado([{ factor_type: "webauthn", status: "unverified" }]),
    ).toBe(false);
  });

  it("outros tipos de fator não contam como segundo fator", () => {
    expect(temSegundoFatorVerificado([verificado("phone"), verificado("recovery_code")])).toBe(false);
  });
});

describe("transporte binário servidor↔navegador", () => {
  it("creation options: round-trip preserva challenge, user.id e excludeCredentials", () => {
    const original = {
      challenge: new Uint8Array([1, 2, 3, 250]),
      rp: { id: "crm.exemplo.com", name: "Deskcomm" },
      user: { id: new Uint8Array([9, 8, 7]), name: "ana", displayName: "Ana" },
      pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }],
      excludeCredentials: [{ type: "public-key" as const, id: new Uint8Array([5, 6]) }],
    };

    const ser = serializarOpcoesCriacao(original);
    expect(ser.challenge).toBe("AQID-g"); // base64url de [1,2,3,250] (62 → '-', não '+')
    expect(ser.user.id).toBe("CQgH"); // base64url de [9,8,7]

    const de = desserializarOpcoesCriacao(ser);
    expect(Array.from(de.challenge as Uint8Array)).toEqual([1, 2, 3, 250]);
    expect(Array.from((de.user as { id: Uint8Array }).id)).toEqual([9, 8, 7]);
    expect(Array.from((de as { excludeCredentials?: { id: Uint8Array }[] }).excludeCredentials![0]!.id)).toEqual([5, 6]);
    // metadados não-binários atravessam intactos
    expect(de.rp).toEqual(original.rp);
    expect(de.user as { name?: string }).toMatchObject({ name: "ana" });
  });

  it("credencial de registro: o JSON que o navegador devolve vira o que a mfa.verify re-serializa igual", () => {
    const json: CredencialDeRegistroJSON = {
      id: "cred-id",
      type: "public-key",
      response: {
        clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0", // {"type":"webauthn.create"}
        attestationObject: "o2NmbXRkbm9uZQ", // \xa6cmt... (não-nulo)
      },
      clientExtensionResults: { credProps: { rk: true } },
      authenticatorAttachment: "platform",
    };

    const bruta = reconstruirCredencialDeRegistro(json);
    expect(bruta.rawId).toBeInstanceOf(Uint8Array);
    // round-trip: bytes → base64url devolve exatamente o que o browser mandou
    expect(Buffer.from(bruta.response.clientDataJSON).toString("base64url")).toBe(
      json.response.clientDataJSON,
    );
    expect(Buffer.from(bruta.response.attestationObject).toString("base64url")).toBe(
      json.response.attestationObject,
    );

    // as extensões viajam para a serializer re-montar o `clientExtensionResults`
    expect(bruta.getClientExtensionResults()).toEqual({ credProps: { rk: true } });
    expect(bruta.authenticatorAttachment).toBe("platform");
    expect(bruta.id).toBe("cred-id");
  });

  it("base64urlParaBytes aceita com/sem padding e bytes grandes", () => {
    const bytes = new Uint8Array(64).map((_, i) => i);
    const b64 = Buffer.from(bytes).toString("base64url");
    expect(Array.from(base64urlParaBytes(b64))).toEqual(Array.from(bytes));
  });
});