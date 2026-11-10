/**
 * `encerrarPushDesteAparelho` — desligar os alertas e sair encerram o push do
 * aparelho: o servidor esquece a inscrição (DELETE, que precisa da sessão) e o
 * navegador cancela a dele. Nunca lança: a saída não pode depender da rede.
 *
 * Roda com: npx vitest run lib/notifications/push_client.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MOTIVOS_DO_APARELHO,
  MOTIVOS_QUE_DESLIGAM,
  encerrarPushDesteAparelho,
  pushNaoEntrega,
  syncPushSubscription,
  type MotivoDoIgnorado,
} from "./push_client";

/** Todos os motivos de `ignorado`: a tabela abaixo não pode deixar nenhum de fora. */
const TODOS_OS_MOTIVOS: MotivoDoIgnorado[] = [
  "fora_do_navegador",
  "preferencia_do_usuario",
  ...MOTIVOS_DO_APARELHO,
];

const ordem: string[] = [];
const fetchFalso = vi.fn(async (..._args: unknown[]) => {
  ordem.push("delete");
  return new Response(null, { status: 200 });
});
const unsubscribe = vi.fn(async () => {
  ordem.push("unsubscribe");
  return true;
});
const register = vi.fn();

function comServiceWorker(sub: { endpoint: string; unsubscribe: typeof unsubscribe } | null) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: async () => sub } })),
    },
  });
}

beforeEach(() => {
  ordem.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchFalso);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("encerrarPushDesteAparelho", () => {
  it("manda o DELETE com o endpoint ANTES de cancelar a inscrição no navegador", async () => {
    comServiceWorker({ endpoint: "https://push/1", unsubscribe });
    await encerrarPushDesteAparelho();
    expect(ordem).toEqual(["delete", "unsubscribe"]);
    const [url, init] = fetchFalso.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/notifications/push");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ endpoint: "https://push/1" }));
  });

  it("DELETE falhando não impede o cancelamento, e a promessa resolve", async () => {
    fetchFalso.mockRejectedValueOnce(new Error("rede fora"));
    comServiceWorker({ endpoint: "https://push/1", unsubscribe });
    await expect(encerrarPushDesteAparelho()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("cancelamento falhando também não lança", async () => {
    unsubscribe.mockRejectedValueOnce(new Error("x"));
    comServiceWorker({ endpoint: "https://push/1", unsubscribe });
    await expect(encerrarPushDesteAparelho()).resolves.toBeUndefined();
  });

  it("sem inscrição: nenhum pedido ao servidor", async () => {
    comServiceWorker(null);
    await encerrarPushDesteAparelho();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("sem service worker no navegador: nenhum pedido e nenhum lançamento", async () => {
    await expect(encerrarPushDesteAparelho()).resolves.toBeUndefined();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("não registra service worker para sair", async () => {
    comServiceWorker({ endpoint: "https://push/1", unsubscribe });
    await encerrarPushDesteAparelho();
    expect(register).not.toHaveBeenCalled();
  });
});

describe("syncPushSubscription", () => {
  const subscribe = vi.fn(async () => ({
    toJSON: () => ({ endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" } }),
  }));

  beforeEach(() => {
    vi.stubGlobal("Notification", { permission: "granted" });
    fetchFalso.mockImplementation(async () =>
      new Response(JSON.stringify({ data: { enabled: true, public_key: "AAAA" } }), { status: 200 }),
    );
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn(async () => ({ pushManager: { getSubscription: async () => null, subscribe } })) },
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    fetchFalso.mockReset();
  });

  // `alerts.enabled` é espelho: a permissão concedida para outra linha da tela o
  // regrava como "1" sem tocar no interruptor de mensagem. A fonte é a preferência.
  it("push de mensagem desligado: não inscreve nem manda PUT, mesmo com o espelho em 1", async () => {
    window.localStorage.setItem("notify.prefs.v1", JSON.stringify({ message: { in_app: true, push: false } }));
    window.localStorage.setItem("alerts.enabled", "1");
    await syncPushSubscription();
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchFalso.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("push de mensagem ligado: inscreve e manda PUT (controle positivo)", async () => {
    await syncPushSubscription();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetchFalso.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true);
  });

  /**
   * ISSUE #3116 — a recusa 422 da rota não pode ser engolida.
   *
   * O PUT responde `{ error: { code: "validation_failed" } }` com 422 (o
   * serviço de push fora da lista de `servicos-de-push.ts`). No código ANTIGO
   * a função não olhava `res.ok` e devolvia `void`: a tela ligava o interruptor
   * e nada avisava. Este caso é o que fica VERMELHO se o tratamento de
   * `!res.ok` sair — a sabotagem do PR exercita exatamente isto.
   */
  it("PUT recusado (422): a função REPORTA a recusa com a frase do servidor", async () => {
    fetchFalso.mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      return init?.method === "PUT"
        ? new Response(JSON.stringify({ error: { code: "validation_failed", message: "Campos inválidos." } }), {
            status: 422,
          })
        : new Response(JSON.stringify({ data: { enabled: true, public_key: "AAAA" } }), { status: 200 });
    });

    const resultado = await syncPushSubscription();

    expect(resultado.situacao).toBe("recusado");
    expect(resultado.motivo).toBe("Campos inválidos.");
  });

  // Sem rede o PUT LANÇA: não é recusa do servidor, e a tela não pode dizer que foi.
  it("PUT sem rede (fetch lança): reporta sem_rede, não recusado", async () => {
    fetchFalso.mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method === "PUT") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ data: { enabled: true, public_key: "AAAA" } }), { status: 200 });
    });

    const resultado = await syncPushSubscription();

    expect(resultado.situacao).toBe("sem_rede");
    expect(resultado.motivo).toBe("");
  });

  // CONTROLE: o PUT aceito (200) segue igual ao que era — nada de recusa.
  it("PUT aceito (200): reporta ativo, sem recusa (controle)", async () => {
    const resultado = await syncPushSubscription();

    expect(resultado.situacao).toBe("ativo");
    expect(resultado.motivo).toBe("");
  });

  /**
   * ═══ ISSUE #3164 — O `ignorado` DIZ QUAL CAMINHO FOI ═══
   *
   * Estes caminhos devolviam TODOS o mesmo `ignorado`, sem motivo, e a tela só
   * tratava `recusado`/`sem_rede`: nesse caso o interruptor de Push ficava
   * ligado, nenhum aviso chegava e nada era dito. Cada caso abaixo NOMEIA um
   * caminho — sem eles, um motivo trocado (dizer "sem VAPID" a quem está sem
   * service worker) passaria despercebido, e a frase na tela daria a causa
   * errada.
   */
  describe("o `ignorado` diz QUAL caminho não inscreveu", () => {
    it("sem o par VAPID na instalação: motivo `sem_vapid`", async () => {
      fetchFalso.mockImplementation(async () =>
        new Response(JSON.stringify({ data: { enabled: false, public_key: "" } }), { status: 200 }),
      );

      const resultado = await syncPushSubscription();

      expect(resultado).toEqual({ situacao: "ignorado", motivo: "sem_vapid" });
      // NÃO desliga: o aviso com a aba aberta não depende de VAPID (#3157).
      expect(pushNaoEntrega(resultado)).toBe(false);
    });

    it("sem o service worker registrado: motivo `sem_service_worker`", async () => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        // O navegador aceitou o `register` mas não devolveu `pushManager`.
        value: { register: vi.fn(async () => ({})) },
      });

      const resultado = await syncPushSubscription();

      expect(resultado).toEqual({ situacao: "ignorado", motivo: "sem_service_worker" });
      expect(pushNaoEntrega(resultado)).toBe(false);
    });

    it("inscrição sem endpoint e sem as chaves: motivo `inscricao_incompleta`", async () => {
      subscribe.mockResolvedValueOnce({
        toJSON: () => ({ endpoint: "", keys: {} }),
      } as unknown as Awaited<ReturnType<typeof subscribe>>);

      const resultado = await syncPushSubscription();

      expect(resultado).toEqual({ situacao: "ignorado", motivo: "inscricao_incompleta" });
      expect(pushNaoEntrega(resultado)).toBe(true);
    });

    // O navegador LANÇA aqui (NotAllowedError, modo privado, Push desligado no
    // sistema). Antes esta rejeição escapava: `onToggle` a descartava e o
    // interruptor ficava ligado na tela — a mesma classe da #3116.
    it("o navegador recusa criar a inscrição: motivo `navegador_recusou`, sem rejeitar", async () => {
      subscribe.mockRejectedValueOnce(new Error("NotAllowedError"));

      const resultado = await syncPushSubscription();

      expect(resultado).toEqual({ situacao: "ignorado", motivo: "navegador_recusou" });
      expect(pushNaoEntrega(resultado)).toBe(true);
    });

    it("preferência da pessoa (push de mensagem desligado): motivo `preferencia_do_usuario`", async () => {
      window.localStorage.setItem("notify.prefs.v1", JSON.stringify({ message: { in_app: true, push: false } }));

      const resultado = await syncPushSubscription();

      expect(resultado).toEqual({ situacao: "ignorado", motivo: "preferencia_do_usuario" });
      // ⚠️ E NÃO desliga o interruptor: aqui ele diz uma escolha da pessoa, não
      // uma promessa de entrega. Ver o controle em `_client.test.tsx`.
      expect(pushNaoEntrega(resultado)).toBe(false);
    });

    it("fora do navegador (SSR): motivo `fora_do_navegador`", async () => {
      const janelaReal = globalThis.window;
      // @ts-expect-error — apagar de propósito para `typeof window === "undefined"` ser verdade.
      delete globalThis.window;
      try {
        const resultado = await syncPushSubscription();

        expect(resultado).toEqual({ situacao: "ignorado", motivo: "fora_do_navegador" });
        expect(pushNaoEntrega(resultado)).toBe(false);
      } finally {
        globalThis.window = janelaReal;
      }
    });

    // Não dá para LER a configuração: o `fetch` do GET não chegou ao servidor ou
    // a resposta não era JSON. Dizer "esta instalação não tem o par VAPID" aqui
    // seria chutar a causa — é o mesmo caso do PUT sem rede, e a tela já diz esse.
    it("GET da configuração não responde: `sem_rede`, nunca `sem_vapid`", async () => {
      fetchFalso.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const resultado = await syncPushSubscription();

      expect(resultado).toEqual({ situacao: "sem_rede", motivo: "" });
      expect(pushNaoEntrega(resultado)).toBe(true);
    });
  });

  /**
   * A TABELA, EM UM LUGAR SÓ (issue #3164): qual causa desliga o interruptor.
   *
   * É a decisão que a tela executa — deixá-la espalhada em `if`s é como o
   * defeito nasceu.
   */
  describe("pushNaoEntrega — a tabela causa × interruptor", () => {
    it("`ativo` não desliga; `recusado`/`sem_rede` desligam (o que a #3116 já mede)", () => {
      expect(pushNaoEntrega({ situacao: "ativo", motivo: "" })).toBe(false);
      expect(pushNaoEntrega({ situacao: "recusado", motivo: "Campos inválidos." })).toBe(true);
      expect(pushNaoEntrega({ situacao: "sem_rede", motivo: "" })).toBe(true);
    });

    it("CONTROLE: preferência da pessoa e `fora do navegador` NÃO desligam", () => {
      expect(pushNaoEntrega({ situacao: "ignorado", motivo: "preferencia_do_usuario" })).toBe(false);
      expect(pushNaoEntrega({ situacao: "ignorado", motivo: "fora_do_navegador" })).toBe(false);
    });

    // A tabela escrita à mão, e não derivada de `MOTIVOS_QUE_DESLIGAM`: um
    // motivo que entre na lista por engano tem de reprovar aqui (#3157).
    it("só o navegador que recusa ou devolve inscrição incompleta desliga; sem VAPID e sem service worker NÃO", () => {
      const esperado: Record<MotivoDoIgnorado, boolean> = {
        fora_do_navegador: false,
        preferencia_do_usuario: false,
        sem_vapid: false,
        sem_service_worker: false,
        inscricao_incompleta: true,
        navegador_recusou: true,
      };
      expect(MOTIVOS_DO_APARELHO.length, "a lista de motivos encolheu para nada").toBe(4);
      expect([...MOTIVOS_QUE_DESLIGAM].sort()).toEqual(["inscricao_incompleta", "navegador_recusou"]);
      for (const motivo of TODOS_OS_MOTIVOS) {
        expect(pushNaoEntrega({ situacao: "ignorado", motivo }), motivo).toBe(esperado[motivo]);
      }
    });

    it("sem notícia nenhuma (undefined), não mexe no interruptor", () => {
      expect(pushNaoEntrega(undefined)).toBe(false);
      expect(pushNaoEntrega(null)).toBe(false);
    });
  });
});
