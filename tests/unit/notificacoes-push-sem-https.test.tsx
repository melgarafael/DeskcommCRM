import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Com o par VAPID presente o servidor diz "pronto", mas o navegador só entrega
 * aviso com o app fechado em contexto seguro (https ou localhost). Numa
 * instalação em http://IP, a tela não pode afirmar o contrário (ADR-0006,
 * decisão c).
 *
 * A árvore do Server Component é montada no jsdom: é o navegador que sabe se o
 * endereço é seguro, então a medida é a do cliente, não a do HTML do servidor
 * (essa está em `notificacoes-tela-diz-o-que-falta.test.tsx`).
 */
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true }));
vi.mock("@/lib/auth/server", () => ({ requireAuth: vi.fn().mockResolvedValue({}) }));
vi.mock("@/app/app/settings/notifications/_client", () => ({ NotificationPrefsClient: () => null }));
vi.mock("@/app/app/settings/notifications/_tarefas", () => ({ TaskReminderPrefs: () => null }));
vi.mock("@/app/app/settings/notifications/_sons", () => ({ SonsDosAvisos: () => null }));
vi.mock("@/app/app/settings/notifications/_tela-bloqueada", () => ({ ConteudoNaTelaBloqueada: () => null }));

import NotificationsPage from "@/app/app/settings/notifications/page";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tela de Notificações com o par presente", () => {
  it("em contexto seguro com PushManager: diz que funciona com a aba fechada", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PushManager", function PushManager() {});
    render(await NotificationsPage());
    expect(screen.getByTestId("push-status-pronto")).toHaveTextContent("inclusive com a aba fechada");
    expect(screen.queryByTestId("push-status-sem-https")).toBeNull();
  });

  it("em http://IP (contexto inseguro): não promete a aba fechada e diz que falta https", async () => {
    vi.stubGlobal("isSecureContext", false);
    render(await NotificationsPage());
    expect(screen.queryByTestId("push-status-pronto")).toBeNull();
    expect(screen.getByTestId("push-status-sem-https")).toHaveTextContent(/não usa conexão segura \(https\)/);
  });
});
