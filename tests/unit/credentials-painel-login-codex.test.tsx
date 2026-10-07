/**
 * O PAINEL DE LOGIN DO CODEX MUDA DE LUGAR — e a conta vira DA EMPRESA.
 *
 * A decisão do mantenedor (PR #1672) em três linhas testáveis: o interruptor
 * continua em `/admin/sistema` (instalação), o painel de conexão vai para
 * Credenciais (empresa), e lá ele só aparece com o módulo `login_codex`
 * ligado. O texto que diz "cada empresa conecta a própria conta" também é
 * frases de tela que ninguém reescreve num refactor de layout sem este teste
 * ficar vermelho.
 *
 * Sabotagem que confirma que a guarda vigia: tirar `moduloLigado` da página de
 * Credenciais deixa o caso do módulo vermelho; devolver o painel para
 * `/admin/sistema` deixa o caso da saída vermelho.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PainelDeLoginCodex } from "@/app/app/ai/credentials/_components/PainelDeLoginCodex";

const conectar = vi.hoisted(() => vi.fn(async (_entrada: unknown) => ({ ok: true } as const)));
const desconectar = vi.hoisted(() => vi.fn(async () => ({ ok: true } as const)));

vi.mock("@/app/actions/settings/conectarLoginCodex", () => ({
  conectarLoginCodex: conectar,
  desconectarLoginCodexAgora: desconectar,
}));

describe("o painel de conexão da empresa", () => {
  it("mostra o aviso do Codex, o campo de colagem e o estado da conta", () => {
    render(
      <PainelDeLoginCodex url="https://auth.openai.com/oauth/authorize?x=1" codeVerifier={"v".repeat(60)} conectado={false} validada={false} />,
    );
    expect(screen.getByTestId("painel-login-codex")).toBeTruthy();
    expect(screen.getByTestId("aviso-login-codex").textContent).toContain(
      "nada disso é contrato público da OpenAI",
    );
    expect(screen.getByLabelText("Endereço em que o navegador parou")).toBeTruthy();
    expect(screen.getByTestId("estado-login-codex").textContent).toContain(
      "Nenhuma conta conectada nesta empresa ainda.",
    );
    cleanup();
  });

  it("diz que a conta conectada é DA EMPRESA e oferece desconectar", () => {
    render(
      <PainelDeLoginCodex url="u" codeVerifier={"v".repeat(60)} conectado={true} validada={true} />,
    );
    expect(screen.getByTestId("estado-login-codex").textContent).toContain(
      "Conta conectada nesta empresa",
    );
    expect(screen.getByRole("button", { name: "Desconectar" })).toBeTruthy();
    cleanup();
  });

  it("conecta com o código colado e desconecta pela mesma ação da empresa", async () => {
    render(
      <PainelDeLoginCodex url="u" codeVerifier={"v".repeat(60)} conectado={true} validada={true} />,
    );
    await userEvent.type(screen.getByLabelText("Endereço em que o navegador parou"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "Conectar" }));
    await vi.waitFor(() => expect(conectar).toHaveBeenCalled());
    const chamada = conectar.mock.calls[0]![0] as { codeVerifier: string };
    expect(chamada.codeVerifier).toHaveLength(60);

    await userEvent.click(screen.getByRole("button", { name: "Desconectar" }));
    await vi.waitFor(() => expect(desconectar).toHaveBeenCalled());
    cleanup();
  });
});

describe("onde o painel e o interruptor moram (#1672, itens 1 e 6)", () => {
  const admin = readFileSync("app/admin/(protected)/sistema/page.tsx", "utf8");
  const creds = readFileSync("app/app/ai/credentials/page.tsx", "utf8");
  const form = readFileSync("app/admin/(protected)/sistema/_form.tsx", "utf8");

  it("o interruptor do módulo continua em /admin/sistema", () => {
    expect(form).toContain('modulo: "login_codex"');
    expect(form).toContain("cada empresa vê em Credenciais o painel");
  });

  it("o painel SAIU de /admin/sistema", () => {
    expect(admin).not.toContain("PainelDeLoginCodex");
    expect(admin).not.toContain("criarSessaoPkce");
  });

  it("o painel ENTROU em Credenciais, atrás do módulo da instalação", () => {
    expect(creds).toContain("PainelDeLoginCodex");
    expect(creds).toContain('moduloLigado(createAdminClient(), "login_codex")');
    // A linha do login não é chave: some da lista de chaves e vai ao painel.
    expect(creds).toContain("PROVEDOR_POR_ASSINATURA");
  });
});
