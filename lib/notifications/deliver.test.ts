import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("./emit", () => ({ emitNotification: vi.fn() }));

import { toast } from "sonner";
import { entregarAviso } from "./deliver";
import { emitNotification } from "./emit";
import { gravarCanal } from "./prefs";

describe("entregarAviso", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("manda toast e push quando os dois canais estão ligados", () => {
    entregarAviso({
      category: "lead_assigned",
      kind: "lead_assigned",
      title: "Lead atribuído",
      body: "Carlos",
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(emitNotification).toHaveBeenCalledTimes(1);
  });

  it("omite push quando o canal está desligado", () => {
    gravarCanal("lead_won", "push", false);
    entregarAviso({
      category: "lead_won",
      kind: "lead_won",
      title: "Lead ganho",
      body: "ok",
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(emitNotification).not.toHaveBeenCalled();
  });

  it("o toast da mensagem leva a ação de abrir a conversa, e ela navega para o destino", () => {
    const assign = vi.fn();
    // `window.location` não é substituível direto no jsdom.
    vi.stubGlobal("window", {
      location: { assign, origin: "https://app.teste" },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });

    entregarAviso({
      category: "message",
      kind: "message_inbound",
      title: "Maria Souza",
      body: "oi",
      tag: "conv-1",
      href: "/app/inbox?id=conv-1",
    });

    const [, opcoes] = vi.mocked(toast).mock.calls.at(-1) as unknown as [
      string,
      { action?: { label: string; onClick: () => void } },
    ];
    expect(opcoes.action?.label).toBe("Abrir conversa");
    opcoes.action!.onClick();
    expect(assign).toHaveBeenCalledWith("/app/inbox?id=conv-1");
  });

  it("aviso sem destino não ganha ação — botão morto não é conserto", () => {
    entregarAviso({
      category: "lead_assigned",
      kind: "lead_assigned",
      title: "Lead atribuído",
      body: "Carlos",
    });

    const [, opcoes] = vi.mocked(toast).mock.calls.at(-1)!;
    expect(opcoes?.action).toBeUndefined();
  });
});
