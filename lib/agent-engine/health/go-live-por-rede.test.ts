/**
 * O item da trava de número novo, numa conexão de REDE SOCIAL (A3, parte 2).
 *
 * "Número novo aguardando liberação" aparecia na Central de quem acabara de conectar
 * o Instagram: o item é verdadeiro (os retornos automáticos pararam), mas fala de
 * número onde não há número. O que se prende aqui, e por quê:
 *
 *  1. com a rede da sessão, o texto fala de CONEXÃO e usa o nome do catálogo de redes;
 *  2. sem rede (o número de WhatsApp) — ou com uma que o catálogo não conhece — o texto
 *     é EXATAMENTE o de sempre: é o que o invariante `go-live-solta-numero-formado` e o
 *     `session-watchdog.test.ts` já travam;
 *  3. a leitura da rede roda na transação do tick: com o banco fora o erro PROPAGA, porque
 *     um comando que falha aborta a transação e engoli-lo não deixaria o item ser gravado.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  CORPO_DO_GO_LIVE,
  CORPO_DO_GO_LIVE_DA_REDE,
  TITULO_DO_GO_LIVE,
  TITULO_DO_GO_LIVE_DA_REDE,
  redeDaSessaoDoGoLive,
  textoDoGoLive,
} from "./circuit";

describe("textoDoGoLive com a rede da sessão", () => {
  it("Instagram, Facebook e TikTok: o texto fala de conexão e usa o nome do catálogo", () => {
    const nomes = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok" };
    for (const [id, nome] of Object.entries(nomes)) {
      const { title, body } = textoDoGoLive("pt-BR", id);
      expect(title, id).toBe(`Conexão nova do ${nome} aguardando liberação (go-live)`);
      expect(body, id).toContain(`Os retornos automáticos desta conexão do ${nome} estão parados`);
      expect(body, id).toContain("quando a conexão estiver pronta para disparar");
      // nenhum marcador sobra no texto que vai para a Central
      expect(title + body, id).not.toMatch(/[{}]/);
    }
  });

  it("em espanhol e em inglês, com a rede no lugar", () => {
    const es = textoDoGoLive("es", "instagram");
    expect(es.title).toBe("Conexión nueva de Instagram en espera de liberación (go-live)");
    expect(es.body).toContain("de esta conexión de Instagram están detenidos");
    const en = JSON.parse(readFileSync("lib/i18n/traducoes/en.json", "utf8")) as Record<string, string>;
    expect(en[TITULO_DO_GO_LIVE_DA_REDE]).toBe("New {rede} connection awaiting release (go-live)");
    expect(en[CORPO_DO_GO_LIVE_DA_REDE]).toContain("paused until you release it");
  });

  it("sem rede, ou com rede que o catálogo não conhece: o texto de número, sem mudar uma vírgula", () => {
    const deNumero = textoDoGoLive("pt-BR");
    expect(deNumero).toEqual({ title: TITULO_DO_GO_LIVE, body: CORPO_DO_GO_LIVE });
    for (const rede of [null, undefined, "", "whatsapp", "orkut", "constructor", "__proto__"]) {
      expect(textoDoGoLive("pt-BR", rede), String(rede)).toEqual(deNumero);
    }
    // e o de antes em espanhol segue igual
    expect(textoDoGoLive("es", null).title).toBe("Número nuevo en espera de liberación (go-live)");
  });
});

describe("redeDaSessaoDoGoLive", () => {
  it("lê metadata.social_platform da sessão, filtrando pela organização", async () => {
    const query = vi.fn(async () => ({ rows: [{ rede: "instagram" }] }));
    const rede = await redeDaSessaoDoGoLive({ query } as never, "org-1", "sessao-1");
    expect(rede).toBe("instagram");
    const [sql, valores] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/metadata->>'social_platform'/);
    expect(sql).toMatch(/organization_id = \$1 and id = \$2/);
    expect(valores).toEqual(["org-1", "sessao-1"]);
  });

  it("número de WhatsApp (sem a chave) e sessão que não existe: null", async () => {
    expect(await redeDaSessaoDoGoLive({ query: async () => ({ rows: [{ rede: null }] }) } as never, "o", "s")).toBeNull();
    expect(await redeDaSessaoDoGoLive({ query: async () => ({ rows: [] }) } as never, "o", "s")).toBeNull();
  });

  it("banco fora: o erro propaga (dentro da transação do tick, engolir não abriria a trava)", async () => {
    const quebrado = { query: async () => Promise.reject(new Error("conexão caiu")) };
    await expect(redeDaSessaoDoGoLive(quebrado as never, "o", "s")).rejects.toThrow("conexão caiu");
  });
});
