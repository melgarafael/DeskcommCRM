/**
 * A chave de Push só aparece LIGADA quando este aparelho concedeu a permissão.
 *
 * As preferências nascem com o Push ligado em todo tipo, mas a inscrição do
 * aparelho só é criada no toque que pede a permissão. Antes, quem nunca tocou
 * via tudo ligado num celular que não estava inscrito em nada — e nenhum aviso
 * chegava com o app fechado. Desligado até a permissão, o primeiro toque liga,
 * pede a permissão e inscreve o aparelho.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const permissao = vi.hoisted(() => ({ valor: "default" as string }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/notifications/useNotificationPermission", () => ({
  useNotificationPermission: () => ({
    permission: permissao.valor,
    enabled: false,
    request: async () => permissao.valor,
    setEnabled: () => {},
  }),
}));
vi.mock("@/lib/notifications/push_client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/push_client")>()),
  encerrarPushDesteAparelho: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => ({ situacao: "ativo", motivo: "" })),
}));

let host: HTMLDivElement;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
});

async function chavesDePush(): Promise<string[]> {
  const { NotificationPrefsClient } = await import("@/app/app/settings/notifications/_client");
  const root = createRoot(host);
  await act(async () => {
    root.render(<NotificationPrefsClient />);
  });
  const estados = Array.from(host.querySelectorAll('[aria-label$="via push"]')).map(
    (el) => el.getAttribute("aria-checked") ?? el.getAttribute("data-state") ?? "",
  );
  await act(async () => root.unmount());
  return estados;
}

describe("Push: a chave diz se o aparelho pode receber", () => {
  it("permissão ainda não pedida: todas desligadas", async () => {
    permissao.valor = "default";
    const estados = await chavesDePush();
    expect(estados.length).toBeGreaterThan(0);
    expect(estados.every((e) => e === "false" || e === "unchecked")).toBe(true);
  });

  it("permissão concedida: as preferências padrão aparecem ligadas", async () => {
    permissao.valor = "granted";
    const estados = await chavesDePush();
    expect(estados.every((e) => e === "true" || e === "checked")).toBe(true);
  });
});
