/**
 * A TELA DE /admin/sistema — O AVISO E O CAMPO DE COLAGEM.
 *
 * ─── O defeito que este teste fecha (issue #1639, fatia do login) ──────────
 *
 * O mantenedor condicionou a fatia do login a três frases na tela, com todas
 * as letras: o `client_id` e o `redirect_uri` são do Codex; nada disso é
 * contrato público da OpenAI; o recurso nasce DESLIGADO; e a reserva continua
 * sendo a chave de API da organização. Prosa que ninguém escreveu é o tipo de
 * coisa que some num refactor de layout sem nenhum teste ficar vermelho.
 *
 * E o campo de colagem: o authorize do Codex devolve o navegador para
 * `http://localhost:1455/auth/callback` — endereço da lista branca dele — e o
 * código fica na tela de quem abriu o link. Sem um campo para colar, o fluxo é
 * um beco: a página mostraria um link cujo resultado não tem para onde ir.
 *
 * Sabotagem que confirma que a guarda vigia: trocar o `data-testid` do aviso
 * deixa os casos do aviso vermelhos; apagar o campo de colagem deixa o caso do
 * campo vermelho.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const conectar = vi.hoisted(() => vi.fn(async (_entrada: unknown) => ({ ok: true })));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", is_platform_admin: true, idioma: "pt-BR" }),
}));

// Sem `from`: se a página tentasse ler banco, estouraria aqui.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

vi.mock("@/lib/instalacao/comportamento-servidor", () => ({
  carregarComportamentoDaInstalacao: async () => ({
    orcamento_de_ia: "on",
    exigir_assinatura_no_webhook: false,
    divulgacao_de_pagamento: "inject",
    promessa_semantica: true,
  }),
}));

vi.mock("@/lib/instalacao/modulos", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, modulosLigados: async () => ["login_codex"] };
});

vi.mock("@/lib/recursos-opcionais/estado", () => ({ detectarServidor: async () => ({}) }));

vi.mock("@/app/actions/settings/conectarLoginCodex", () => ({
  conectarLoginCodex: conectar,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import Page from "@/app/admin/(protected)/sistema/page";

afterEach(() => {
  cleanup();
  conectar.mockClear();
});

async function abrirTela() {
  render(await Page());
}

describe("/admin/sistema — o aviso pedido pelo mantenedor", () => {
  it("está inteiro na tela, com as quatro letras", async () => {
    await abrirTela();
    const aviso = screen.getByTestId("aviso-login-codex");
    const texto = aviso.textContent ?? "";

    // client_id e redirect_uri são do Codex...
    expect(texto).toContain("client_id");
    expect(texto).toContain("redirect_uri");
    expect(texto).toContain("localhost:1455/auth/callback");
    expect(texto).toContain("são os do Codex");
    // ...nada disso é contrato público da OpenAI...
    expect(texto).toContain("contrato público da OpenAI");
    // ...o recurso vem desligado por padrão...
    expect(texto).toContain("desligado por padrão");
    // ...e a reserva é a chave de API da organização.
    expect(texto).toContain("chave de API da organização");
  });

  it("o módulo aparece ligado na mesma tela, com o interruptor", async () => {
    await abrirTela();
    const interruptor = screen.getByLabelText("Login do Codex por assinatura");
    expect(interruptor).toBeTruthy();
  });
});

describe("/admin/sistema — o campo de colagem", () => {
  it("mostra o link de authorize do Codex, com state, S256, offline_access e o redirect da lista branca", async () => {
    await abrirTela();
    const link = screen.getByLabelText("Link de acesso") as HTMLInputElement;
    expect(link).toBeTruthy();

    const url = new URL(link.value);
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it("cola o código e manda para a action, com o verifier do link mostrado", async () => {
    await abrirTela();
    const campo = screen.getByLabelText("Código que o navegador deixou");
    const botao = screen.getByRole("button", { name: "Conectar" });

    expect(campo).toBeTruthy();
    // Nasce desabilitado: colar é o primeiro passo, não o último.
    expect((botao as HTMLButtonElement).disabled).toBe(true);

    const usuario = userEvent.setup();
    await usuario.type(campo, "codigo_que_o_navegador_deixou");
    await usuario.click(botao);

    await waitFor(() => expect(conectar).toHaveBeenCalledTimes(1));
    const chamada = conectar.mock.calls[0] as unknown as [{ codigo: string; codeVerifier: string }];
    const entrada = chamada[0];
    expect(entrada.codigo).toBe("codigo_que_o_navegador_deixou");
    expect(entrada.codeVerifier.length).toBeGreaterThanOrEqual(43);

    // A confirmação aparece na própria tela — sem ela, um beco sem fundo.
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("guardado com cifra");
  });
});
