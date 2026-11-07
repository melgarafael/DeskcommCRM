/**
 * A credencial da sessão conectada por um clique é um PONTEIRO (migration 9093):
 * a chave da instalação é lida na hora, e trocá-la vale para todas as sessões.
 * A sessão com chave própria segue lendo a cópia cifrada dela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ valor: vi.fn(), decifra: vi.fn() }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: h.valor }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: h.decifra }));

import { chaveDaInstalacao, zernioCredsForAccountId } from "./credentials";

function db(linha: Record<string, unknown> | null) {
  const q = {
    select: () => q,
    eq: () => q,
    is: () => q,
    maybeSingle: async () => ({ data: linha, error: null }),
  };
  return { from: () => q } as never;
}

const lookup = { organizationId: "org-1", accountId: "conta-1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.valor.mockResolvedValue({ valor: "  chave-da-instalacao  ", fonte: "banco" });
  h.decifra.mockResolvedValue("chave-propria");
});

describe("chaveDaInstalacao", () => {
  it("lê pelo resolvedor e tira os espaços; vazia é `null`", async () => {
    expect(await chaveDaInstalacao()).toBe("chave-da-instalacao");
    expect(h.valor).toHaveBeenCalledWith("ZERNIO_PLATFORM_API_KEY");
    h.valor.mockResolvedValue({ valor: "  ", fonte: "ambiente" });
    expect(await chaveDaInstalacao()).toBeNull();
  });
});

describe("zernioCredsForAccountId", () => {
  it("sessão pela instalação fala com a chave da instalação, sem decifrar nada", async () => {
    const creds = await zernioCredsForAccountId(
      db({
        zernio_account_id: "conta-1",
        zernio_token_encrypted: null,
        zernio_credencial_da_instalacao: true,
      }),
      lookup,
    );
    expect(creds).toMatchObject({
      accountId: "conta-1",
      apiKey: "chave-da-instalacao",
      source: "installation",
    });
    expect(h.decifra).not.toHaveBeenCalled();
  });

  it("sessão pela instalação sem a chave configurada: `null` (o chamador cai no .env)", async () => {
    h.valor.mockResolvedValue({ valor: null, fonte: "ausente" });
    expect(
      await zernioCredsForAccountId(
        db({
          zernio_account_id: "conta-1",
          zernio_token_encrypted: null,
          zernio_credencial_da_instalacao: true,
        }),
        lookup,
      ),
    ).toBeNull();
  });

  it("sessão com chave própria segue lendo a cópia cifrada dela", async () => {
    const creds = await zernioCredsForAccountId(
      db({
        zernio_account_id: "conta-1",
        zernio_token_encrypted: "cifrada",
        zernio_credencial_da_instalacao: false,
      }),
      lookup,
    );
    expect(creds).toMatchObject({ apiKey: "chave-propria", source: "session" });
    expect(h.valor).not.toHaveBeenCalled();
  });
});
