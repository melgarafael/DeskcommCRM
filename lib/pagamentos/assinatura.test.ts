import { describe, expect, it } from "vitest";

import {
  CABECALHO_DO_TOKEN,
  hashDoToken,
  novoTokenDoAviso,
  urlDoAviso,
  verificarOrigem,
} from "./assinatura";

const { token: TOKEN, hash: HASH } = novoTokenDoAviso();
const REC = "cccccccc-0000-4000-8000-000000000005";

describe("a prova de origem do aviso de pagamento", () => {
  it("o hash guardado é o sha256 hex do segredo, e o segredo é longo", () => {
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoToken(TOKEN)).toBe(HASH);
    expect(TOKEN.length).toBeGreaterThanOrEqual(43);
  });

  it("⭐ segredo na URL que confere: aceita, e diz que veio pela URL", () => {
    expect(verificarOrigem(new Headers(), TOKEN, HASH)).toEqual({ ok: true, modo: "url_token" });
  });

  it("⭐ segredo de OUTRO recebimento: recusa", () => {
    expect(verificarOrigem(new Headers(), novoTokenDoAviso().token, HASH)).toEqual({
      ok: false,
      motivo: "token_invalido",
    });
  });

  it("segredo em cabeçalho que confere: aceita", () => {
    expect(verificarOrigem(new Headers({ [CABECALHO_DO_TOKEN]: TOKEN }), null, HASH)).toEqual({
      ok: true,
      modo: "token",
    });
  });

  it("⭐ cabeçalho presente e errado NÃO cai para a URL certa (fail closed)", () => {
    expect(verificarOrigem(new Headers({ [CABECALHO_DO_TOKEN]: "errado" }), TOKEN, HASH).ok).toBe(false);
  });

  it("⭐ sem segredo nenhum: recusa (ausência de prova não é prova)", () => {
    expect(verificarOrigem(new Headers(), null, HASH)).toEqual({ ok: false, motivo: "sem_token" });
    expect(verificarOrigem(new Headers(), "", HASH).ok).toBe(false);
  });

  it("hash guardado fora da forma: recusa, sem exceção", () => {
    expect(verificarOrigem(new Headers(), TOKEN, "curto").ok).toBe(false);
  });
});

describe("o endereço de aviso entregue à atendente", () => {
  it("⭐ leva o id do recebimento e o segredo por NOME, e o caminho do provedor", () => {
    const url = new URL(urlDoAviso("https://crm.exemplo.com.br/", "infinitepay", REC, TOKEN)!);
    expect(url.origin + url.pathname).toBe("https://crm.exemplo.com.br/api/v1/webhooks/pagamento/infinitepay");
    expect(url.searchParams.get("r")).toBe(REC);
    expect(url.searchParams.get("t")).toBe(TOKEN);
  });

  it.each(["http://localhost:3000", "https://placeholder.invalid", "http://crm.exemplo.com.br", "https://app", ""])(
    "⭐ %j não abre fora da máquina (ou não é https): nenhum endereço",
    (base) => {
      expect(urlDoAviso(base, "infinitepay", REC, TOKEN)).toBeNull();
    },
  );
});
