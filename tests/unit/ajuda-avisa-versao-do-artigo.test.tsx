// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { AjudaComVersao, AjudaConteudo } from "@/app/app/ajuda/_client";
import type { SystemVersion } from "@/hooks/system/useSystemVersion";

/**
 * A AJUDA NÃO PODE ENSINAR UM CAMINHO QUE A INSTALAÇÃO AINDA NÃO TEM (#3567, F4).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Os artigos do hub falavam para todo mundo. Quem estava na v1.90 lia um artigo
 * escrito para a v1.97 e seguia um caminho que não existia na tela dele — o
 * mesmo "afirmar o que não conferi" que a issue descreve, só que do lado de
 * quem lê. A comparação é a mesma régua da tela de atualização (`semver`), e o
 * aviso é o item marcado com as DUAS versões, não uma frase genérica.
 *
 * ─── O que se guarda, e por quê ─────────────────────────────────────────────
 *
 *  - instalação ANTERIOR ao artigo: aviso visível, com a versão do artigo e a
 *    da instalação — os dois números, porque um aviso sem o número da
 *    instalação não diz a quem lê o quanto está atrás;
 *  - instalação IGUAL: sem aviso. O artigo vale aqui; marcar seria mentir;
 *  - instalação POSTERIOR: sem aviso (o caso de quem atualizou);
 *  - versão INDISPONÍVEL (rota falhou, SHA de desenvolvimento, campo vazio):
 *    sem aviso. Ausência de versão não é prova de atraso — é ausência de prova,
 *    e marcar por isso ensinaria a ignorar a marca.
 *
 * A marca "vale a partir da versão" aparece SEMPRE, com ou sem aviso: é ela que
 * responde "este artigo é da minha versão?" sem ninguém precisar abrir a tela
 * de atualização.
 *
 * Só o contexto de entrada é sintético (`useAuth`), no mesmo recorte de
 * `ajuda-conteudo.test.tsx`. Componente, dicionário e hub são os reais.
 */

const authRef: {
  user: Pick<AuthUser, "is_platform_admin" | "support" | "idioma">;
  activeOrg: ActiveOrg | null;
} = { user: { is_platform_admin: false, idioma: "pt-BR" }, activeOrg: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef }));

/**
 * A rota da versão, dublada no HOOK e não na função que decide: o que se mede
 * aqui é a ligação "rota → tela" (`AjudaComVersao`), e é o formato da resposta
 * que o dublê imita — inclusive o de uma rota que FALHOU.
 */
const rota: { dados: SystemVersion | undefined; erro: boolean } = {
  dados: undefined,
  erro: false,
};
vi.mock("@/hooks/system/useSystemVersion", () => ({
  useSystemVersion: () => ({ data: rota.dados, isError: rota.erro }),
}));

beforeEach(() => {
  authRef.user = { is_platform_admin: false, idioma: "pt-BR" };
  authRef.activeOrg = {
    orgId: "org-a",
    name: "Organização sintética",
    role: "manager",
    interface_settings: {
      preset: "completa",
      destinos: ["/app/inbox", "/app/kanban", "/app/contacts"],
    },
  };
});
afterEach(() => {
  cleanup();
  rota.dados = undefined;
  rota.erro = false;
});

/** O aviso de versão, em qualquer item da lista. */
function avisos() {
  return screen.queryAllByTestId(/^ajuda-aviso-de-versao-/);
}

describe("o artigo de ajuda diz a que versão pertence (#3567, F4)", () => {
  it("⭐ instalação ANTERIOR ao artigo: aparece o aviso, com a versão do artigo e a da instalação", () => {
    render(<AjudaConteudo versaoInstalada="1.90.0" />);

    const aviso = avisos()[0];
    if (!aviso) throw new Error("nenhum item foi marcado: a instalação está atrás do artigo");
    expect(aviso).toHaveTextContent("1.97.0");
    expect(aviso).toHaveTextContent("1.90.0");
    expect(aviso).toHaveAttribute("role", "status");
  });

  it("⭐ instalação IGUAL à do artigo: sem aviso", () => {
    render(<AjudaConteudo versaoInstalada="1.97.0" />);

    expect(avisos()).toEqual([]);
  });

  it("⭐ instalação POSTERIOR à do artigo: sem aviso", () => {
    render(<AjudaConteudo versaoInstalada="1.98.0" />);

    expect(avisos()).toEqual([]);
  });

  it("a marca de versão aparece em todo item, com ou sem aviso", () => {
    render(<AjudaConteudo versaoInstalada="1.98.0" />);

    expect(screen.getAllByText("Vale a partir da versão 1.97.0").length).toBeGreaterThan(0);
  });

  it.each([
    ["indefinida (rota ainda não respondeu)", undefined],
    ["nula (rotina de versão falhou)", null],
    ["ilegível (SHA de instalação fora de release)", "abc1234"],
    ["vazia", ""],
  ])("versão %s não vira aviso falso", (_caso, versao) => {
    render(<AjudaConteudo versaoInstalada={versao} />);

    expect(avisos()).toEqual([]);
  });
});

describe("a tela lê a versão da MESMA rota do rodapé e da tela de atualização", () => {
  it("instalação atrasada: o aviso chega à tela com os dois números", () => {
    rota.dados = { current_version: "v1.90.0", is_owner: false };

    render(<AjudaComVersao />);

    const aviso = avisos()[0];
    if (!aviso) throw new Error("a rota informou 1.90.0 e nenhum artigo foi marcado");
    // O rodapé tira o `v`; a marca também. Um "vv1.90.0" na tela é o tipo de
    // erro que só aparece depois de publicado.
    expect(aviso).toHaveTextContent("1.90.0");
    expect(aviso).not.toHaveTextContent("vv");
  });

  it("⭐ rota que falhou: sem aviso — ausência de versão não é prova de atraso", () => {
    rota.dados = undefined;
    rota.erro = true;

    render(<AjudaComVersao />);

    expect(avisos()).toEqual([]);
    // A marca continua na tela: o artigo segue dizendo de que versão é, mesmo
    // quando a instalação não sabe dizer em que versão está.
    expect(screen.getAllByText("Vale a partir da versão 1.97.0").length).toBeGreaterThan(0);
  });

  it("rota que respondeu com versão vazia também não marca", () => {
    rota.dados = { current_version: "", is_owner: false };

    render(<AjudaComVersao />);

    expect(avisos()).toEqual([]);
  });
});
