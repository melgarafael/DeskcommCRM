// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { AjudaConteudo } from "@/app/app/ajuda/_client";
import { ajudaDoPapel, AJUDA_POR_PAPEL } from "@/lib/ajuda/papel";
import { PAPEIS_HUMANOS, ROLE_RANK, type Role } from "@/lib/auth/types";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { NAV_CATALOG, type NavMetadata } from "@/lib/navigation/catalogo";

/**
 * O QUE ESTE TESTE PROVA, e por que ele não é "o texto está na tela".
 *
 * A Ajuda por papel afirma coisas sobre permissão ("o seu papel pode abrir
 * isto", "este papel não abre aquilo"). Texto de permissão que ninguém confere
 * envelhece em silêncio: o `minRole` do catálogo muda e a frase continua
 * prometendo a tela que sumiu. Por isso cada item carrega o `href` da tela, e
 * aqui ele é medido contra o catálogo. O vínculo é pelo `href`, não por número
 * de linha: linha fixa do catálogo envelhece a cada tela nova.
 */

const authRef: {
  user: Pick<AuthUser, "is_platform_admin" | "support" | "idioma">;
  activeOrg: ActiveOrg | null;
} = { user: { is_platform_admin: false, idioma: "pt-BR" }, activeOrg: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef }));

beforeEach(() => {
  authRef.user = { is_platform_admin: false, idioma: "pt-BR" };
  authRef.activeOrg = { orgId: "org-a", name: "Organização sintética", role: "manager" };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rank = (papel: string) => ROLE_RANK[papel as Role] ?? 0;
// `NAV_CATALOG` é `as const`: metade das entradas não declara `minRole`. A
// leitura tipada da interface é a mesma que o menu usa (`NavMetadata`), e
// `minRole` ausente vale `viewer` — igual ao resolvedor do catálogo.
const noCatalogo = (href: string): NavMetadata | undefined =>
  (NAV_CATALOG as readonly NavMetadata[]).find((d) => d.href === href);
const temEspanhol = (texto: string) => Boolean(DICIONARIO[texto]?.es);

describe("a ajuda diz o alcance de cada papel", () => {
  it("cobre os quatro papéis humanos e nunca o papel de máquina", () => {
    expect(Object.keys(AJUDA_POR_PAPEL).sort()).toEqual([...PAPEIS_HUMANOS].sort());
    expect(ajudaDoPapel("ai_operator")).toBeNull();
    expect(ajudaDoPapel(null)).toBeNull();
    expect(ajudaDoPapel("papel-que-nao-existe")).toBeNull();
  });

  it("todo poder é uma tela que aquele papel REALMENTE alcança", () => {
    for (const ajuda of Object.values(AJUDA_POR_PAPEL)) {
      for (const item of ajuda.poderes) {
        const destino = noCatalogo(item.href);
        expect(destino, `${ajuda.papel}: ${item.href} fora do catálogo`).toBeTruthy();
        expect(rank(ajuda.papel), `${ajuda.papel} não alcança ${item.href}`)
          .toBeGreaterThanOrEqual(rank(destino!.minRole ?? "viewer"));
      }
    }
  });

  it("todo limite é uma tela que aquele papel NÃO alcança", () => {
    for (const ajuda of Object.values(AJUDA_POR_PAPEL)) {
      for (const item of ajuda.limites) {
        const destino = noCatalogo(item.href);
        expect(destino, `${ajuda.papel}: ${item.href} fora do catálogo`).toBeTruthy();
        expect(rank(ajuda.papel), `${ajuda.papel} alcança ${item.href}, que ele diz não abrir`)
          .toBeLessThan(rank(destino!.minRole ?? "viewer"));
      }
    }
  });

  it("todo texto novo tem espanhol no dicionário", () => {
    for (const ajuda of Object.values(AJUDA_POR_PAPEL)) {
      expect(temEspanhol(ajuda.resumo), ajuda.resumo).toBe(true);
      for (const item of [...ajuda.poderes, ...ajuda.limites]) {
        expect(temEspanhol(item.texto), item.texto).toBe(true);
      }
    }
    for (const chave of ["O que o seu papel pode fazer", "O que este papel não abre"]) {
      expect(DICIONARIO[chave]?.es, chave).toBeTruthy();
    }
  });
});

describe("o bloco aparece na tela com o papel de quem está olhando", () => {
  it("o gerente vê o agente e as etapas, e não vê os canais", () => {
    render(<AjudaConteudo />);
    expect(screen.getByTestId("ajuda-do-papel")).toBeInTheDocument();
    expect(screen.getByTestId("ajuda-papel--app-ai-agents")).toBeInTheDocument();
    expect(screen.getByTestId("ajuda-papel--app-settings-tenant-pipelines")).toBeInTheDocument();
    expect(screen.getByTestId("ajuda-limite--app-connections")).toBeInTheDocument();
    expect(screen.queryByTestId("ajuda-papel--app-connections")).toBeNull();
  });

  it("porta que a empresa escondeu do menu não vira atalho no bloco, como no índice", () => {
    // O mesmo filtro do índice (`destinosDaInterface`): a empresa deixou só o
    // funil no menu, então o gerente não recebe link para Contatos aqui.
    authRef.activeOrg!.interface_settings = {
      preset: "completa",
      destinos: ["/app/ajuda", "/app/kanban"],
    };
    render(<AjudaConteudo />);
    expect(screen.getByTestId("ajuda-do-papel")).toBeInTheDocument();
    expect(screen.getByTestId("ajuda-papel--app-kanban")).toBeInTheDocument();
    expect(screen.queryByTestId("ajuda-papel--app-contacts")).toBeNull();
  });

  it("a tela não mostra caminho de arquivo do repositório", () => {
    render(<AjudaConteudo />);
    expect(screen.getByTestId("ajuda-do-papel").textContent).not.toMatch(/catalogo\.ts|Fonte/);
  });

  it("o somente-leitura não recebe atalho de configuração", () => {
    authRef.activeOrg = { orgId: "org-a", name: "Org", role: "viewer" };
    render(<AjudaConteudo />);
    expect(screen.getByTestId("ajuda-papel--app-inbox")).toBeInTheDocument();
    expect(screen.queryByTestId("ajuda-papel--app-ai-agents")).toBeNull();
    expect(screen.getByTestId("ajuda-limite--app-ai-agents")).toBeInTheDocument();
  });

  it("o atendente vê os casos da IA e não vê a configuração do agente", () => {
    authRef.activeOrg = { orgId: "org-a", name: "Org", role: "agent" };
    render(<AjudaConteudo />);
    expect(screen.getByTestId("ajuda-papel--app-ai-cases")).toBeInTheDocument();
    expect(screen.queryByTestId("ajuda-papel--app-ai-agents")).toBeNull();
  });

  it("sem papel resolvido — ou com papel de máquina — o bloco não renderiza", () => {
    authRef.activeOrg = null;
    const semVinculo = render(<AjudaConteudo />);
    expect(screen.queryByTestId("ajuda-do-papel")).toBeNull();
    semVinculo.unmount();

    authRef.activeOrg = { orgId: "org-a", name: "Org", role: "ai_operator" as Role };
    render(<AjudaConteudo />);
    expect(screen.queryByTestId("ajuda-do-papel")).toBeNull();
  });
});
