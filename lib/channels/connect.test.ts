import { beforeEach, expect, it, vi } from "vitest";

import { validatePartnerCredentials } from "./connect";

const contaZap = {
  _id: "a".repeat(24),
  platform: "whatsapp",
  displayName: "Loja",
  metadata: { displayPhoneNumber: "5511999999999", qualityRating: "GREEN" },
};

function respostasContas(contas: unknown[], perfis: unknown[] = [], perfisFalham = false) {
  return async (url: string) => {
    if (String(url).endsWith("/v1/accounts")) return new Response(JSON.stringify({ accounts: contas }));
    if (String(url).endsWith("/v1/profiles")) {
      if (perfisFalham) throw new Error("rede caiu");
      return new Response(JSON.stringify({ profiles: perfis }));
    }
    return new Response("{}", { status: 404 });
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("aceita a conta de WhatsApp ao alcance da chave", async () => {
  vi.stubGlobal("fetch", respostasContas([contaZap]));
  await expect(
    validatePartnerCredentials({ accountId: "a".repeat(24), apiKey: "chave-valida" }),
  ).resolves.toMatchObject({ ok: true, displayName: "Loja" });
});

it("diz que a chave não lista nada quando a lista vem vazia", async () => {
  vi.stubGlobal("fetch", respostasContas([]));
  await expect(
    validatePartnerCredentials({ accountId: "b".repeat(24), apiKey: "chave-valida" }),
  ).resolves.toEqual({
    ok: false,
    reason: "A chave não lista nenhuma conta. Confira o perfil e a conta no painel do provedor.",
  });
});

it("avisa que ali vai id de CONTA quando colam um id de PERFIL", async () => {
  const perfil = "c".repeat(24);
  vi.stubGlobal("fetch", respostasContas([], [{ _id: perfil, name: "Empresa" }]));
  await expect(
    validatePartnerCredentials({ accountId: perfil, apiKey: "chave-valida" }),
  ).resolves.toEqual({
    ok: false,
    reason: "Este id é de um PERFIL. Aqui vai o id da CONTA.",
  });
});

it("distingue conta fora do alcance quando a chave lista outras contas", async () => {
  vi.stubGlobal("fetch", respostasContas([contaZap]));
  await expect(
    validatePartnerCredentials({ accountId: "b".repeat(24), apiKey: "chave-valida" }),
  ).resolves.toEqual({
    ok: false,
    reason: "Conta fora do alcance desta chave. Confira se a conta pertence ao perfil desta chave.",
  });
});

it("a checagem de perfil é best-effort: falhou, vale a mensagem do caso", async () => {
  vi.stubGlobal("fetch", respostasContas([], [], true));
  await expect(
    validatePartnerCredentials({ accountId: "b".repeat(24), apiKey: "chave-valida" }),
  ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("não lista nenhuma conta") });
});

it("recusa conta de outra rede e chave recusada como antes", async () => {
  vi.stubGlobal("fetch", respostasContas([{ ...contaZap, platform: "instagram" }]));
  await expect(
    validatePartnerCredentials({ accountId: "a".repeat(24), apiKey: "chave-valida" }),
  ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("não de WhatsApp") });
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
  await expect(
    validatePartnerCredentials({ accountId: "a".repeat(24), apiKey: "chave-errada" }),
  ).resolves.toEqual({ ok: false, reason: "Chave recusada pelo provedor." });
});
