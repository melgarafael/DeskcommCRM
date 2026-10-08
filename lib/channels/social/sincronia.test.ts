import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "provider-key",
  encryptWebhookSecret: async () => "nova-cifra",
}));
vi.mock("../zernio/credentials", () => ({ zernioBaseUrl: () => "https://zernio.test" }));

import { configureSocialIntegration } from "./store";

const org = "org-1";
const perfil = "p".repeat(24);

type Escrita = { tabela: string; patch: Record<string, unknown>; filtros: Record<string, unknown> };

function fakeDb() {
  const escritas: Escrita[] = [];
  const db = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      let inseriu = false;
      const q = {
        select: () => q,
        upsert: (p: Record<string, unknown>) => ((patch = p), (inseriu = true), q),
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (k: string, v: unknown) => ((filtros[k] = v), q),
        is: (k: string, v: unknown) => ((filtros[k] = v), q),
        maybeSingle: async () => {
          if (inseriu) {
            escritas.push({ tabela, patch: patch ?? {}, filtros });
            return { data: null, error: null };
          }
          return { data: { profile_id: perfil }, error: null };
        },
        then: (resolve: (r: unknown) => void) => {
          if (patch && !inseriu) escritas.push({ tabela, patch, filtros });
          resolve({ data: null, error: null });
        },
      };
      return q;
    },
  };
  return { db: db as never, escritas };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", h.fetch);
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify({ profiles: [{ _id: perfil }] })),
  );
});

/**
 * Regressão da divergência (spec 22, D1): a chave do perfil é gerenciar, a
 * cópia por canal é fundos. Quando a chave troca no provedor, reconfigurar
 * reescreve a cópia de TODOS os canais do perfil — inclusive os arquivados,
 * que podem voltar — e nenhuma sessão velha prende a faixa.
 */
it("reescreve a cópia da chave em todos os canais do perfil, sem exceto-arquivado", async () => {
  const { db, escritas } = fakeDb();
  await configureSocialIntegration(db, org, "nova-chave-do-provedor", perfil);
  const canais = escritas.filter((e) => e.tabela === "channel_sessions");
  expect(canais).toHaveLength(1);
  expect(canais[0]?.patch).toMatchObject({ zernio_token_encrypted: "nova-cifra" });
  // Sem filtro de arquivamento: o update alcança ativas E arquivadas.
  expect(canais[0]?.filtros).toEqual({ organization_id: org, provider: "zernio_social" });
  expect(canais[0]?.filtros).not.toHaveProperty("archived_at");
});

it("continua recusando perfil diferente, sem tocar nos canais", async () => {
  const { db, escritas } = fakeDb();
  const outro = "o".repeat(24);
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify({ profiles: [{ _id: perfil }, { _id: outro }] })),
  );
  await expect(configureSocialIntegration(db, org, "chave", outro)).rejects.toThrow(
    /outro perfil/,
  );
  expect(escritas.filter((e) => e.tabela === "channel_sessions")).toHaveLength(0);
});
