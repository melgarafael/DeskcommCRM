/**
 * `webhook-da-instalacao` — o webhook ÚNICO das conexões por um clique.
 *
 * O que este arquivo prova, com provedor, banco e `platform_config` dublados:
 *   1. a primeira conexão CRIA uma assinatura só, filtrada aos PERFIS das
 *      conexões ativas, com o segredo gerado e guardado uma vez;
 *   2. as seguintes só ATUALIZAM o filtro da mesma assinatura — nunca uma por
 *      número, nunca o segredo trocado;
 *   3. sem conexão ativa, a assinatura é DESLIGADA e nunca recebe lista vazia
 *      (no provedor, `[]` quer dizer TODOS os perfis da conta);
 *   4. segredo recém-gerado com uma assinatura antiga na mesma URL: a antiga sai
 *      (assinaria com um segredo que ninguém mais tem);
 *   5. o filtro sai da base DEPOIS de escrever: se uma conexão entrou no meio, a
 *      passada se repete;
 *   6. a remoção (sem URL) só ajusta a que existe: não cria assinatura;
 *   7. acima de 50 perfis (o teto do filtro no provedor) a assinatura fica sem
 *      filtro em vez de ser recusada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: new Map<string, string>(),
  gravarSeAusente: vi.fn(),
  gravarPelaTela: vi.fn(),
}));

vi.mock("./credentials", () => ({ zernioBaseUrl: () => "https://zernio.test" }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: async (chave: string) => ({
    valor: h.config.get(chave) ?? null,
    fonte: h.config.has(chave) ? "banco" : "ausente",
  }),
  gravarSeAusente: h.gravarSeAusente,
  gravarPelaTela: h.gravarPelaTela,
}));

import {
  CHAVE_DO_ID,
  CHAVE_DO_SEGREDO,
  MAXIMO_DE_PERFIS_NO_FILTRO,
  perfisDaInstalacao,
  sincronizarWebhookDaInstalacao,
} from "./webhook-da-instalacao";

interface Chamada {
  metodo: string;
  caminho: string;
  corpo: Record<string, unknown> | undefined;
}
let chamadas: Chamada[] = [];
let assinaturas: { _id: string; url: string; isActive: boolean }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  chamadas = [];
  assinaturas = [];
  h.config.clear();
  h.gravarSeAusente.mockImplementation(async (chave: string, valor: string) => {
    if (!h.config.has(chave)) h.config.set(chave, valor);
    return h.config.get(chave);
  });
  h.gravarPelaTela.mockImplementation(async (chave: string, valor: string) => {
    h.config.set(chave, valor);
    return { ok: true };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const c: Chamada = {
        metodo: init.method ?? "GET",
        caminho: url.replace("https://zernio.test/v1/", ""),
        corpo: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      };
      chamadas.push(c);
      if (c.metodo === "GET") return Response.json({ webhooks: assinaturas });
      if (c.metodo === "POST") {
        const nova = {
          _id: `w-${assinaturas.length + 1}`,
          url: String(c.corpo?.url),
          isActive: true,
        };
        assinaturas.push(nova);
        return Response.json({ success: true, webhook: { _id: nova._id } });
      }
      if (c.metodo === "PUT") return Response.json({ success: true });
      if (c.metodo === "DELETE") {
        assinaturas = assinaturas.filter((w) => !c.caminho.includes(w._id));
        return new Response(null, { status: 200 });
      }
      return new Response("{}", { status: 500 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Banco dublado: as leituras devolvem, em ordem, os conjuntos de perfis da fila. */
function banco(...leituras: string[][]) {
  const filtros: Array<Record<string, unknown>> = [];
  let i = 0;
  const admin = {
    from: () => {
      const f: Record<string, unknown> = {};
      filtros.push(f);
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => ((f[k] = v), q),
        is: (k: string, v: unknown) => ((f[`is:${k}`] = v), q),
        not: (k: string, op: string, v: unknown) => ((f[`not:${k}`] = `${op} ${String(v)}`), q),
        neq: (k: string, v: unknown) => ((f[`!${k}`] = v), q),
        then: (resolve: (r: unknown) => void) => {
          const perfis = leituras[Math.min(i++, leituras.length - 1)] ?? [];
          resolve({
            data: perfis.map((p, n) => ({ id: `s-${n}`, zernio_profile_id: p })),
            error: null,
          });
        },
      };
      return q;
    },
  };
  return { admin: admin as never, filtros };
}

const URL_DA_ENTRADA = "https://crm.exemplo.com/api/v1/webhooks/canal-da-instalacao";
const alvo = { url: URL_DA_ENTRADA, nome: "Marca Exemplo · um clique" };
const escritas = () => chamadas.filter((c) => c.metodo !== "GET");

describe("perfisDaInstalacao", () => {
  it("lê só sessões de um clique ativas com perfil, sem repetir, e tira a que está saindo", async () => {
    const { admin, filtros } = banco(["p2", "p1", "p2"]);
    expect(await perfisDaInstalacao(admin, "sessao-saindo")).toEqual(["p1", "p2"]);
    expect(filtros[0]).toMatchObject({
      provider: "zernio",
      zernio_credencial_da_instalacao: true,
      "is:archived_at": null,
      "not:zernio_profile_id": "is null",
      "!id": "sessao-saindo",
    });
  });
});

describe("sincronizarWebhookDaInstalacao", () => {
  it("primeira conexão: UMA assinatura, filtrada aos perfis, com o segredo gerado uma vez", async () => {
    const { admin } = banco(["p1"]);
    expect(await sincronizarWebhookDaInstalacao(admin, "k", alvo)).toBe("w-1");
    const [criacao, ...resto] = escritas();
    expect(resto).toEqual([]);
    expect(criacao).toMatchObject({ metodo: "POST", caminho: "webhooks/settings" });
    expect(criacao?.corpo).toMatchObject({
      name: "Marca Exemplo · um clique",
      url: URL_DA_ENTRADA,
      profileIds: ["p1"],
      isActive: true,
    });
    expect(criacao?.corpo).not.toHaveProperty("accountIds");
    const segredo = h.config.get(CHAVE_DO_SEGREDO);
    expect(segredo).toMatch(/^[0-9a-f]{64}$/);
    expect(criacao?.corpo?.secret).toBe(segredo);
    expect(h.config.get(CHAVE_DO_ID)).toBe("w-1");
  });

  it("conexão seguinte: só o filtro da MESMA assinatura muda — sem outra, sem trocar o segredo", async () => {
    h.config.set(CHAVE_DO_SEGREDO, "s".repeat(64));
    h.config.set(CHAVE_DO_ID, "w-9");
    assinaturas = [{ _id: "w-9", url: URL_DA_ENTRADA, isActive: true }];
    const { admin } = banco(["p1", "p2"]);
    expect(await sincronizarWebhookDaInstalacao(admin, "k", alvo)).toBe("w-9");
    expect(escritas()).toEqual([
      {
        metodo: "PUT",
        caminho: "webhooks/settings",
        corpo: { webhookId: "w-9", profileIds: ["p1", "p2"], isActive: true, url: URL_DA_ENTRADA },
      },
    ]);
    expect(h.gravarSeAusente).not.toHaveBeenCalled();
  });

  it("sem conexão ativa: DESLIGA a assinatura e nunca manda lista vazia (seria TODOS os perfis)", async () => {
    h.config.set(CHAVE_DO_SEGREDO, "s".repeat(64));
    h.config.set(CHAVE_DO_ID, "w-9");
    assinaturas = [{ _id: "w-9", url: URL_DA_ENTRADA, isActive: true }];
    const { admin } = banco([]);
    expect(
      await sincronizarWebhookDaInstalacao(admin, "k", { nome: "", excluirSessao: "sessao-1" }),
    ).toBeNull();
    expect(escritas()).toEqual([
      { metodo: "PUT", caminho: "webhooks/settings", corpo: { webhookId: "w-9", isActive: false } },
    ]);
    expect(
      chamadas.some((c) => Array.isArray(c.corpo?.profileIds) && c.corpo.profileIds.length === 0),
    ).toBe(false);
  });

  it("remoção (sem URL) não cria assinatura quando ela não existe", async () => {
    h.config.set(CHAVE_DO_SEGREDO, "s".repeat(64));
    const { admin } = banco(["p1"]);
    expect(
      await sincronizarWebhookDaInstalacao(admin, "k", { nome: "", excluirSessao: "s-0" }),
    ).toBeNull();
    expect(escritas()).toEqual([]);
  });

  it("segredo recém-gerado e assinatura antiga na mesma URL: a antiga sai e nasce outra", async () => {
    assinaturas = [{ _id: "w-velha", url: URL_DA_ENTRADA, isActive: true }];
    const { admin } = banco(["p1"]);
    const id = await sincronizarWebhookDaInstalacao(admin, "k", alvo);
    expect(escritas().map((c) => c.metodo)).toEqual(["DELETE", "POST"]);
    expect(escritas()[0]?.caminho).toContain("webhookId=w-velha");
    expect(id).not.toBe("w-velha");
  });

  it("uma conexão entrou no meio: a passada se repete com o conjunto novo da base", async () => {
    h.config.set(CHAVE_DO_SEGREDO, "s".repeat(64));
    h.config.set(CHAVE_DO_ID, "w-9");
    assinaturas = [{ _id: "w-9", url: URL_DA_ENTRADA, isActive: true }];
    const { admin } = banco(["p1"], ["p1", "p2"], ["p1", "p2"]);
    await sincronizarWebhookDaInstalacao(admin, "k", alvo);
    expect(escritas().map((c) => c.corpo?.profileIds)).toEqual([["p1"], ["p1", "p2"]]);
  });

  it("acima do teto do filtro: a assinatura fica SEM filtro, e no teto ainda filtra", async () => {
    h.config.set(CHAVE_DO_SEGREDO, "s".repeat(64));
    h.config.set(CHAVE_DO_ID, "w-9");
    assinaturas = [{ _id: "w-9", url: URL_DA_ENTRADA, isActive: true }];
    const perfis = (n: number) =>
      Array.from({ length: n }, (_, i) => `p${String(i).padStart(3, "0")}`);
    expect(MAXIMO_DE_PERFIS_NO_FILTRO).toBe(50);

    await sincronizarWebhookDaInstalacao(banco(perfis(50)).admin, "k", alvo);
    expect(escritas()[0]?.corpo?.profileIds).toEqual(perfis(50));

    chamadas = [];
    expect(await sincronizarWebhookDaInstalacao(banco(perfis(51)).admin, "k", alvo)).toBe("w-9");
    expect(escritas()).toEqual([
      {
        metodo: "PUT",
        caminho: "webhooks/settings",
        corpo: { webhookId: "w-9", profileIds: [], isActive: true, url: URL_DA_ENTRADA },
      },
    ]);
  });

  it("sem cifra para guardar o segredo, não registra nada", async () => {
    h.gravarSeAusente.mockResolvedValue(null);
    const { admin } = banco(["p1"]);
    await expect(sincronizarWebhookDaInstalacao(admin, "k", alvo)).rejects.toThrow(/segredo/);
    expect(escritas()).toEqual([]);
  });
});
