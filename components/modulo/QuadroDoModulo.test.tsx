/**
 * O QUADRO DO MÓDULO CONECTADO (spec 33, F4, tarefa 3).
 *
 * O que fica provado: o iframe tem EXATAMENTE o sandbox, a política de referência e o `allow` vazio
 * do contrato, e a URL leva só identificadores; só vale mensagem da origem do serviço E da janela do
 * iframe; o CRM só fala com o módulo para a origem do serviço (nunca "*"); `module:navigate` só abre
 * tela que a pessoa vê; no máximo 1 JWT por 30 s; sem `module:ready` em 10 s aparece o aviso; caminho,
 * idioma e tema novos são reenviados.
 *
 * Não provado aqui: um módulo real, um navegador de verdade (jsdom não aplica o sandbox).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { ModuloNaTela } from "@/lib/extensions/modulos-na-tela";

const { router, auth, tema, caminho } = vi.hoisted(() => ({
  router: { push: vi.fn() },
  auth: {
    value: {
      user: { is_platform_admin: false, support: null },
      activeOrg: {
        orgId: "00000000-0000-4000-8000-000000000001",
        name: "Empresa Exemplo",
        role: "viewer",
        modulos_ligados: [] as string[],
        capacidades_ligadas: [] as string[],
      },
    } as Record<string, unknown>,
  },
  tema: { resolvedTheme: "light" as "light" | "dark" },
  caminho: { valor: "/app/m/equipe-exemplo-modulo" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => caminho.valor,
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => auth.value }));
vi.mock("@/lib/theme", () => ({ useTheme: () => tema }));

import { QuadroDoModulo, enderecoDoQuadro, idDeNavegacao } from "./QuadroDoModulo";

const ORG = "00000000-0000-4000-8000-000000000001";
const INSTALACAO = "00000000-0000-4000-8000-000000000003";
const ORIGEM = "https://modulo.exemplo.test";

const MODULO: ModuloNaTela = {
  slug: "equipe-exemplo-modulo",
  titulo: "Módulo de exemplo",
  icone: "ListChecks",
  serviceOrigin: ORIGEM,
  installationId: INSTALACAO,
};

function montar(locale = "pt-BR") {
  const vista = render(
    <IdiomaProvider locale={locale}>
      <QuadroDoModulo modulo={MODULO} />
    </IdiomaProvider>,
  );
  const iframe = vista.container.querySelector("iframe") as HTMLIFrameElement;
  const janela = iframe.contentWindow as Window;
  const postar = vi.spyOn(janela, "postMessage").mockImplementation(() => {});
  return { ...vista, iframe, janela, postar };
}

/** Entrega ao CRM uma mensagem "vinda" de uma janela e de uma origem. */
function chega(data: unknown, opcoes: { origin?: string; source?: Window | null }) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: opcoes.origin ?? ORIGEM,
        source: opcoes.source ?? null,
      }),
    );
  });
}

function enviadas(postar: ReturnType<typeof vi.spyOn>) {
  return postar.mock.calls.map((c) => ({
    mensagem: JSON.parse(String(c[0])) as Record<string, unknown>,
    alvo: c[1],
  }));
}

beforeEach(() => {
  router.push.mockReset();
  tema.resolvedTheme = "light";
  caminho.valor = "/app/m/equipe-exemplo-modulo";
  (auth.value.activeOrg as Record<string, unknown>).role = "viewer";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("o iframe", () => {
  it("leva exatamente o sandbox, a política de referência e o allow vazio do contrato", () => {
    const { iframe } = montar();
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin",
    );
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("allow")).toBe("");
  });

  it("aponta para o /embed do serviço, com só dois identificadores e nada com poder", () => {
    const { iframe } = montar();
    const url = new URL(iframe.getAttribute("src") ?? "");
    expect(url.origin).toBe(ORIGEM);
    expect(url.pathname).toBe("/embed");
    expect([...url.searchParams.keys()].sort()).toEqual(["installation", "organization"]);
    expect(url.searchParams.get("organization")).toBe(ORG);
    expect(url.searchParams.get("installation")).toBe(INSTALACAO);
    expect(url.toString()).not.toMatch(/jwt|token|secret/i);
    expect(enderecoDoQuadro(ORIGEM, ORG, INSTALACAO)).toBe(url.toString());
  });
});

describe("a conferência de origem", () => {
  it("ignora mensagem de outra origem e de outra janela, mesmo com tipo válido", () => {
    const { janela, postar } = montar();
    chega({ type: "module:ready" }, { origin: "https://outro.test", source: janela });
    chega({ type: "module:ready" }, { origin: ORIGEM, source: window });
    chega({ type: "module:ready" }, { origin: ORIGEM, source: null });
    expect(postar).not.toHaveBeenCalled();
  });

  it("module:ready da origem e da janela certas recebe host:context, sempre com targetOrigin = origem do serviço", () => {
    const { janela, postar } = montar();
    chega({ type: "module:ready" }, { source: janela });
    const [unica] = enviadas(postar);
    expect(postar).toHaveBeenCalledTimes(1);
    expect(unica?.alvo).toBe(ORIGEM);
    expect(unica?.mensagem).toMatchObject({
      type: "host:context",
      path: "/app/m/equipe-exemplo-modulo",
      locale: "pt-BR",
      theme: "light",
      brand: { name: "Empresa Exemplo" },
    });
  });
});

describe("module:navigate", () => {
  it("abre uma tela do catálogo que a pessoa vê", () => {
    const { janela } = montar();
    chega({ type: "module:navigate", destination: "inbox" }, { source: janela });
    expect(router.push).toHaveBeenCalledWith("/app/inbox");
  });

  it("ignora id inexistente, tela de papel maior, endereço no lugar do id e campo extra", () => {
    const { janela } = montar();
    chega({ type: "module:navigate", destination: "nao-existe" }, { source: janela });
    // o papel é viewer: configurar a organização exige admin
    chega({ type: "module:navigate", destination: "settings-tenant" }, { source: janela });
    chega({ type: "module:navigate", destination: "/app/inbox" }, { source: janela });
    chega({ type: "module:navigate", destination: "https://evil.test" }, { source: janela });
    chega({ type: "module:navigate", destination: "inbox", href: "/x" }, { source: janela });
    expect(router.push).not.toHaveBeenCalled();
  });

  it("o mesmo id passa a abrir quando a pessoa ganha o papel", () => {
    (auth.value.activeOrg as Record<string, unknown>).role = "admin";
    const { janela } = montar();
    chega({ type: "module:navigate", destination: "settings-tenant" }, { source: janela });
    expect(router.push).toHaveBeenCalledWith("/app/settings/tenant");
  });

  it("o id de navegação nunca é um endereço", () => {
    expect(idDeNavegacao("/app/settings/tenant")).toBe("settings-tenant");
    expect(idDeNavegacao("/admin")).toBeNull();
    expect(idDeNavegacao("/app")).toBeNull();
  });
});

describe("module:request-jwt", () => {
  function respostaDaRota(status: number, corpo: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(corpo), { status }));
  }

  it("busca o JWT na rota de contexto e o entrega à origem do serviço", async () => {
    const fetchFalso = respostaDaRota(200, {
      data: { jwt: "jwt-de-teste", expires_at: "2026-11-05T12:05:00.000Z" },
    });
    vi.stubGlobal("fetch", fetchFalso);
    const { janela, postar } = montar();
    chega({ type: "module:request-jwt" }, { source: janela });
    await act(async () => {});
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const chamada = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(chamada[0]).toBe(`/api/v1/extensions/${INSTALACAO}/contexto`);
    expect(chamada[1].method).toBe("POST");
    const [saida] = enviadas(postar);
    expect(saida?.alvo).toBe(ORIGEM);
    expect(saida?.mensagem).toEqual({
      type: "host:jwt",
      jwt: "jwt-de-teste",
      expires_at: "2026-11-05T12:05:00.000Z",
    });
  });

  it("no máximo um JWT por 30 s: o seguinte recebe rate_limited e não vai à rede", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchFalso = respostaDaRota(200, {
      data: { jwt: "jwt-de-teste", expires_at: "2026-11-05T12:05:00.000Z" },
    });
    vi.stubGlobal("fetch", fetchFalso);
    const { janela, postar } = montar();
    chega({ type: "module:request-jwt" }, { source: janela });
    await act(async () => {});
    chega({ type: "module:request-jwt" }, { source: janela });
    await act(async () => {});
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(enviadas(postar).map((e) => e.mensagem)).toEqual([
      { type: "host:jwt", jwt: "jwt-de-teste", expires_at: "2026-11-05T12:05:00.000Z" },
      { type: "host:error", code: "rate_limited" },
    ]);

    vi.setSystemTime(Date.now() + 31_000);
    chega({ type: "module:request-jwt" }, { source: janela });
    await act(async () => {});
    expect(fetchFalso).toHaveBeenCalledTimes(2);
  });

  it.each([
    [503, "jwt_unavailable"],
    [404, "not_allowed"],
    [403, "not_allowed"],
    [429, "rate_limited"],
  ])("rota respondeu %i: o módulo recebe host:error %s", async (status, codigo) => {
    vi.stubGlobal(
      "fetch",
      respostaDaRota(status, { error: { code: "x", message: "y" } }),
    );
    const { janela, postar } = montar();
    chega({ type: "module:request-jwt" }, { source: janela });
    await act(async () => {});
    expect(enviadas(postar).map((e) => e.mensagem)).toEqual([{ type: "host:error", code: codigo }]);
  });

  it("falha de rede também vira host:error, sem lançar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("rede caiu");
      }),
    );
    const { janela, postar } = montar();
    chega({ type: "module:request-jwt" }, { source: janela });
    await act(async () => {});
    expect(enviadas(postar).map((e) => e.mensagem)).toEqual([
      { type: "host:error", code: "jwt_unavailable" },
    ]);
  });

  it("pedido vindo de outra origem não chega à rede", async () => {
    const fetchFalso = respostaDaRota(200, { data: { jwt: "x", expires_at: "y" } });
    vi.stubGlobal("fetch", fetchFalso);
    const { janela } = montar();
    chega({ type: "module:request-jwt" }, { origin: "https://outro.test", source: janela });
    await act(async () => {});
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("módulo que não responde", () => {
  it("sem module:ready em 10 s aparece o aviso e o resto da página segue", () => {
    vi.useFakeTimers();
    render(
      <IdiomaProvider locale="pt-BR">
        <p>Resto da página</p>
        <QuadroDoModulo modulo={MODULO} />
      </IdiomaProvider>,
    );
    expect(screen.queryByText("O serviço deste módulo não respondeu")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(screen.queryByText("O serviço deste módulo não respondeu")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("O serviço deste módulo não respondeu")).toBeTruthy();
    expect(screen.getByText("Resto da página")).toBeTruthy();
  });

  it("com module:ready a tempo o aviso não aparece", () => {
    vi.useFakeTimers();
    const { janela } = montar();
    chega({ type: "module:ready" }, { source: janela });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.queryByText("O serviço deste módulo não respondeu")).toBeNull();
  });

  it("o aviso aparece no idioma da pessoa", () => {
    vi.useFakeTimers();
    montar("es");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("El servicio de este módulo no respondió")).toBeTruthy();
  });
});

describe("contexto que muda", () => {
  it("reenvia host:context quando o caminho, o idioma ou o tema mudam (e só depois do pronto)", () => {
    const { janela, postar, rerender } = montar();
    const novo = (locale: string) => (
      <IdiomaProvider locale={locale}>
        <QuadroDoModulo modulo={MODULO} />
      </IdiomaProvider>
    );

    // Antes do module:ready nada é enviado.
    tema.resolvedTheme = "dark";
    rerender(novo("pt-BR"));
    expect(postar).not.toHaveBeenCalled();

    chega({ type: "module:ready" }, { source: janela });
    expect(postar).toHaveBeenCalledTimes(1);

    tema.resolvedTheme = "light";
    rerender(novo("pt-BR"));
    caminho.valor = "/app/m/equipe-exemplo-modulo/outra";
    rerender(novo("pt-BR"));
    rerender(novo("es"));

    const mensagens = enviadas(postar).map((e) => e.mensagem);
    expect(mensagens.length).toBeGreaterThanOrEqual(4);
    expect(mensagens.at(-1)).toMatchObject({
      type: "host:context",
      path: "/app/m/equipe-exemplo-modulo/outra",
      locale: "es",
      theme: "light",
    });
    expect(enviadas(postar).every((e) => e.alvo === ORIGEM)).toBe(true);
  });
});
