import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONVERSAS_IGNORADAS, WahaClient } from "@/lib/waha/client";

/**
 * O CRM PAGAVA POR CONVERSA QUE ELE MESMO DESCARTA.
 *
 * ─── Medido no banco de produção, 20/08/2026 ────────────────────────────────
 *
 * Todo evento do WAHA é arquivado inteiro. Separando os de mensagem por origem:
 *
 *   estados / difusão ......... 23.010 ... 271 MB
 *   grupos .................... 17.970 .... 89 MB
 *   canais / newsletter ........ 1.818 .... 16 MB
 *   conversa 1-a-1 ............. 4.739 .... 19 MB   ← o negócio
 *
 * 376 dos 395 MB eram conversa que o CRM recebe, grava inteira e joga fora —
 * `handleInbound` já ignora tudo que não é 1-a-1. O gasto acontecia ANTES da
 * decisão: na rede, na CPU do contêiner e no arquivo.
 *
 * ─── Por que a convergência importa mais que a criação ──────────────────────
 *
 * `POST /api/sessions` devolve 422 quando a sessão já existe, e nesse caminho a
 * config NÃO é aplicada. Foi exatamente assim que a sessão de produção ficou
 * sem o filtro: ela nasceu antes desta mudança e nenhum código voltaria para
 * ajustá-la. Sem o PUT, esta economia só valeria para instalação nova.
 */

const fetchOriginal = globalThis.fetch;
let chamadas: { url: string; metodo: string; corpo: unknown }[] = [];

function espionar(respostas: Record<string, number>) {
  globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as { method?: string; body?: string };
    chamadas.push({ url: u, metodo: i.method ?? "GET", corpo: i.body ? JSON.parse(i.body) : null });
    const status =
      Object.entries(respostas).find(([frag]) => u.includes(frag))?.[1] ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ name: "s1", status: "SCAN_QR_CODE", config: { ignore: CONVERSAS_IGNORADAS }, engine: { engine: "NOWEB" } }),
      text: async (): Promise<string> => "",
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => { chamadas = []; });
afterEach(() => { globalThis.fetch = fetchOriginal; });

describe("a sessão nasce ignorando o que o CRM não atende", () => {
  it("a criação leva as quatro categorias", async () => {
    espionar({});
    await new WahaClient("http://w", "k").startSession("s1");
    const criacao = chamadas.find((c) => c.url.endsWith("/api/sessions") && c.metodo === "POST");
    expect((criacao?.corpo as { config?: { ignore?: unknown } })?.config?.ignore).toEqual({
      status: true, broadcast: true, channels: true, groups: true,
    });
  });

  it("os estados são a categoria que mais pesava — não podem sair da lista", () => {
    // 271 MB de 395 MB, sozinhos. Se alguém "aliviar" o filtro, é por aqui que
    // o banco volta a crescer 23 MB/dia.
    expect(CONVERSAS_IGNORADAS.status, "os estados voltaram a ser recebidos").toBe(true);
  });
});

describe("sessão que JÁ existe é corrigida — sem levar a config junto", () => {
  /** Duble que responde ao GET da sessão e registra o que o PUT mandou. */
  function comSessao(configAtual: unknown) {
    const vistos: { metodo: string; corpo: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      const i2 = (init ?? {}) as { method?: string; body?: string };
      const m = i2.method ?? "GET";
      vistos.push({ metodo: m, corpo: i2.body ? JSON.parse(i2.body) : null });
      if (m === "POST" && u.endsWith("/api/sessions")) {
        return { ok: false, status: 422, json: async () => ({ statusCode: 422, error: "Unprocessable Entity", message: "Session 's1' already exists. Use PUT to update it." }), text: async (): Promise<string> => "" };
      }
      if (m === "GET") {
        return { ok: true, status: 200, json: async () => ({ name: "s1", status: "WORKING", engine: { engine: "NOWEB" }, config: configAtual }), text: async (): Promise<string> => "" };
      }
      return { ok: true, status: 200, json: async () => ({ status: "WORKING" }), text: async (): Promise<string> => "" };
    }) as unknown as typeof fetch;
    return vistos;
  }

  const WEBHOOKS = [{ url: "https://crm/webhook", events: ["message.any"] }];

  it("o PUT PRESERVA os webhooks — sem isso o canal fica mudo", async () => {
    // A doc do WAHA: o PUT "updates a session with a FULL new configuration".
    // Mandar só `ignore` SUBSTITUI a config e leva o bloco `webhooks` junto —
    // sessão conectada, de pé, sem entregar uma mensagem. A pior forma de
    // falhar, porque nada fica vermelho.
    const vistos = comSessao({ webhooks: WEBHOOKS });
    await new WahaClient("http://w", "k").startSession("s1");
    const put = vistos.find((v) => v.metodo === "PUT");
    const cfg = (put?.corpo as { config?: Record<string, unknown> })?.config;
    expect(cfg?.webhooks, "o PUT apagou os webhooks da sessão").toEqual(WEBHOOKS);
    expect(cfg?.ignore).toEqual(CONVERSAS_IGNORADAS);
  });

  it("não reescreve quando já está como queremos", async () => {
    // Este caminho roda em TODA reconexão, e o PUT REINICIA a sessão. Um
    // restart por rodada seria pior que o gasto que ele evita.
    const vistos = comSessao({ webhooks: WEBHOOKS, ignore: { ...CONVERSAS_IGNORADAS } });
    await new WahaClient("http://w", "k").startSession("s1");
    expect(vistos.some((v) => v.metodo === "PUT"), "reiniciou a sessão à toa").toBe(false);
  });

  it("se não conseguir LER a config, não escreve nada", async () => {
    // Sem saber o que há lá, escrever é apostar o canal inteiro numa economia
    // de bytes.
    const vistos: { metodo: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
      const m = ((init ?? {}) as { method?: string }).method ?? "GET";
      vistos.push({ metodo: m });
      if (m === "POST" && String(url).endsWith("/api/sessions")) {
        return { ok: false, status: 422, json: async () => ({ statusCode: 422, error: "Unprocessable Entity", message: "Session 's1' already exists. Use PUT to update it." }), text: async (): Promise<string> => "" };
      }
      if (m === "GET") return { ok: false, status: 500, json: async () => ({ statusCode: 500, error: "Internal Server Error", message: "unavailable" }), text: async (): Promise<string> => "" };
      return { ok: true, status: 200, json: async () => ({ status: "WORKING" }), text: async (): Promise<string> => "" };
    }) as unknown as typeof fetch;
    await expect(new WahaClient("http://w", "k").startSession("s1")).rejects.toThrow("waha_create_500");
    expect(vistos.some((v) => v.metodo === "PUT"), "escreveu às cegas").toBe(false);
  });

  it("falha da convergência não impede a sessão de iniciar", async () => {
    // Só a leitura oportunista da convergência falha. Identidade e engine
    // continuam provados pela confirmação inicial e pelo GET depois do start.
    let gets = 0;
    globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
      const m = ((init ?? {}) as { method?: string }).method ?? "GET";
      if (m === "GET") {
        gets += 1;
        if (gets === 2) throw new Error("ECONNRESET");
        return { ok: true, status: 200, json: async () => ({ name: "s1", status: "WORKING", config: { webhooks: WEBHOOKS }, engine: { engine: "NOWEB" } }) };
      }
      if (m === "POST" && String(url).endsWith("/api/sessions")) {
        return { ok: false, status: 422, json: async () => ({ statusCode: 422, error: "Unprocessable Entity", message: "Session 's1' already exists. Use PUT to update it." }), text: async (): Promise<string> => "" };
      }
      return { ok: true, status: 200, json: async () => ({ status: "WORKING" }), text: async (): Promise<string> => "" };
    }) as unknown as typeof fetch;
    await expect(new WahaClient("http://w", "k").startSession("s1")).resolves.toBeTruthy();
  });
});
