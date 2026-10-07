import { beforeEach, expect, it, vi } from "vitest";

/**
 * A ASSINATURA ÓRFÃ SAI ANTES DO ARQUIVAMENTO (issue #2364).
 *
 * ## O defeito medido
 *
 * `connectSocialInbox` cria a assinatura no Zernio e SÓ DEPOIS grava
 * `metadata.social_webhook_id`. Uma gravação que falha deixa o canal `FAILED`
 * com a assinatura viva lá fora e nenhuma referência a ela aqui.
 *
 * `disconnectSocialAccount` então não apagava nada: arquivava a linha,
 * rotacionava o `webhook_path_token` — e a assinatura continuava entregando
 * evento numa URL que acabou de virar 404. Para sempre, sem erro do nosso lado:
 * o operador via o canal "desconectado" e o provedor seguia reenviando.
 *
 * ## O que este arquivo prova
 *
 * 1. Com o id AUSENTE, a assinatura é achada pela URL do canal e apagada ANTES
 *    do patch de arquivamento — e o canal sai pelo mesmo caminho das demais
 *    (STOPPED + `archived_at` + aviso de saúde fechado).
 * 2. Com o id PRESENTE nada muda: o caminho normal nem consulta a lista de
 *    assinaturas.
 * 3. A assinatura de OUTRO token não é tocada — casa-se pelo token desta linha.
 * 4. Provedor fora do ar segura a desconexão, sem arquivar pela metade: dá para
 *    tentar de novo (a mesma doutrina de "chamadas de provedor antes do DB").
 */

const h = vi.hoisted(() => ({ fetch: vi.fn(), health: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "provider-key",
  encryptWebhookSecret: async () => "enc",
}));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: h.health }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: h.warn, info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/channels/zernio/credentials", () => ({
  zernioBaseUrl: () => "https://zernio.test",
}));
import { disconnectSocialAccount } from "@/lib/channels/social/store";
import { SocialError } from "@/lib/channels/social/client";

const org = "org-1";
const account = "a".repeat(24);
/** O token da linha — é ele que a assinatura órfã aponta. */
const token = "b".repeat(48);
const outroToken = "c".repeat(48);
/** Ordem real dos efeitos: a assinatura tem sair ANTES da linha ser arquivada. */
const ordem: string[] = [];

type Update = { patch: Record<string, unknown>; filters: Record<string, unknown> };
function fakeDb(canais: Record<string, unknown>[]) {
  const updates: Update[] = [];
  const db = {
    from(tabela: string) {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      let campos: string | null = null;
      const q = {
        select: (c: string) => ((campos = c), q),
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        is: (k: string, v: unknown) => ((filters[k] = v), q),
        maybeSingle: async () => {
          if (tabela === "channel_integrations")
            return { data: { profile_id: "p", credential_encrypted: "x" }, error: null };
          const alvo = canais.find((c) => c.id === filters.id);
          return {
            data:
              campos === "webhook_path_token" && alvo
                ? { webhook_path_token: alvo.webhook_path_token }
                : null,
            error: null,
          };
        },
        then: (resolve: (r: unknown) => void) => {
          if (patch) {
            updates.push({ patch, filters: { ...filters } });
            ordem.push(`db:${tabela}.update`);
            resolve({ data: null, error: null });
            return;
          }
          resolve({ data: tabela === "channel_sessions" ? canais : null, error: null });
        },
      };
      return q;
    },
  };
  return { db: db as never, updates };
}
/** O canal social que desconectou no MEIO da conexão: FAILED e sem id de webhook. */
const canalOrfao = {
  id: "ch-orfao",
  zernio_account_id: account,
  status: "FAILED",
  webhook_path_token: token,
  metadata: {},
  updated_at: "2026-10-05T00:00:00Z",
};
type Assinatura = { _id: string; url: string };
function provedor(assinaturas: Assinatura[], status: Record<string, number> = {}) {
  h.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${String(url).replace("https://zernio.test/v1/", "")}`;
    ordem.push(key);
    if (status[key]) return new Response("{}", { status: status[key] });
    if (key.startsWith("GET accounts"))
      return new Response(
        JSON.stringify({
          accounts: [{ _id: account, platform: "instagram", isActive: true, profileId: "p" }],
        }),
      );
    if (key.startsWith("GET webhooks/settings"))
      return new Response(JSON.stringify({ webhooks: assinaturas }));
    return new Response("{}", { status: status[key] ?? 200 });
  });
}
const deletes = () =>
  h.fetch.mock.calls
    .filter(([, init]) => (init as RequestInit).method === "DELETE")
    .map(([url]) => String(url).replace("https://zernio.test/v1/", ""));
const listagensDeAssinatura = () =>
  h.fetch.mock.calls
    .filter(
      ([url, init]) =>
        (init as RequestInit).method === "GET" && String(url).includes("webhooks/settings"),
    )
    .map(([url]) => String(url).replace("https://zernio.test/v1/", ""));

beforeEach(() => {
  vi.clearAllMocks();
  ordem.length = 0;
  vi.stubGlobal("fetch", h.fetch);
  h.health.mockResolvedValue("resolvido");
});

it("a assinatura órfã é apagada pela URL do canal ANTES do arquivamento", async () => {
  provedor([
    // A de OUTRO canal, apontando para o token desta linha? Não: para outro.
    { _id: "wh-de-outro-canal", url: `https://instalacao.example.com/api/v1/webhooks/channel/${outroToken}` },
    { _id: "wh-orfao", url: `https://instalacao.example.com/api/v1/webhooks/channel/${token}` },
  ]);
  const { db, updates } = fakeDb([canalOrfao]);

  expect(await disconnectSocialAccount(db, org, account, false)).toEqual({
    channel_id: "ch-orfao",
    account_removed: false,
    avisos_fechados: "resolvido",
  });

  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-orfao"]);
  // A ordem importa: depois do patch o token já é outro e a assinatura fica
  // impossível de casar — exatamente o órfão que este arquivo existe para matar.
  expect(ordem.indexOf("DELETE webhooks/settings?webhookId=wh-orfao")).toBeLessThan(
    ordem.indexOf("db:channel_sessions.update"),
  );
  expect(updates).toHaveLength(1);
  expect(updates[0]?.filters).toEqual({ organization_id: org, id: "ch-orfao" });
  expect(updates[0]?.patch).toMatchObject({ status: "STOPPED", archived_at: expect.any(String) });
  expect(updates[0]?.patch.webhook_path_token).toMatch(/^[a-f0-9]{48}$/);
  expect(updates[0]?.patch.webhook_path_token).not.toBe(token);
  // Mesmo caminho das demais: o aviso de saúde fecha, audit/sem-erro.
  expect(h.health).toHaveBeenCalledWith(db, {
    id: "ch-orfao",
    organization_id: org,
    status: "STOPPED",
  });
});

it("quem já tem `social_webhook_id` não muda: o caminho normal nem lista assinaturas", async () => {
  provedor([{ _id: "wh-1", url: `https://instalacao.example.com/api/v1/webhooks/channel/${token}` }]);
  const { db, updates } = fakeDb([
    { ...canalOrfao, status: "WORKING", metadata: { social_webhook_id: "wh-1" } },
  ]);

  await disconnectSocialAccount(db, org, account, false);

  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-1"]);
  expect(listagensDeAssinatura()).toEqual([]);
  expect(updates).toHaveLength(1);
  expect(updates[0]?.patch).toMatchObject({ status: "STOPPED" });
});

it("a assinatura de OUTRO token não é tocada, e o canal arquiva mesmo assim", async () => {
  provedor([{ _id: "wh-de-outro-canal", url: `https://instalacao.example.com/api/v1/webhooks/channel/${outroToken}` }]);
  const { db, updates } = fakeDb([canalOrfao]);

  await disconnectSocialAccount(db, org, account, false);

  expect(listagensDeAssinatura()).toHaveLength(1);
  expect(deletes()).toEqual([]);
  expect(updates).toHaveLength(1);
  expect(updates[0]?.patch).toMatchObject({ status: "STOPPED" });
});

it("provedor fora do ar segura a desconexão — nada é arquivado pela metade", async () => {
  provedor([], { "GET webhooks/settings": 500 });
  const { db, updates } = fakeDb([canalOrfao]);

  await expect(disconnectSocialAccount(db, org, account, false)).rejects.toBeInstanceOf(SocialError);
  expect(updates).toHaveLength(0);
  expect(h.health).not.toHaveBeenCalled();
});

it("canal órfão (conta fora do perfil) sem id: o Excluir da tela também apaga a assinatura pela URL", async () => {
  // PR #2417: a linha de "Canais sem conta no perfil" sai pela ação disconnect.
  // A conta dela já não é listada pelo provedor — e mesmo assim a assinatura,
  // que é por chave e não por conta, tem de sair antes do arquivamento.
  provedor([{ _id: "wh-orfao", url: `https://instalacao.example.com/api/v1/webhooks/channel/${token}` }]);
  const fora = "d".repeat(24);
  const { db, updates } = fakeDb([{ ...canalOrfao, zernio_account_id: fora }]);

  expect(await disconnectSocialAccount(db, org, fora, false)).toEqual({
    channel_id: "ch-orfao",
    account_removed: false,
    avisos_fechados: "resolvido",
  });
  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-orfao"]);
  expect(ordem.indexOf("DELETE webhooks/settings?webhookId=wh-orfao")).toBeLessThan(
    ordem.indexOf("db:channel_sessions.update"),
  );
  expect(updates).toHaveLength(1);
  expect(updates[0]?.patch).toMatchObject({ status: "STOPPED", archived_at: expect.any(String) });
});

it("`social_webhook_id` vazio não vira DELETE por id: reconcilia pela URL, como o DELETE da Central", async () => {
  // PR #2424: o desconectar e o `apagarAssinaturaSocial` tinham cópias da regra
  // "id ou URL", e esta aceitava `""` — o DELETE saía com `webhookId=` vazio e a
  // assinatura de verdade ficava viva. Agora as duas passam pela mesma regra.
  provedor([{ _id: "wh-orfao", url: `https://instalacao.example.com/api/v1/webhooks/channel/${token}` }]);
  const { db, updates } = fakeDb([{ ...canalOrfao, metadata: { social_webhook_id: "" } }]);

  await disconnectSocialAccount(db, org, account, false);

  expect(listagensDeAssinatura()).toHaveLength(1);
  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-orfao"]);
  expect(updates).toHaveLength(1);
});
