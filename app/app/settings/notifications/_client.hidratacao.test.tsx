/**
 * A PERMISSÃO DO NAVEGADOR NÃO DIVERGE NA HIDRATAÇÃO — HTML DO SERVIDOR + `hydrateRoot` DE VERDADE.
 *
 * `useSyncExternalStore(assinarPermissao, getPermission, getPermission)` usava a
 * mesma função como snapshot do SERVIDOR. No servidor ela devolve
 * `"unsupported"` (não existe `Notification`), e o HTML sai com os interruptores
 * de Push `disabled`. Na hidratação o React chama o snapshot do servidor NO
 * CLIENTE — e ali ele devolvia o valor real (`"granted"`): o render da
 * hidratação divergia do HTML, e o React não corrige atributo divergente. Com a
 * permissão concedida, os seis interruptores ficavam desabilitados até a próxima
 * navegação; com a permissão negada, o parágrafo de bloqueio só existia no
 * cliente e cada carga dava o erro #418 de hidratação.
 *
 * Aqui o componente e o hook são os de produção; só a permissão do navegador
 * (`Notification`) e a rede do push são dublês.
 */
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationPermissionState } from "@/lib/notifications/permission";
import type { NotificationPrefsClient as NotificationPrefsClientType } from "./_client";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/lib/notifications/push_client", () => ({
  encerrarPushDesteAparelho: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => {}),
}));

const BLOQUEIO = "O navegador bloqueou as notificações.";
let NotificationPrefsClient: typeof NotificationPrefsClientType;

beforeEach(async () => {
  window.localStorage.clear();
  vi.resetModules();
  ({ NotificationPrefsClient } = await import("./_client"));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** O HTML do servidor Node: sem `window` e sem `Notification`. */
function htmlDoServidor(): string {
  const janelaReal = globalThis.window;
  // @ts-expect-error — apagar de propósito para `typeof window === "undefined"` ser verdade.
  delete globalThis.window;
  try {
    return renderToString(<NotificationPrefsClient />);
  } finally {
    globalThis.window = janelaReal;
  }
}

/** Hidrata o HTML do servidor num navegador cuja permissão é `permissao`. */
async function hidratar(permissao: NotificationPermissionState) {
  const html = htmlDoServidor();
  if (permissao !== "unsupported") {
    vi.stubGlobal("Notification", { permission: permissao, requestPermission: async () => permissao });
  }
  const errosDeHidratacao: unknown[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  await act(async () => {
    hydrateRoot(container, <NotificationPrefsClient />, {
      onRecoverableError: (erro) => errosDeHidratacao.push(erro),
    });
  });
  const divergencias = consoleError.mock.calls.filter((c) => /hydrat/i.test(String(c[0])));
  const pushes = [...container.querySelectorAll<HTMLButtonElement>('[aria-label$=" via push"]')];
  return { container, errosDeHidratacao, divergencias, pushes };
}

describe("Configurações › Notificações hidrata sem divergir da permissão do navegador", () => {
  it("permissão concedida: depois de recarregar, os interruptores de Push ficam habilitados", async () => {
    const { errosDeHidratacao, divergencias, pushes } = await hidratar("granted");
    expect(pushes).toHaveLength(6);
    expect(
      pushes.filter((b) => b.disabled).map((b) => b.getAttribute("aria-label")),
      "interruptor de Push preso em `disabled`: o HTML do servidor venceu a hidratação",
    ).toEqual([]);
    expect(errosDeHidratacao).toEqual([]);
    expect(divergencias).toEqual([]);
  });

  it("permissão negada: o aviso de bloqueio aparece sem erro de hidratação (#418)", async () => {
    const { container, errosDeHidratacao, divergencias, pushes } = await hidratar("denied");
    expect(errosDeHidratacao).toEqual([]);
    expect(divergencias).toEqual([]);
    expect(container.textContent).toContain(BLOQUEIO);
    expect(pushes.every((b) => b.disabled)).toBe(true);
  });

  it("controle: sem `Notification` no navegador, tudo segue desabilitado e sem aviso de bloqueio", async () => {
    const { container, errosDeHidratacao, pushes } = await hidratar("unsupported");
    expect(errosDeHidratacao).toEqual([]);
    expect(pushes.every((b) => b.disabled)).toBe(true);
    expect(container.textContent).not.toContain(BLOQUEIO);
  });
});
