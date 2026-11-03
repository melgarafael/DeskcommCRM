/**
 * A CASCA DAS TELAS DE ACESSO FALA O IDIOMA DO VISITANTE.
 *
 * As páginas do grupo `(public)` resolvem o idioma por `idiomaDoVisitante`: o do perfil, se há sessão; sem ela, o do
 * navegador (Accept-Language). A casca (`app/(public)/layout.tsx`), que entrega o idioma aos componentes do CLIENTE
 * pelo `IdiomaProvider`, olhava só o perfil — e sem sessão caía no padrão pt-BR do provider. Quem chegava ao cadastro
 * com o navegador em espanhol via o título e o rodapé em espanhol (servidor) e o formulário inteiro em português
 * (cliente): « Senha », « Força da senha », « Criar conta », « Entrar com Google ». O mesmo no login e na recuperação de
 * senha. Agora a casca chama a mesma função.
 *
 * Mede o HTML de verdade: renderiza a casca (Server Component async, por isso `renderToStaticMarkup`, como em
 * `marca-na-fachada-de-acesso`) com um componente de cliente dentro que traduz pelo provider.
 */
import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ aceita: null as string | null, perfil: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.aceita ? { "accept-language": h.aceita } : {}),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: h.perfil ? { id: "u1", user_metadata: { locale: h.perfil } } : null },
      })),
    },
  })),
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({
    nome: "Vendas Turbo", logoUrl: null, accent: "#2f6f4e", accentFg: "#ffffff", origens: { nome: "banco", cor: "banco" },
  })),
}));

import { traduzir } from "@/lib/i18n/dicionario";

async function fachada(): Promise<string> {
  // O useT vem DEPOIS do resetModules, do mesmo grafo da casca: importado no topo, ele leria o contexto de OUTRA
  // instância do IdiomaProvider e devolveria sempre o padrão — um vermelho que é do teste, não da casca.
  const { useT } = await import("@/hooks/i18n/useT");
  /** O que um formulário do cliente faz: traduz pelo provider da casca. */
  function Sonda() {
    const t = useT();
    return <span data-sonda="1">{t("Criar conta")}</span>;
  }
  const { default: PublicLayout } = await import("@/app/(public)/layout");
  const html = renderToStaticMarkup(await PublicLayout({ children: <Sonda /> }));
  const achado = html.match(/<span data-sonda="1">([^<]*)<\/span>/);
  if (!achado) throw new Error("a sonda não renderizou dentro da casca");
  return achado[1] ?? "";
}

describe("a casca das telas de acesso segue o idioma do visitante", () => {
  beforeEach(() => {
    vi.resetModules();
    h.aceita = null;
    h.perfil = null;
  });

  it("sem sessão, navegador em espanhol: o formulário em espanhol", async () => {
    h.aceita = "es-ES,es;q=0.9";
    expect(await fachada()).toBe(traduzir("Criar conta", "es"));
    expect(traduzir("Criar conta", "es")).not.toBe("Criar conta");
  });

  it("sem sessão e sem cabeçalho: o padrão desta instalação, espanhol (não mais pt-BR do upstream)", async () => {
    expect(await fachada()).toBe(traduzir("Criar conta", "es"));
  });

  it("com sessão, o perfil vence o navegador", async () => {
    h.perfil = "pt-BR";
    h.aceita = "es-ES";
    expect(await fachada()).toBe("Criar conta");
  });

  it("a casca e as páginas resolvem o idioma pela mesma função", () => {
    for (const arquivo of ["app/(public)/layout.tsx", "app/(public)/signup/page.tsx", "app/(public)/login/page.tsx"]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toMatch(/await idiomaDoVisitante\(/);
    }
  });
});
