// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * O service worker é JavaScript de navegador servido cru de `public/` (ADR-0006,
 * D3): não passa por bundler nem por TypeScript. Este teste o executa num
 * contexto `vm` com um `self` falso e chama os handlers como o navegador
 * chamaria.
 */
const FONTE = readFileSync("public/notify-sw.js", "utf8");
const ORIGEM = "https://crm.example";

interface Janela {
  url: string;
  visibilityState: "visible" | "hidden";
  focused: boolean;
  focus: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function janela(caminho: string, visibilityState: Janela["visibilityState"] = "visible", focused = false): Janela {
  return {
    url: ORIGEM + caminho,
    visibilityState,
    focused,
    focus: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn(),
  };
}

function carregar(opcoes: { janelas?: Janela[]; fetch?: (r: unknown) => Promise<unknown>; lingua?: string } = {}) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const fechar = vi.fn();
  const getNotifications = vi.fn().mockResolvedValue([{ close: fechar }]);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const enable = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn(opcoes.fetch ?? (async () => new Response("ok")));
  const self = {
    location: { origin: ORIGEM },
    navigator: { language: opcoes.lingua ?? "pt-BR" },
    registration: { showNotification, getNotifications, navigationPreload: { enable } },
    clients: {
      matchAll: vi.fn().mockResolvedValue(opcoes.janelas ?? []),
      openWindow,
      claim: vi.fn().mockResolvedValue(undefined),
    },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    addEventListener: (tipo: string, fn: (event: unknown) => void) => {
      handlers[tipo] = fn;
    },
  };
  vm.runInNewContext(FONTE, { self, fetch, Response, URL, String, Promise });
  return { handlers, showNotification, getNotifications, fechar, openWindow, enable, fetch, self };
}

/** Dispara um evento e espera tudo o que ele entregou a waitUntil/respondWith. */
async function disparar(fn: ((event: unknown) => void) | undefined, extra: Record<string, unknown> = {}) {
  const esperas: Promise<unknown>[] = [];
  let resposta: Promise<unknown> | undefined;
  const event = {
    waitUntil: (p: Promise<unknown>) => esperas.push(p),
    respondWith: (p: Promise<unknown>) => {
      resposta = p;
    },
    ...extra,
  };
  expect(fn).toBeTypeOf("function");
  fn?.(event);
  await Promise.all(esperas);
  return { resposta: resposta ? await resposta : undefined, respondeu: resposta !== undefined };
}

const pushDe = (payload: unknown) => ({
  data: {
    json: () => {
      if (typeof payload === "string") throw new SyntaxError("não é JSON");
      return payload;
    },
  },
});

describe("push: todo push vira notificação", () => {
  it("sem janela aberta, mostra com som e com a tag do payload", async () => {
    const sw = carregar();
    await disparar(sw.handlers.push, pushDe({ title: "Maria", body: "oi", tag: "msg:c1", href: "/app/inbox?id=c1" }));
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [titulo, opcoes] = sw.showNotification.mock.calls[0] ?? [];
    expect(titulo).toBe("Maria");
    expect(opcoes).toMatchObject({ tag: "msg:c1", silent: false, renotify: true, data: { href: "/app/inbox?id=c1" } });
    expect(opcoes).not.toHaveProperty("badge");
  });

  it("com o app à vista, AINDA mostra — calado, porque a página já tocou o som", async () => {
    const sw = carregar({ janelas: [janela("/app/inbox")] });
    await disparar(sw.handlers.push, pushDe({ title: "Maria", body: "oi", tag: "msg:c1" }));
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    expect(sw.showNotification.mock.calls[0]?.[1]).toMatchObject({ tag: "msg:c1", silent: true, renotify: false });
  });

  it("janela em foco LENDO a conversa: mostra (regra do iOS) e fecha em seguida", async () => {
    const sw = carregar({ janelas: [janela("/app/inbox?id=c1", "visible", true)] });
    await disparar(sw.handlers.push, pushDe({ title: "Maria", body: "oi", tag: "msg:c1" }));
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    expect(sw.getNotifications).toHaveBeenCalledWith({ tag: "msg:c1" });
    expect(sw.fechar).toHaveBeenCalled();
  });

  it.each([
    ["outra conversa aberta", janela("/app/inbox?id=c2", "visible", true)],
    ["a conversa aberta, mas sem foco", janela("/app/inbox?id=c1", "visible", false)],
  ])("%s: o aviso fica na bandeja", async (_nome, j) => {
    const sw = carregar({ janelas: [j] });
    await disparar(sw.handlers.push, pushDe({ title: "Maria", body: "oi", tag: "msg:c1" }));
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    expect(sw.fechar).not.toHaveBeenCalled();
  });

  it("janela à vista fora do app (login) não cala: lá não há aviso local", async () => {
    const sw = carregar({ janelas: [janela("/login")] });
    await disparar(sw.handlers.push, pushDe({ title: "Maria", body: "oi", tag: "msg:c1" }));
    expect(sw.showNotification.mock.calls[0]?.[1]).toMatchObject({ silent: false, renotify: true });
  });

  it("tipo sem aviso local (tarefa) não é calado nem com o app à vista", async () => {
    const sw = carregar({ janelas: [janela("/app/inbox")] });
    await disparar(sw.handlers.push, pushDe({ title: "Tarefa", body: "ligar", tag: "task:t1" }));
    expect(sw.showNotification.mock.calls[0]?.[1]).toMatchObject({ silent: false, renotify: true });
  });

  it("payload que não é JSON mostra o aviso padrão", async () => {
    const sw = carregar();
    await disparar(sw.handlers.push, pushDe("texto solto"));
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    expect(sw.showNotification.mock.calls[0]?.[0]).toBe("Nova mensagem");
  });

  it("tag vazia não derruba o aviso (renotify sem tag lança no navegador)", async () => {
    const sw = carregar();
    await disparar(sw.handlers.push, pushDe({ title: "Maria", body: "oi", tag: "" }));
    expect(sw.showNotification.mock.calls[0]?.[1]).toMatchObject({ tag: "msg" });
  });

  it("se o navegador recusar as opções, mostra mesmo assim só com título e corpo", async () => {
    const sw = carregar();
    sw.showNotification.mockRejectedValueOnce(new TypeError("opção recusada"));
    await disparar(sw.handlers.push, pushDe({ title: "Maria", body: "oi", tag: "msg:c1" }));
    expect(sw.showNotification).toHaveBeenCalledTimes(2);
    expect(sw.showNotification.mock.calls[1]).toEqual(["Maria", { body: "oi" }]);
  });
});

describe("fetch: só a navegação sem rede ganha resposta do SW", () => {
  const navegacao = (method = "GET") => ({ request: { mode: "navigate", method, url: ORIGEM + "/app/inbox" } });

  it("navegação GET sem rede cai na página neutra, 503, sem dado nenhum", async () => {
    const sw = carregar({ fetch: async () => Promise.reject(new TypeError("Failed to fetch")) });
    const { resposta } = await disparar(sw.handlers.fetch, { ...navegacao(), preloadResponse: Promise.resolve(undefined) });
    const r = resposta as Response;
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain("Sem conexão");
    expect(html).toContain("Tentar de novo");
  });

  it("o texto da página offline segue o idioma do aparelho", async () => {
    const sw = carregar({ lingua: "es-AR", fetch: async () => Promise.reject(new TypeError("x")) });
    const { resposta } = await disparar(sw.handlers.fetch, { ...navegacao(), preloadResponse: Promise.resolve(undefined) });
    expect(await (resposta as Response).text()).toContain("Sin conexión");
  });

  it.each([307, 500])("resposta %i do servidor passa intacta (é o MESMO objeto)", async (status) => {
    const doServidor = new Response(null, { status });
    const sw = carregar({ fetch: async () => doServidor });
    const { resposta } = await disparar(sw.handlers.fetch, { ...navegacao(), preloadResponse: Promise.resolve(undefined) });
    expect(resposta).toBe(doServidor);
  });

  it("com navigation preload, usa a resposta dele e não busca de novo", async () => {
    const preload = new Response("pre");
    const sw = carregar();
    const { resposta } = await disparar(sw.handlers.fetch, { ...navegacao(), preloadResponse: Promise.resolve(preload) });
    expect(resposta).toBe(preload);
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["requisição que não é navegação", { request: { mode: "cors", method: "GET", url: ORIGEM + "/api/v1/x" } }],
    ["navegação POST", navegacao("POST")],
  ])("%s passa direto, sem respondWith", async (_nome, evento) => {
    const sw = carregar();
    const { respondeu } = await disparar(sw.handlers.fetch, evento);
    expect(respondeu).toBe(false);
  });

  it("instalar não registra rota estática: a página offline depende só do handler fetch", async () => {
    // Num Chrome que tem addRoutes mas não conhece a condição `not`, a rota
    // podia virar "tudo vai à rede", e a página offline sumiria calada.
    const sw = carregar();
    const addRoutes = vi.fn().mockResolvedValue(undefined);
    await disparar(sw.handlers.install, { addRoutes });
    expect(addRoutes).not.toHaveBeenCalled();
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it("ativar liga o navigation preload e assume as abas", async () => {
    const sw = carregar();
    await disparar(sw.handlers.activate);
    expect(sw.enable).toHaveBeenCalled();
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});

describe("clique na notificação", () => {
  const clique = (href: string) => ({ notification: { close: vi.fn(), data: { href } } });

  it("foca a janela do app (não a primeira qualquer) e navega para o destino", async () => {
    const login = janela("/login");
    const app = janela("/app/agenda");
    const sw = carregar({ janelas: [login, app] });
    await disparar(sw.handlers.notificationclick, clique("/app/inbox?id=c1"));
    expect(app.focus).toHaveBeenCalled();
    expect(app.navigate).toHaveBeenCalledWith(ORIGEM + "/app/inbox?id=c1");
    expect(login.focus).not.toHaveBeenCalled();
  });

  it("destino de outra origem vira o inbox", async () => {
    const app = janela("/app");
    const sw = carregar({ janelas: [app] });
    await disparar(sw.handlers.notificationclick, clique("https://outro.example/x"));
    expect(app.navigate).toHaveBeenCalledWith(ORIGEM + "/app/inbox");
  });

  it("com várias janelas do app, vai para a que está em foco, não a primeira", async () => {
    const atras = janela("/app/agenda", "hidden");
    const visivel = janela("/app/contacts", "visible");
    const emFoco = janela("/app/settings", "visible", true);
    const sw = carregar({ janelas: [atras, visivel, emFoco] });
    await disparar(sw.handlers.notificationclick, clique("/app/inbox?id=c1"));
    expect(emFoco.navigate).toHaveBeenCalledWith(ORIGEM + "/app/inbox?id=c1");
    expect(atras.navigate).not.toHaveBeenCalled();
  });

  it("sem foco em nenhuma, prefere a visível", async () => {
    const atras = janela("/app/agenda", "hidden");
    const visivel = janela("/app/contacts", "visible");
    const sw = carregar({ janelas: [atras, visivel] });
    await disparar(sw.handlers.notificationclick, clique("/app/inbox?id=c1"));
    expect(visivel.navigate).toHaveBeenCalled();
    expect(atras.navigate).not.toHaveBeenCalled();
  });

  it("aviso sem destino (o aviso local manda href vazio) só foca, não tira a pessoa da tela", async () => {
    const app = janela("/app/settings/notifications", "visible", true);
    const sw = carregar({ janelas: [app] });
    await disparar(sw.handlers.notificationclick, clique(""));
    expect(app.focus).toHaveBeenCalled();
    expect(app.navigate).not.toHaveBeenCalled();
    expect(app.postMessage).not.toHaveBeenCalled();
  });

  it("aviso sem destino e sem janela abre o app", async () => {
    const sw = carregar({ janelas: [] });
    await disparar(sw.handlers.notificationclick, clique(""));
    expect(sw.openWindow).toHaveBeenCalledWith(ORIGEM + "/app");
  });

  it("sem janela nenhuma, abre uma", async () => {
    const sw = carregar({ janelas: [] });
    await disparar(sw.handlers.notificationclick, clique("/app/inbox?id=c1"));
    expect(sw.openWindow).toHaveBeenCalledWith(ORIGEM + "/app/inbox?id=c1");
  });

  it("navigate recusado (janela não controlada) cai no aviso à página", async () => {
    const app = janela("/app");
    app.navigate = vi.fn().mockRejectedValue(new TypeError("não controlada"));
    const sw = carregar({ janelas: [app] });
    await disparar(sw.handlers.notificationclick, clique("/app/inbox?id=c1"));
    expect(app.postMessage).toHaveBeenCalledWith({ type: "notify-open", href: ORIGEM + "/app/inbox?id=c1" });
  });
});
