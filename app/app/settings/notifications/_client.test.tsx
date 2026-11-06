/**
 * A PRIMEIRA RENDERIZAÇÃO DO CLIENTE MOSTRA AS MESMAS PREFERÊNCIAS QUE O SERVIDOR MANDOU.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR (issue #690) ═══
 *
 * `NotificationPrefsClient` inicializava com
 * `useState<NotifyPrefs>(() => lerPrefs())`. O inicializador de `useState` roda
 * de novo na hidratação — que É a primeira renderização do cliente, a mesma que
 * o React compara contra o HTML que o servidor mandou. `lerPrefs()` decide a
 * fonte por `typeof window === "undefined"`: sem `window` devolve o padrão (tudo
 * ligado); com `window`, lê `localStorage` de verdade.
 *
 * Quem desligou o push de mensagem produzia, nesse instante, um cliente dizendo
 * `push: false` contra um servidor dizendo `push: true` — em dez `Switch` e no
 * `data-testid` que `canalLigado("message", "push")` alimentava durante o
 * render. É a mesma classe que o PR #666 consertou no seletor de tema
 * (`lib/theme.tsx`), e esta é a segunda instância viva dela.
 *
 * ═══ POR QUE A RECEITA ABAIXO É FIEL, E NÃO UM TRUQUE DE jsdom ═══
 *
 * `renderToStaticMarkup` nunca roda `useEffect` — é o mesmo motivo que
 * `lib/theme.test.tsx` e `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx`
 * usam. Isso o torna um substituto fiel tanto do HTML do servidor quanto da
 * saída da PRIMEIRA renderização do cliente (a que a hidratação compara),
 * porque nos dois casos nenhum efeito rodou ainda. Em jsdom `window` sempre
 * existe, então "renderizar como servidor" exige apagá-lo de propósito durante
 * a chamada — `renderToStaticMarkup` não toca em nenhuma API de DOM.
 *
 * ═══ SABOTAGEM QUE ESTE ARQUIVO JÁ REPROVOU ═══
 *
 * Voltar `useState<NotifyPrefs>(() => lerPrefs())` (o defeito de volta, com o
 * conserto no lugar): as duas asserções de igualdade ficam vermelhas — a
 * primeira passada do cliente passa a dizer `alerts-enable` enquanto o servidor
 * continua dizendo `alerts-toggle`.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationPrefsClient as NotificationPrefsClientType } from "./_client";
import type * as Prefs from "@/lib/notifications/prefs";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
// O assunto aqui é o store das preferências, não a permissão do navegador.
vi.mock("@/hooks/notifications/useNotificationPermission", () => ({
  useNotificationPermission: () => ({
    permission: "granted",
    enabled: true,
    request: async () => "granted",
    setEnabled: () => {},
  }),
}));

const pushClient = vi.hoisted(() => ({
  encerrarPushDesteAparelho: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => ({ situacao: "ativo", motivo: "" })),
}));
/**
 * ⚠️ `importOriginal`, E NÃO UM OBJETO SÓ COM OS DOIS DUBLÊS.
 *
 * `_client.tsx` chama `pushNaoEntrega` (a tabela causa × interruptor) e
 * `ehMotivoDoAparelho`, além do `syncPushSubscription`. Um dublê que só traz os
 * dois de sempre deixa as outras DUAS `undefined`, a tela lança ao clicar e o
 * teste morre com "expected null not to be null" — que parece defeito do
 * componente e não é. Aqui só a ida à rede é dublada; a decisão é a de produção,
 * que é justamente o que este arquivo mede.
 */
vi.mock("@/lib/notifications/push_client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/push_client")>()),
  ...pushClient,
}));

const CHAVE = "notify.prefs.v1";

let NotificationPrefsClient: typeof NotificationPrefsClientType;
let prefs: typeof Prefs;

beforeEach(async () => {
  window.localStorage.clear();
  // O cache do external store (`prefsEmCache`) mora no MÓDULO, não no
  // componente — é o que faz `getSnapshot` devolver sempre a mesma referência
  // sem reler o storage a cada render. Mas isso faria um teste vazar cache para
  // o de depois; `resetModules` + reimportar dá a cada `it` um módulo (e um
  // cache) genuinamente zerado, igual a uma aba nova.
  vi.resetModules();
  ({ NotificationPrefsClient } = await import("./_client"));
  prefs = await import("@/lib/notifications/prefs");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  pushClient.encerrarPushDesteAparelho.mockClear();
  pushClient.syncPushSubscription.mockClear();
});

/** O que o servidor Node (sem `window`) produz — `renderToStaticMarkup` nunca roda efeito. */
function renderizarComoServidor(): string {
  const janelaReal = globalThis.window;
  // @ts-expect-error — apagar de propósito para `typeof window === "undefined"` ser verdade.
  delete globalThis.window;
  try {
    return renderToStaticMarkup(<NotificationPrefsClient />);
  } finally {
    globalThis.window = janelaReal;
  }
}

/** O que a PRIMEIRA renderização do cliente produz — mesma chamada, `window` de verdade. */
function renderizarComoPrimeiraPassadaDoCliente(): string {
  return renderToStaticMarkup(<NotificationPrefsClient />);
}

function montar(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<NotificationPrefsClient />);
  });
  return container;
}

describe("as preferências de notificação não divergem entre o SSR e a primeira renderização do cliente", () => {
  it("com o push de mensagem desligado, a primeira passada do cliente bate com o servidor", () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));

    const doServidor = renderizarComoServidor();
    const doCliente = renderizarComoPrimeiraPassadaDoCliente();

    // Os dois precisam dizer "alerts-toggle" — é o que `getServerSnapshot`
    // devolve, e é o que a hidratação tem de bater ANTES de o React trocar
    // para `getSnapshot`, o valor real.
    expect(doServidor).toContain('data-testid="alerts-toggle"');
    expect(
      doCliente,
      "A primeira renderização do cliente leu o localStorage direto no " +
        "inicializador do useState, produzindo 'alerts-enable' — diferente do " +
        "que o servidor mandou ('alerts-toggle'). É o hydration mismatch.",
    ).toContain('data-testid="alerts-toggle"');
    expect(doCliente).toBe(doServidor);
  });

  it("com o interruptor legado `alerts.enabled=0`, a primeira passada do cliente também bate", () => {
    // `prefsPadrao()` consulta esta chave antes de qualquer outra: é um
    // SEGUNDO caminho para o mesmo `localStorage`, e o que passasse por um não
    // passaria necessariamente pelo outro.
    window.localStorage.setItem("alerts.enabled", "0");

    const doServidor = renderizarComoServidor();
    const doCliente = renderizarComoPrimeiraPassadaDoCliente();

    expect(doServidor).toContain('data-testid="alerts-toggle"');
    expect(doCliente).toBe(doServidor);
  });

  it("GUARDA DE VACUIDADE: depois do commit, a preferência real aparece", () => {
    // Sem este caso, os dois de cima passariam num componente que nunca lê o
    // localStorage — "sempre ligado" bateria com "sempre ligado" para sempre, e
    // o defeito oposto (a preferência do usuário nunca é aplicada) ficaria
    // invisível.
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));

    expect(montar().innerHTML).toContain('data-testid="alerts-enable"');
  });

  it("gravarCanal avisa os ouvintes: o interruptor reflete a troca sem recarregar", () => {
    const container = montar();
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');

    act(() => {
      prefs.gravarCanal("message", "push", false);
    });

    expect(container.innerHTML).toContain('data-testid="alerts-enable"');
  });
});

describe("o interruptor de Push de mensagem liga e desliga a inscrição do aparelho", () => {
  async function clicar(container: HTMLElement, rotulo: string) {
    const botao = container.querySelector(`[aria-label="${rotulo}"]`) as HTMLElement;
    await act(async () => {
      botao.click();
    });
  }

  it("desligar encerra o push deste aparelho", async () => {
    const container = montar();
    await clicar(container, "Nova mensagem via push");
    expect(pushClient.encerrarPushDesteAparelho).toHaveBeenCalledTimes(1);
    expect(pushClient.syncPushSubscription).not.toHaveBeenCalled();
  });

  it("religar com a permissão concedida reinscreve o aparelho", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();
    await clicar(container, "Nova mensagem via push");
    expect(pushClient.syncPushSubscription).toHaveBeenCalledTimes(1);
    expect(pushClient.encerrarPushDesteAparelho).not.toHaveBeenCalled();
  });

  /**
   * ISSUE #3116 — a recusa tem de CHEGAR À TELA, e o interruptor não mente.
   *
   * O servidor recusou (422) a inscrição; `syncPushSubscription` reporta
   * `recusado`. A tela mostra a frase e o interruptor volta a desligar, porque
   * nenhum aviso chegaria com o site fechado. No código antigo nada disso
   * acontecia: o interruptor ficava ligado em silêncio.
   */
  it("inscrição recusada pelo servidor: a mensagem aparece e o interruptor NÃO fica ligado", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    pushClient.syncPushSubscription.mockResolvedValueOnce({
      situacao: "recusado",
      motivo: "Campos inválidos.",
    });
    const container = montar();

    await clicar(container, "Nova mensagem via push");

    expect(container.querySelector('[data-testid="push-recusado"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "O servidor recusou a inscrição deste aparelho, então os avisos não vão chegar: o interruptor de Push voltou a ficar desligado.",
    );
    // A frase do servidor também chega — é o que a rota já devolve.
    expect(container.textContent).toContain("Campos inválidos.");
    // E o interruptor voltou a desligar: `alerts-enable`, nunca `alerts-toggle`.
    expect(container.innerHTML).toContain('data-testid="alerts-enable"');
    expect(container.innerHTML).not.toContain('data-testid="alerts-toggle"');
  });

  // Sem rede, a causa dita é a rede — nunca "o servidor recusou".
  it("sem rede: diz que não falou com o servidor, não que ele recusou, e o interruptor desliga", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    pushClient.syncPushSubscription.mockResolvedValueOnce({ situacao: "sem_rede", motivo: "" });
    const container = montar();

    await clicar(container, "Nova mensagem via push");

    expect(container.querySelector('[data-testid="push-recusado"]')).not.toBeNull();
    expect(container.textContent).toContain("Não consegui falar com o servidor");
    expect(container.textContent).not.toContain("O servidor recusou");
    expect(container.innerHTML).toContain('data-testid="alerts-enable"');
    expect(container.innerHTML).not.toContain('data-testid="alerts-toggle"');
  });

  /**
   * ISSUE #3164 — OS CAMINHOS QUE NÃO INSCREVEM NADA E NÃO ERAM TRATADOS.
   *
   * O navegador que não registra o service worker e a instalação sem o par VAPID
   * devolvem `ignorado`; a tela só olhava `recusado`/`sem_rede`, então o
   * interruptor ficava LIGADO e nenhum aviso chegava, sem uma palavra. Cada
   * causa tem a sua frase — a pessoa precisa saber de quem é o problema.
   */
  it("navegador sem service worker (`ignorado`): frase própria e o interruptor continua ligado (#3157)", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    pushClient.syncPushSubscription.mockResolvedValueOnce({
      situacao: "ignorado",
      motivo: "sem_service_worker",
    });
    const container = montar();

    await clicar(container, "Nova mensagem via push");

    const aviso = container.querySelector('[data-testid="push-recusado"]');
    expect(aviso, "o interruptor ficou ligado em silêncio — o defeito da #3164").not.toBeNull();
    expect(aviso?.getAttribute("data-motivo")).toBe("sem_service_worker");
    expect(container.textContent).toContain(
      "Este navegador não registrou o service worker dos avisos: com o site fechado, este aparelho não recebe aviso.",
    );
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');
    expect(container.innerHTML).not.toContain('data-testid="alerts-enable"');
  });

  // Sem VAPID quem fala é o cartão de `page.tsx`; o interruptor fica ligado
  // porque o aviso com a aba aberta funciona sem as chaves (#3157).
  it("instalação sem o par VAPID (`ignorado`): o interruptor continua ligado e nada é repetido aqui", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    pushClient.syncPushSubscription.mockResolvedValueOnce({ situacao: "ignorado", motivo: "sem_vapid" });
    const container = montar();

    await clicar(container, "Nova mensagem via push");

    expect(container.querySelector('[data-testid="push-recusado"]')).toBeNull();
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');
    expect(container.innerHTML).not.toContain('data-testid="alerts-enable"');
  });

  /**
   * ESTA É A PROPRIEDADE QUE IMPEDE O CONSERTO PREGUIÇOSO: um texto só para as
   * causas. Duas causas com a mesma frase significam que uma delas está
   * dizendo a causa errada — e é o defeito de novo, com outra roupa.
   */
  it("as causas com frase: uma frase DIFERENTE para cada, e só as do navegador desligam o interruptor", async () => {
    // `sem_vapid` não está aqui: a frase dele é o cartão da página (caso acima).
    const desliga = { sem_service_worker: false, inscricao_incompleta: true, navegador_recusou: true } as const;
    const motivos = Object.keys(desliga) as (keyof typeof desliga)[];
    const frases = new Map<string, string>();

    for (const motivo of motivos) {
      // Pela store, e não só pelo storage: `sem_service_worker` deixa o
      // interruptor LIGADO, e o cache da store sobreviveria à volta seguinte.
      prefs.gravarCanal("message", "push", false);
      pushClient.syncPushSubscription.mockResolvedValueOnce({ situacao: "ignorado", motivo });
      const container = montar();

      await clicar(container, "Nova mensagem via push");

      const aviso = container.querySelector('[data-testid="push-recusado"]');
      expect(aviso?.getAttribute("data-motivo"), motivo).toBe(motivo);
      expect(container.innerHTML, motivo).toContain(
        desliga[motivo] ? 'data-testid="alerts-enable"' : 'data-testid="alerts-toggle"',
      );
      frases.set(motivo, aviso?.textContent ?? "");
    }

    expect(frases.size).toBe(motivos.length);
    expect(new Set(frases.values()).size, "duas causas mostram a MESMA frase").toBe(motivos.length);
    for (const [motivo, frase] of frases) expect(frase.length, motivo).toBeGreaterThan(40);
  });

  // CONTROLE: `ignorado` que é só preferência da pessoa NÃO desliga o
  // interruptor. Ali ele diz uma escolha dela; desfazê-la sozinho seria tirar a
  // escolha da mão de quem clicou — e o remédio seria pior que a doença.
  it("`ignorado` que é só preferência da pessoa: NÃO desliga o interruptor nem avisa (controle)", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    pushClient.syncPushSubscription.mockResolvedValueOnce({
      situacao: "ignorado",
      motivo: "preferencia_do_usuario",
    });
    const container = montar();

    await clicar(container, "Nova mensagem via push");

    expect(container.querySelector('[data-testid="push-recusado"]')).toBeNull();
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');
    expect(container.innerHTML).not.toContain('data-testid="alerts-enable"');
  });

  // CONTROLE: aceita (ativo), o interruptor segue ligado e nada é dito.
  it("inscrição aceita: o interruptor fica ligado e nenhuma recusa aparece (controle)", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();

    await clicar(container, "Nova mensagem via push");

    expect(container.querySelector('[data-testid="push-recusado"]')).toBeNull();
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');
  });

  it("outras categorias e o in-app não mexem na inscrição", async () => {
    const container = montar();
    await clicar(container, "Lead ganho via push");
    await clicar(container, "Nova mensagem via in_app");
    expect(pushClient.encerrarPushDesteAparelho).not.toHaveBeenCalled();
    expect(pushClient.syncPushSubscription).not.toHaveBeenCalled();
  });

  // A inscrição é do aparelho e o servidor não separa categorias: sem ela,
  // nenhum push chega. A tela não pode mostrar os outros como ligados.
  it("com o push de mensagem desligado, os outros pushes aparecem desligados e travados, com o porquê", () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();
    const lead = container.querySelector('[aria-label="Lead ganho via push"]') as HTMLButtonElement;
    expect(lead.getAttribute("aria-checked")).toBe("false");
    expect(lead.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Desligar o push de mensagem desliga todos os avisos deste aparelho fora do app.",
    );
  });

  it("com o push de mensagem ligado, os outros pushes seguem a própria preferência (controle)", () => {
    const container = montar();
    const lead = container.querySelector('[aria-label="Lead ganho via push"]') as HTMLButtonElement;
    expect(lead.getAttribute("aria-checked")).toBe("true");
    expect(lead.disabled).toBe(false);
  });
});
