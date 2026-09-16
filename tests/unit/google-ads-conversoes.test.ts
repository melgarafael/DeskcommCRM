/**
 * O transporte de conversão do Google Ads — as partes puras (sem rede) e a
 * leitura de credencial (com admin fake). Cada bloco existe por um modo de
 * falha concreto: state adulterado, resposta de token sem access_token,
 * refresh_token perdido numa renovação, erro classificado errado.
 */
import { describe, expect, it } from "vitest";

import {
  fundirTokens,
  lerRespostaDeToken,
  montarUrlDeConsentimento,
} from "@/lib/plataformas-de-anuncio/google/oauth";
import { emitirEstado, verificarEstado } from "@/lib/plataformas-de-anuncio/google/estado";
import { INTERNOS } from "@/lib/plataformas-de-anuncio/google/conversions";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";

const SEGREDO = "0123456789abcdef0123456789abcdef";
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

describe("montarUrlDeConsentimento", () => {
  it("lança sem clientId", () => {
    expect(() =>
      montarUrlDeConsentimento({ clientId: "", redirectUri: "https://x/cb" }, { state: "s" }),
    ).toThrow(/GOOGLE_ADS_OAUTH_CLIENT_ID/);
  });

  it("monta a URL com access_type=offline e prompt=consent — sem os dois não vem refresh_token", () => {
    const url = montarUrlDeConsentimento(
      { clientId: "cid", redirectUri: "https://x/cb" },
      { state: "abc" },
    );
    const params = new URL(url).searchParams;
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(params.get("state")).toBe("abc");
  });
});

describe("lerRespostaDeToken", () => {
  const agora = new Date("2026-01-01T00:00:00Z");

  it("lê sucesso e converte expires_in relativo em instante absoluto", () => {
    const r = lerRespostaDeToken(
      { access_token: "tok", refresh_token: "ref", expires_in: 3600, token_type: "Bearer" },
      { agora },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.token.access_token).toBe("tok");
      expect(r.token.expira_em).toBe(new Date(agora.getTime() + 3600_000).toISOString());
    }
  });

  it("aceita expires_in como STRING (alguns proxies serializam assim)", () => {
    const r = lerRespostaDeToken({ access_token: "tok", expires_in: "3600" }, { agora });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token.expira_em).toBe(new Date(agora.getTime() + 3600_000).toISOString());
  });

  it("erro do Google vira erro_do_google, com a descrição junto", () => {
    const r = lerRespostaDeToken(
      { error: "invalid_grant", error_description: "Token has been expired or revoked." },
      { agora },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toBe("erro_do_google");
      expect(r.detalhe).toContain("invalid_grant");
    }
  });

  it("resposta sem access_token não passa por sucesso silencioso", () => {
    const r = lerRespostaDeToken({ token_type: "Bearer" }, { agora });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("sem_access_token");
  });

  it("resposta que não é objeto não lança", () => {
    const r = lerRespostaDeToken("string qualquer", { agora });
    expect(r.ok).toBe(false);
  });
});

describe("fundirTokens", () => {
  it("preserva o refresh_token do token ATUAL quando a renovação não traz um novo", () => {
    const atual = {
      access_token: "velho",
      refresh_token: "ref-original",
      token_type: "Bearer",
      expira_em: "2026-01-01T00:00:00.000Z",
    };
    const renovado = {
      access_token: "novo",
      refresh_token: null,
      token_type: "Bearer",
      expira_em: "2026-01-01T01:00:00.000Z",
    };
    const fundido = fundirTokens(atual, renovado);
    expect(fundido.access_token).toBe("novo");
    expect(fundido.refresh_token).toBe("ref-original");
  });
});

describe("estado (state assinado)", () => {
  it("emite e verifica — vai e volta", () => {
    const agora = new Date("2026-01-01T00:00:00Z");
    const state = emitirEstado({ organizationId: ORG, userId: USER }, { segredo: SEGREDO, agora });
    const lido = verificarEstado(state, { segredo: SEGREDO, agora });
    expect(lido).toMatchObject({ organizationId: ORG, userId: USER });
  });

  it("recusa depois do prazo", () => {
    const agora = new Date("2026-01-01T00:00:00Z");
    const state = emitirEstado(
      { organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora, validadeMs: 1000 },
    );
    const depois = new Date(agora.getTime() + 2000);
    expect(verificarEstado(state, { segredo: SEGREDO, agora: depois })).toBeNull();
  });

  it("recusa assinatura adulterada", () => {
    const agora = new Date("2026-01-01T00:00:00Z");
    const state = emitirEstado({ organizationId: ORG, userId: USER }, { segredo: SEGREDO, agora });
    const adulterado = state.slice(0, -2) + "00";
    expect(verificarEstado(adulterado, { segredo: SEGREDO, agora })).toBeNull();
  });

  it("recusa quando assinado com OUTRO segredo", () => {
    const agora = new Date("2026-01-01T00:00:00Z");
    const state = emitirEstado(
      { organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora },
    );
    expect(verificarEstado(state, { segredo: "outro-segredo-bem-diferente-0000", agora })).toBeNull();
  });

  it("lança com segredo curto demais", () => {
    expect(() =>
      emitirEstado({ organizationId: ORG, userId: USER }, { segredo: "curto", agora: new Date() }),
    ).toThrow(/curto demais/);
  });
});

describe("formatarDataDeConversao", () => {
  it("formata em UTC no formato exato que a API exige", () => {
    const data = new Date(Date.UTC(2026, 8, 15, 10, 30, 5));
    expect(INTERNOS.formatarDataDeConversao(data)).toBe("2026-09-15 10:30:05+00:00");
  });
});

describe("soDigitos", () => {
  it("remove hífens do customer id", () => {
    expect(INTERNOS.soDigitos("123-456-7890")).toBe("1234567890");
  });
});

describe("classificaErro", () => {
  it("5xx é transitório", () => {
    expect(INTERNOS.classificaErro(503, {}).tipo).toBe("transitorio");
  });

  it("RESOURCE_EXHAUSTED é transitório mesmo com status HTTP 400", () => {
    expect(INTERNOS.classificaErro(400, { status: "RESOURCE_EXHAUSTED" }).tipo).toBe("transitorio");
  });

  it("token/argumento inválido é permanente — precisa de alguém mexer na configuração", () => {
    const r = INTERNOS.classificaErro(401, { status: "UNAUTHENTICATED", message: "token inválido" });
    expect(r.tipo).toBe("permanente");
  });
});

describe("lerCredencial — ramo google_ads", () => {
  function fakeAdmin(linha: Record<string, unknown> | null) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: linha, error: null }),
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: "refresh-token-decifrado", error: null }),
    };
  }

  it("credencial_incompleta sem os três identificadores", async () => {
    const admin = fakeAdmin({
      enabled: true,
      google_refresh_token_encrypted: null,
      google_customer_id: null,
      google_conversion_action_id: null,
      google_login_customer_id: null,
      dataset_id: null,
      access_token_encrypted: null,
      test_event_code: null,
    });
    const r = await lerCredencial(admin as never, ORG, "google_ads");
    expect(r).toEqual({ ok: false, motivo: "credencial_incompleta" });
  });

  it("conexao_desabilitada quando enabled=false, mesmo com tudo preenchido", async () => {
    const admin = fakeAdmin({
      enabled: false,
      google_refresh_token_encrypted: "\\xdeadbeef",
      google_customer_id: "1234567890",
      google_conversion_action_id: "987",
      google_login_customer_id: null,
      dataset_id: null,
      access_token_encrypted: null,
      test_event_code: null,
    });
    const r = await lerCredencial(admin as never, ORG, "google_ads");
    expect(r).toEqual({ ok: false, motivo: "conexao_desabilitada" });
  });

  it("completa: decifra o refresh token e devolve os identificadores, accessToken vazio", async () => {
    const admin = fakeAdmin({
      enabled: true,
      google_refresh_token_encrypted: "\\xdeadbeef",
      google_customer_id: "1234567890",
      google_conversion_action_id: "987",
      google_login_customer_id: "5555555555",
      dataset_id: null,
      access_token_encrypted: null,
      test_event_code: null,
    });
    const r = await lerCredencial(admin as never, ORG, "google_ads");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.credencial.accessToken).toBe("");
      expect(r.credencial.google).toEqual({
        refreshToken: "refresh-token-decifrado",
        customerId: "1234567890",
        loginCustomerId: "5555555555",
        conversionActionId: "987",
      });
    }
  });
});
