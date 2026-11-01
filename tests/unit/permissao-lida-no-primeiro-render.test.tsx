import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * O INTERRUPTOR DE PUSH NÃO NASCE HABILITADO PARA DEPOIS SE DESABILITAR.
 *
 * ## O defeito
 *
 * `useNotificationPermission` fazia `useState("default")` + `useEffect(() =>
 * setPermission(getPermission()))`. O `"default"` é um CHUTE — uma das três
 * respostas possíveis, escolhida antes de olhar. Como `_client.tsx` desabilita
 * o Push por `denied || unsupported`, a sequência era:
 *
 *   1. primeiro render → `"default"` → interruptor HABILITADO;
 *   2. efeito roda DEPOIS do paint, lê `denied` → ele desabilita sozinho.
 *
 * Quem tem a notificação bloqueada via, por um instante, um controle pronto
 * para uso que sumia na frente dele.
 *
 * ## O instrumento: o PRIMEIRO render do cliente, gravado no próprio render
 *
 * `render()` da Testing Library roda os efeitos dentro de `act()` — com ele, o
 * código ANTIGO e o NOVO produzem o MESMO resultado final, e o teste ficaria
 * verde sobre o defeito. Por isso o `Switch` é trocado por um gravador que
 * anota o `disabled` de cada interruptor de Push na PRIMEIRA passada: um efeito
 * só consegue mudar passadas seguintes, então o valor gravado é o que existe
 * antes de qualquer efeito. Um valor correto aqui só é possível se a leitura
 * acontecer no RENDER.
 *
 * Até o #3113 o instrumento era `renderToStaticMarkup` — que é renderização de
 * SERVIDOR e lê o snapshot do servidor de `useSyncExternalStore`. Ele só via a
 * permissão real porque esse snapshot era o próprio `getPermission`, e era
 * justamente esse o defeito de hidratação: o HTML saía `disabled` e o cliente
 * hidratava `granted` (`_client.hidratacao.test.tsx`). Com o snapshot do
 * servidor constante, o servidor diz sempre `"unsupported"` — e a pergunta
 * "nasce habilitado?" passou a ser do cliente, que é onde este arquivo mede.
 *
 * ## O que isto NÃO cobre, declarado
 *
 * Não mede o que o usuário vê no navegador — mede a árvore que o React produz
 * sem efeitos. `tests/e2e/notificacoes-diz-o-que-falta.spec.ts` continua sendo
 * quem exercita a tela, e ele concede a permissão de propósito para isolar a
 * variável VAPID.
 */

const original = Reflect.getOwnPropertyDescriptor(globalThis, "Notification");

function comPermissaoDoNavegador(valor: string): void {
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: { permission: valor, requestPermission: vi.fn() },
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "Notification", original);
  else Reflect.deleteProperty(globalThis, "Notification");
  vi.resetModules();
});

/** O `disabled` de cada interruptor de Push, gravado na primeira passada do cliente. */
const gravador = vi.hoisted(() => ({ primeiraPassada: [] as boolean[] }));
vi.mock("@/components/ui/switch", () => ({
  Switch: (p: { "aria-label"?: string; disabled?: boolean }) => {
    if (p["aria-label"]?.endsWith(" via push") && gravador.primeiraPassada.length < 6) {
      gravador.primeiraPassada.push(p.disabled === true);
    }
    return null;
  },
}));

/** Monta o componente de verdade no cliente e devolve o que a PRIMEIRA passada desenhou. */
async function pushDesabilitadoNoPrimeiroRender(): Promise<boolean[]> {
  vi.resetModules();
  gravador.primeiraPassada.length = 0;
  const { NotificationPrefsClient } = await import("@/app/app/settings/notifications/_client");
  const container = document.createElement("div");
  const raiz = createRoot(container);
  await act(async () => {
    raiz.render(<NotificationPrefsClient />);
  });
  raiz.unmount();
  return [...gravador.primeiraPassada];
}

describe("a permissão do navegador é lida no primeiro render", () => {
  it("o instrumento está vivo — controle positivo antes de qualquer conclusão", async () => {
    comPermissaoDoNavegador("denied");
    // Se o gravador parar de gravar, todo caso abaixo vira `[] === []` e passa
    // verde medindo nada.
    expect(
      (await pushDesabilitadoNoPrimeiroRender()).length,
      "o gravador não viu nenhum interruptor 'via push' — o instrumento morreu",
    ).toBe(6);
  });

  it("⭐ com a notificação BLOQUEADA no navegador, ele já nasce desabilitado", async () => {
    comPermissaoDoNavegador("denied");
    expect(
      (await pushDesabilitadoNoPrimeiroRender()).every(Boolean),
      "o interruptor nasce habilitado e só desabilita depois do efeito — " +
        "é a janela em que a tela oferece o que já está negado",
    ).toBe(true);
  });

  it("⭐ com a notificação CONCEDIDA, ele já nasce habilitado", async () => {
    comPermissaoDoNavegador("granted");
    // O outro sentido: um conserto que simplesmente desabilitasse sempre
    // passaria no caso acima e falharia aqui. Guarda de um lado só vira defeito
    // do outro — e foi exatamente assim que o detector quebrado desta suíte
    // apareceu: os dois primeiros casos estavam verdes medindo a folha de
    // estilo, e só este reprovou.
    expect(
      (await pushDesabilitadoNoPrimeiroRender()).some(Boolean),
      "a permissão está concedida e o interruptor nasce desabilitado",
    ).toBe(false);
  });

  it("⭐ VAPID ausente NÃO desabilita o Push — o conserto exagerado, barrado", async () => {
    /**
     * Esta asserção morava em `tests/e2e/notificacoes-diz-o-que-falta.spec.ts`
     * e não podia viver lá. MEDIDO no Chromium do Playwright:
     *
     *     baseline headless                             -> denied
     *     grantPermissions(["notifications"]) sem origin -> denied
     *     grant com origin explícito                     -> denied
     *     headless:false + grant                         -> granted
     *
     * `Notification.permission` é **denied em headless, sempre**, e o CI roda
     * headless — então lá o controle está travado por `denied`, um motivo que
     * nada tem a ver com VAPID. A spec passava só enquanto ganhava a corrida
     * contra a hidratação.
     *
     * Aqui a variável fica isolada: NENHUM `VAPID_*` está definido neste
     * processo (é `vitest`, não o servidor Next), a permissão está `granted`, e
     * o controle tem de nascer habilitado. Se alguém "consertar" o defeito de
     * promessa desabilitando o Push por falta de chaves, este caso reprova.
     *
     * Por que isso importa: sem VAPID o aviso na bandeja AINDA funciona com a
     * aba aberta — é `new Notification()` em `lib/notifications/emit.ts`, que
     * não depende de inscrição. Desabilitar trocaria prometer demais por
     * entregar de menos, e o segundo não deixa rastro.
     */
    expect(
      process.env.VAPID_PUBLIC_KEY ?? "",
      "controle: este caso só significa algo sem VAPID no ambiente",
    ).toBe("");

    comPermissaoDoNavegador("granted");
    expect(
      (await pushDesabilitadoNoPrimeiroRender()).some(Boolean),
      "sem VAPID o Push nasceu desabilitado — é o conserto exagerado, que tira " +
        "o aviso com a aba aberta junto",
    ).toBe(false);
  });
});
