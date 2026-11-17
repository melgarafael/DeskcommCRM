/**
 * A COR DO AVISO VEM DO CANAL — e some quando a empresa desliga (#4094).
 *
 * Cinco perguntas, uma por caso, porque cada uma já quebrou de um jeito
 * diferente em algum produto:
 *
 *   (a) WhatsApp pinta a cor do WhatsApp;
 *   (b) Telegram pinta a dele (o exemplo da issue: azul);
 *   (c) canal desconhecido NÃO inventa cor de marca — cai no neutro;
 *   (d) a preferência da organização desligada volta ao neutro SEM calar o
 *       aviso (o toast continua, com ação e tudo);
 *   (e) a cor nunca é o único sinal: o nome do canal aparece em TEXTO.
 *
 * O objeto que se prova é o que chega ao `sonner` — biblioteca que NÃO muda
 * aqui. Os tokens são lidos do CSS de verdade em
 * `lib/channels/marca-do-canal.test.ts`; este arquivo prova a ponte entre o
 * canal, a preferência e o toast.
 */
import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("./emit", () => ({ emitNotification: vi.fn() }));

import { toast } from "sonner";

import { entregarAviso } from "./deliver";

const NEUTRO = "var(--color-text-muted)";

function opcoesDoUltimoToast(): {
  description?: string;
  icon?: ReactElement;
  style?: { borderLeft?: string };
  action?: { label: string };
} {
  const chamada = vi.mocked(toast).mock.calls.at(-1);
  if (!chamada) throw new Error("nenhum toast foi entregue");
  return chamada[1] as unknown as ReturnType<typeof opcoesDoUltimoToast>;
}

function mensagem(canal: string, extras: { corPorCanal?: boolean } = {}): void {
  entregarAviso({
    category: "message",
    kind: "message_inbound",
    title: "Maria Souza",
    body: "Foto",
    tag: "conv-1",
    href: "/app/inbox?id=conv-1",
    canal,
    ...extras,
  });
}

describe("cor do aviso por canal (#4094)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("sem servidor no teste"))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("WhatsApp: o aviso sai com a cor do canal", () => {
    mensagem("whatsapp");

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.style?.borderLeft).toBe("3px solid var(--color-canal-whatsapp)");
    expect(opcoes.icon).toBeDefined();
  });

  it("Telegram: o aviso sai com a cor dele", () => {
    mensagem("telegram");

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.style?.borderLeft).toBe("3px solid var(--color-canal-telegram)");
    expect(renderToStaticMarkup(opcoes.icon as ReactElement)).toContain("Canal: Telegram");
  });

  it("canal desconhecido cai no neutro", () => {
    expect(() => mensagem("orkut")).not.toThrow();

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.style?.borderLeft).toBe(`3px solid ${NEUTRO}`);
    // Sem logo inventado: o balão errado informa pior que balão nenhum.
    expect(renderToStaticMarkup(opcoes.icon as ReactElement)).not.toContain("<svg");
  });

  it("preferência desligada volta ao neutro sem perder o aviso", () => {
    mensagem("whatsapp", { corPorCanal: false });

    expect(toast).toHaveBeenCalledTimes(1);
    const opcoes = opcoesDoUltimoToast();
    // A faixa deixa de ser a do canal e vira a borda neutra do tema.
    expect(opcoes.style?.borderLeft).toBe(`3px solid ${NEUTRO}`);
    // O aviso continua inteiro: destino, ação e o nome da rede em texto.
    expect(opcoes.action?.label).toBe("Abrir conversa");
    expect(renderToStaticMarkup(opcoes.icon as ReactElement)).toContain("Canal: WhatsApp");
  });

  it("o texto do aviso nomeia o canal, e não só a cor", () => {
    mensagem("whatsapp");

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.description).toBe("WhatsApp · Foto");
  });
});
