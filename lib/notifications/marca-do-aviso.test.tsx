/**
 * O aviso de mensagem nova identificando o canal (#4094, saída 2).
 *
 * O que se prova aqui é o OBJETO que chega ao `sonner`: qual ícone, qual faixa,
 * e — o mais importante — que o toast genérico (lead, menção, exportação)
 * continua sem nada disso. O canal também aparece em TEXTO (`sr-only`), porque
 * cor sozinha não serve a quem é daltônico nem a leitor de tela.
 */
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("./emit", () => ({ emitNotification: vi.fn() }));

import { toast } from "sonner";

import { entregarAviso } from "./deliver";
import { MarcaDoCanal, aderecosDoAviso } from "./marca-do-aviso";

const CANAL_SEM_ICONE = "var(--color-text-muted)";

function opcoesDoUltimoToast(): {
  icon?: ReactElement;
  style?: { borderLeft?: string };
  description?: string;
  action?: { label: string };
} {
  const chamada = vi.mocked(toast).mock.calls.at(-1);
  if (!chamada) throw new Error("nenhum toast foi entregue");
  return chamada[1] as unknown as ReturnType<typeof opcoesDoUltimoToast>;
}

function avisoDeMensagem(canal?: string): void {
  entregarAviso({
    category: "message",
    kind: "message_inbound",
    title: "Maria Souza",
    body: "oi",
    tag: "conv-1",
    href: "/app/inbox?id=conv-1",
    ...(canal === undefined ? {} : { canal }),
  });
}

describe("entregarAviso com canal", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("sem servidor no teste"))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("WhatsApp: faixa verde e ícone da rede no toast", () => {
    avisoDeMensagem("whatsapp");

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.style?.borderLeft).toBe("3px solid var(--color-canal-whatsapp)");
    expect(opcoes.icon, "o aviso não carrega marca nenhuma").toBeDefined();
    // O que o leitor de tela lê — em texto, não em cor.
    expect(renderToStaticMarkup(opcoes.icon as ReactElement)).toContain("Canal: WhatsApp");
  });

  it("Telegram: faixa azul e nome da rede em texto", () => {
    avisoDeMensagem("telegram");

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.style?.borderLeft).toBe("3px solid var(--color-canal-telegram)");
    expect(renderToStaticMarkup(opcoes.icon as ReactElement)).toContain("Canal: Telegram");
  });

  it("canal desconhecido não quebra o aviso: faixa neutra e nenhum logo inventado", () => {
    expect(() => avisoDeMensagem("orkut")).not.toThrow();

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.style?.borderLeft).toBe(`3px solid ${CANAL_SEM_ICONE}`);
    const html = renderToStaticMarkup(opcoes.icon as ReactElement);
    expect(html).not.toContain("<svg");
    expect(html).toContain("Canal");
    // O aviso continua levando para a conversa.
    expect(opcoes.action?.label).toBe("Abrir conversa");
  });

  it("aviso SEM canal declarado sai idêntico ao de antes (lead, menção, exportação)", () => {
    entregarAviso({
      category: "lead_assigned",
      kind: "lead_assigned",
      title: "Lead atribuído",
      body: "Carlos",
    });

    const opcoes = opcoesDoUltimoToast();
    expect(opcoes.icon).toBeUndefined();
    expect(opcoes.style).toBeUndefined();
  });
});

describe("aderecosDoAviso", () => {
  it("é `null` sem canal — quem não declara não ganha marca", () => {
    expect(aderecosDoAviso(undefined)).toBeNull();
    expect(aderecosDoAviso(null)).toBeNull();
  });

  it("com canal, devolve ícone e faixa do token da rede", () => {
    expect(aderecosDoAviso("whatsapp")).toEqual({
      icon: createElement(MarcaDoCanal, { canal: "whatsapp" }),
      style: { borderLeft: "3px solid var(--color-canal-whatsapp)" },
    });
  });
});

describe("MarcaDoCanal", () => {
  it("o nome do canal vai em TEXTO escondido, e o ícone fica fora da árvore acessível", () => {
    const html = renderToStaticMarkup(createElement(MarcaDoCanal, { canal: "instagram" }));
    expect(html).toContain("Canal: Instagram");
    expect(html).toMatch(/sr-only[^>]*>Canal: Instagram</);
    expect(html).toContain('aria-hidden="true"');
  });
});
