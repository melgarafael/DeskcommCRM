import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { abrirArquivoDoWebhook } from "./arquivo-de-webhook";

function adminQueGuarda() {
  const linhas: Array<Record<string, unknown>> = [];
  const admin = {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        linhas.push(linha);
        return { select: () => ({ maybeSingle: async () => ({ data: { id: "linha-1" }, error: null }) }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { admin, linhas };
}

describe("o arquivo do webhook nunca guarda credencial no cabeçalho", () => {
  it("⭐ o token do Asaas não entra, mesmo que o aviso caia numa rota de canal", async () => {
    const { admin, linhas } = adminQueGuarda();
    const headers = new Headers({
      "asaas-access-token": "tok-secreto-do-asaas",
      authorization: "Bearer qualquer",
      "x-hub-signature-256": "sha256=abc",
    });
    await abrirArquivoDoWebhook(admin, {
      organizationId: "org",
      channelSessionId: "sessao",
      provider: "generic",
      rawBody: "{}",
      headers,
    });
    const guardados = linhas[0]?.headers as Record<string, string>;
    expect(guardados).not.toHaveProperty("asaas-access-token");
    expect(guardados).not.toHaveProperty("authorization");
    // Controle: a assinatura fica — é o que permite reconferir depois.
    expect(guardados["x-hub-signature-256"]).toBe("sha256=abc");
  });

  it("⭐ o segredo do webhook do robô do Telegram não entra (é o segredo inteiro, não assinatura)", async () => {
    const { admin, linhas } = adminQueGuarda();
    await abrirArquivoDoWebhook(admin, {
      organizationId: "org",
      channelSessionId: "sessao",
      provider: "telegram",
      rawBody: "{}",
      headers: new Headers({
        "X-Telegram-Bot-Api-Secret-Token": "segredo-do-setwebhook",
        "content-type": "application/json",
      }),
    });
    const guardados = linhas[0]?.headers as Record<string, string>;
    expect(Object.keys(guardados).map((k) => k.toLowerCase())).not.toContain("x-telegram-bot-api-secret-token");
    expect(JSON.stringify(linhas[0])).not.toContain("segredo-do-setwebhook");
    // Controle: o resto do cabeçalho fica.
    expect(guardados["content-type"]).toBe("application/json");
  });
});
