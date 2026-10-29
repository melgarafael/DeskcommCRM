/**
 * A TELA CONTRA O `syncPushSubscription` DE VERDADE — SEM DUBLÊ DA INSCRIÇÃO.
 *
 * ## Por que este arquivo existe, e o que ele acrescenta ao `_client.test.tsx`
 *
 * `_client.test.tsx` dubla o `syncPushSubscription` e mede a DECISÃO da tela:
 * qual frase, e se o interruptor volta a desligar. Isso é necessário e não é
 * suficiente — dublê não prova que o caminho real DEVOLVE aquele motivo. Quem
 * mede os caminhos de retorno é `lib/notifications/push_client.test.ts`.
 *
 * Aqui não há dublê: a inscrição é a de produção, e o que se dubla é só o que
 * compõe o CENÁRIO — a permissão do navegador (`Notification`), o
 * `navigator.serviceWorker` e o `fetch`. É a medida que o mantenedor pediu
 * (issue #3164): "quando o navegador não registra o service worker, ou quando a
 * instalação não tem o par VAPID, o interruptor de Push fica ligado e nenhuma
 * notificação chega, sem aviso".
 *
 * ## O defeito, medido no caminho inteiro
 *
 * `syncPushSubscription` devolvia `ignorado` sem motivo; `_client.tsx` só
 * revertia o interruptor em `recusado`/`sem_rede`. Sem service worker e sem
 * VAPID são exatamente dois caminhos que caem no `ignorado` — e nos dois o
 * interruptor ficava ligado, sem uma palavra na tela. Ver o caso por caminho.
 *
 * ## E por que, nesses dois, o interruptor CONTINUA ligado (#3157)
 *
 * O interruptor também libera o aviso na bandeja com a aba ABERTA
 * (`lib/notifications/emit.ts`), que não depende de VAPID nem de inscrição.
 * Desligá-lo por falta de chaves mataria um aviso que funciona — a decisão
 * registrada em `page.tsx` ("O INTERRUPTOR CONTINUA LIGÁVEL DE PROPÓSITO").
 * Sem VAPID quem fala é o cartão da página; sem service worker, a frase daqui.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationPrefsClient as NotificationPrefsClientType } from "./_client";

// O assunto aqui é a inscrição, não a tradução: `t()` devolve a chave, que é o
// texto em português — é o que a tela mostra para quem usa o produto em pt-BR.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/notifications/useNotificationPermission", () => ({
  useNotificationPermission: () => ({
    permission: "granted",
    enabled: true,
    request: async () => "granted",
    setEnabled: () => {},
  }),
}));

const CHAVE = "notify.prefs.v1";

const fetchFalso = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }));

let NotificationPrefsClient: typeof NotificationPrefsClientType;

/** O service worker que o navegador devolve — `{}` é o navegador que não registrou. */
function comServiceWorker(registro: unknown): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => registro) },
  });
}

function inscricaoValida() {
  return {
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => ({
        toJSON: () => ({ endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" } }),
      }),
    },
  };
}

beforeEach(async () => {
  window.localStorage.clear();
  vi.resetModules();
  vi.stubGlobal("Notification", { permission: "granted" });
  // Padrão: a instalação SEM o par VAPID — o estado de todo primeiro deploy e o
  // que a issue nomeia. Quem precisa de outro responde o seu.
  fetchFalso.mockImplementation(
    async () => new Response(JSON.stringify({ data: { enabled: false } }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchFalso);
  ({ NotificationPrefsClient } = await import("./_client"));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
  fetchFalso.mockReset();
});

function montar(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<NotificationPrefsClient />);
  });
  return container;
}

async function ligarOPush(container: HTMLElement): Promise<void> {
  const botao = container.querySelector('[aria-label="Nova mensagem via push"]') as HTMLElement;
  await act(async () => {
    botao.click();
  });
}

function interruptorDoPush(container: HTMLElement): Element | null {
  return container.querySelector('[aria-label="Nova mensagem via push"]');
}

describe("sem inscrição, a tela diz a causa sem tirar o aviso com a aba aberta (issues #3164 e #3157)", () => {
  it("navegador não registra o service worker: a frase é a do service worker e o interruptor continua ligado", async () => {
    // `register` resolve SEM `pushManager`: é o navegador que não registra o
    // service worker — o primeiro caminho que a issue nomeia.
    comServiceWorker({});
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();

    await ligarOPush(container);

    const aviso = container.querySelector('[data-testid="push-recusado"]');
    expect(aviso, "o interruptor ficou ligado e a tela não disse nada").not.toBeNull();
    expect(aviso?.getAttribute("data-motivo")).toBe("sem_service_worker");
    expect(aviso?.getAttribute("role")).toBe("status");
    expect(container.textContent).toContain(
      "Este navegador não registrou o service worker dos avisos: com o site fechado, este aparelho não recebe aviso.",
    );
    expect(interruptorDoPush(container)?.getAttribute("aria-checked")).toBe("true");
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');
    // Nada foi inscrito: nenhum PUT saiu.
    expect(
      fetchFalso.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT"),
    ).toBe(false);
  });

  // ⚠️ O estado de todo primeiro deploy. Com o interruptor desligando aqui, a
  // instalação sem chaves não conseguia manter o Push de mensagem ligado — e
  // junto ia o aviso com a aba aberta, que funciona sem VAPID (#3157).
  it("instalação sem o par VAPID: o interruptor continua ligado e o cliente não repete o cartão da página", async () => {
    comServiceWorker(inscricaoValida());
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();

    await ligarOPush(container);

    expect(interruptorDoPush(container)?.getAttribute("aria-checked")).toBe("true");
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');
    // Quem explica a falta das chaves é o cartão de `page.tsx`, não uma
    // segunda frase aqui.
    expect(container.querySelector('[data-testid="push-recusado"]')).toBeNull();
    expect(container.textContent).not.toContain("O servidor recusou a inscrição");
  });

  it("CONTROLE (#3157): o PUT recusado pelo servidor segue com a frase dele e o interruptor desligado", async () => {
    comServiceWorker(inscricaoValida());
    fetchFalso.mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method === "PUT")
        return new Response(JSON.stringify({ error: { message: "Campos inválidos." } }), {
          status: 422,
        });
      return new Response(JSON.stringify({ data: { enabled: true, public_key: "AAAA" } }), {
        status: 200,
      });
    });
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();

    await ligarOPush(container);

    const aviso = container.querySelector('[data-testid="push-recusado"]');
    expect(aviso?.getAttribute("data-motivo")).toBe("recusado");
    expect(container.textContent).toContain(
      "O servidor recusou a inscrição deste aparelho, então os avisos não vão chegar: o interruptor de Push voltou a ficar desligado.",
    );
    // A frase que a rota mandou também aparece — é o que a #3157 consertou.
    expect(container.textContent).toContain("Campos inválidos.");
    expect(container.innerHTML).toContain('data-testid="alerts-enable"');
  });

  it("CONTROLE (#3157): com a inscrição aceita, o interruptor fica ligado e nada é dito", async () => {
    comServiceWorker(inscricaoValida());
    fetchFalso.mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method === "PUT") return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ data: { enabled: true, public_key: "AAAA" } }), {
        status: 200,
      });
    });
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();

    await ligarOPush(container);

    expect(container.querySelector('[data-testid="push-recusado"]')).toBeNull();
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');
  });
});
