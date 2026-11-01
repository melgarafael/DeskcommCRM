import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("./emit", () => ({ emitNotification: vi.fn() }));

import { toast } from "sonner";
import { entregarAviso } from "./deliver";
import { emitNotification } from "./emit";
import { gravarCanal } from "./prefs";

describe("entregarAviso", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("sem servidor no teste"))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("manda toast e push quando os dois canais estão ligados", async () => {
    entregarAviso({
      category: "lead_assigned",
      kind: "lead_assigned",
      title: "Lead atribuído",
      body: "Carlos",
    });
    expect(toast).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(emitNotification).toHaveBeenCalledTimes(1));
  });

  it("omite push quando o canal está desligado", async () => {
    gravarCanal("lead_won", "push", false);
    entregarAviso({
      category: "lead_won",
      kind: "lead_won",
      title: "Lead ganho",
      body: "ok",
    });
    expect(toast).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitNotification).not.toHaveBeenCalled();
  });

  it("push de mensagem desligado: nenhuma categoria vai à bandeja (a inscrição é do aparelho)", async () => {
    gravarCanal("message", "push", false);
    entregarAviso({ category: "lead_assigned", kind: "lead_assigned", title: "Lead atribuído", body: "Carlos" });
    expect(toast).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
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

  it("o toast fica com o conteúdo; a bandeja segue a opção declarada", async () => {
    entregarAviso({
      category: "message",
      kind: "message_inbound",
      title: "Maria Souza",
      body: "oi",
      icon: "https://avatar",
      conteudo: "oculto",
    });
    await vi.waitFor(() => expect(emitNotification).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast).mock.calls.at(-1)![0]).toBe("Maria Souza");
    expect(vi.mocked(emitNotification).mock.calls.at(-1)![0]).toMatchObject({ title: "Novo aviso", body: "", icon: undefined });
  });

  it("modo 'nome': a bandeja mostra o título e o corpo sem prévia, nunca o corpo", async () => {
    entregarAviso({
      category: "mention",
      kind: "mention",
      title: "Você foi mencionado",
      body: "texto da nota",
      conteudo: "nome",
    });
    await vi.waitFor(() => expect(emitNotification).toHaveBeenCalledTimes(1));
    expect(vi.mocked(emitNotification).mock.calls.at(-1)![0]).toMatchObject({ title: "Você foi mencionado", body: "" });
  });

  it("sem opção declarada, pergunta ao servidor e aplica a resposta", async () => {
    const fetchFalso = vi.fn(async () => new Response(JSON.stringify({ data: { conteudo: "nome" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFalso);
    entregarAviso({
      category: "lead_assigned",
      kind: "lead_assigned",
      title: "Lead atribuído a você",
      body: "Carlos",
      corpoSemPrevia: "Carlos",
    });
    await vi.waitFor(() => expect(emitNotification).toHaveBeenCalledTimes(1));
    expect(fetchFalso).toHaveBeenCalledWith("/api/v1/notifications/push", expect.anything());
    expect(vi.mocked(emitNotification).mock.calls.at(-1)![0]).toMatchObject({ title: "Lead atribuído a você", body: "Carlos" });
  });

  it.each([
    ["servidor fora", async () => Promise.reject(new Error("rede"))],
    ["resposta sem a opção", async () => new Response(JSON.stringify({ data: {} }), { status: 200 })],
    ["opção desconhecida", async () => new Response(JSON.stringify({ data: { conteudo: "tudo" } }), { status: 200 })],
  ])("sem opção válida (%s), a bandeja sai neutra", async (_caso, resposta) => {
    vi.stubGlobal("fetch", vi.fn(resposta));
    entregarAviso({ category: "call_inbound", kind: "call_inbound", title: "Ligação recebida", body: "Ana · 11 99999-0000" });
    await vi.waitFor(() => expect(emitNotification).toHaveBeenCalledTimes(1));
    expect(vi.mocked(emitNotification).mock.calls.at(-1)![0]).toMatchObject({ title: "Novo aviso", body: "" });
  });
});
