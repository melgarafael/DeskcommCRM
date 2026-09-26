/**
 * A TELA DE /admin/cadastro CONTA QUANDO A TROCA AINDA NÃO CHEGOU AO GOTRUE.
 *
 * Issue #1668 (seguimento do #1665, já mergeado): o kit só leva
 * `signup_mode` ao GoTrue da VPS no `install`/`update.sh`. Quem troca o modo
 * depois de instalado vê o CRM mudar na hora e o cadastro DIRETO
 * (`POST /auth/v1/signup`, com a anon key) ficando como estava até a próxima
 * atualização. A regra do `agent.sh` da VPS é avisar, não corrigir — então o
 * produto avisa, e é isto que este arquivo guarda, pela TELA (o defeito era do
 * que a tela mostrava, não de uma função solta):
 *
 *   1. banco ≠ GoTrue → aviso, com a frase da issue e o comando para aplicar;
 *   2. banco = GoTrue → NENHUM aviso (uma troca `aberto ↔ com_aprovacao` não
 *      muda o GoTrue e ninguém precisa ouvir falar de atualização);
 *   3. settings ilegíveis (rede fora, HTTP 500, corpo sem `disable_signup`) →
 *      NENHUM aviso: "não sei" não é "divergente", e um aviso falso ensina a
 *      gente a ignorar o aviso verdadeiro;
 *   4. abrir a tela com a divergência não CORRIGE nada — a garantia de "só
 *      aviso" do agent.sh, aqui no produto.
 *
 * A leitura é a de `GET /auth/v1/settings` mesmo (`lerConfigPublicaDoGoTrue`,
 * do #1653), stubada no `fetch` daqui: o que se testa é a tela inteira, do
 * banco ao banner.
 */
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** O que a cena devolve: modo do banco × o que o GoTrue responde. */
const cena = vi.hoisted(() => ({
  modo: "aberto" as "aberto" | "com_aprovacao" | "so_convite",
  settings: undefined as unknown,
  redeFora: false,
  http: 200,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("a tela de admin não pode cair em notFound neste teste");
  }),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "usuario-1", is_platform_admin: true, idioma: "pt-BR" })),
}));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({
  modoDeCadastro: vi.fn(async () => cena.modo),
}));
vi.mock("@/lib/auth/registration-requests", () => ({
  listPendingRegistrationRequests: vi.fn(async () => []),
}));
vi.mock("@/app/actions/settings/updateSignupMode", () => ({
  updateSignupMode: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/actions/registration/decide", () => ({
  decideRegistrationRequest: vi.fn(async () => ({ ok: true })),
}));
// Quem chama `lerConfigPublicaDoGoTrue` nunca cria cliente nenhum; os mocks
// existem para o CARREGAMENTO da cadeia não depender de `next/headers`.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { updateSignupMode } from "@/app/actions/settings/updateSignupMode";
import { disableSignupEsperado } from "@/lib/auth/aviso-da-troca-de-modo";

import Page from "@/app/admin/(protected)/cadastro/page";

const TITULO = "A troca de modo ainda não chegou ao servidor.";
const FRASE_DA_ISSUE =
  /A troca só vale para o cadastro direto depois da próxima atualização do servidor/;
const COMANDO = "bash hostgator-setup-kit/update.sh";
const CHAVE_DO_ROTULO = "Quem pode criar uma conta nesta instalação.";

/** Abre a tela e mostra que ela ABRIU — sem isto, "sem aviso" seria verde com a página fora. */
async function abrirTela() {
  render(await Page());
  expect(screen.getByText(CHAVE_DO_ROTULO)).toBeInTheDocument();
}

beforeEach(() => {
  cena.modo = "aberto";
  cena.settings = undefined;
  cena.redeFora = false;
  cena.http = 200;
  // Os casos de cima medem o kit de servidor único, o único em que o
  // `update.sh` leva o modo ao GoTrue; o Supabase separado tem o seu `describe`.
  vi.stubEnv("SINGLE_SERVER", "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (cena.redeFora) throw new Error("rede fora");
      return {
        ok: cena.http >= 200 && cena.http < 300,
        status: cena.http,
        json: async () => cena.settings,
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("o aviso quando o GoTrue não acompanhou a troca", () => {
  it("banco em 'só convite' e cadastro direto aberto no GoTrue → o aviso da issue, com o comando", async () => {
    cena.modo = "so_convite";
    cena.settings = { disable_signup: false };

    await abrirTela();

    expect(screen.getByText(TITULO)).toBeInTheDocument();
    expect(screen.getByText(FRASE_DA_ISSUE)).toBeInTheDocument();
    expect(screen.getByText(COMANDO)).toBeInTheDocument();
  });

  it("banco aberto e cadastro direto FECHADO no GoTrue → também é divergência, e o aviso aparece", async () => {
    cena.modo = "aberto";
    cena.settings = { disable_signup: true };

    await abrirTela();

    expect(screen.getByText(TITULO)).toBeInTheDocument();
  });

  it("banco em 'com_aprovacao' e GoTrue aberto → o modo do kit é o mesmo do 'aberto': sem aviso", async () => {
    cena.modo = "com_aprovacao";
    cena.settings = { disable_signup: false };

    await abrirTela();

    expect(screen.queryByText(TITULO)).toBeNull();
  });

  it("'só convite' com o GoTrue já fechado (kit sincronizou) → sem aviso", async () => {
    cena.modo = "so_convite";
    cena.settings = { disable_signup: true };

    await abrirTela();

    expect(screen.queryByText(TITULO)).toBeNull();
  });

  it("settings ilegíveis (rede fora, HTTP 500, campo ausente) → sem aviso falso, com a tela de pé", async () => {
    const leituras = [
      () => {
        cena.redeFora = true;
      },
      () => {
        cena.http = 500;
        cena.settings = { message: "oops" };
      },
      () => {
        cena.settings = {};
      },
      () => {
        cena.settings = undefined;
      },
    ];

    for (const preparar of leituras) {
      cleanup();
      cena.modo = "so_convite";
      cena.redeFora = false;
      cena.http = 200;
      preparar();

      await abrirTela();

      expect(screen.queryByText(TITULO)).toBeNull();
      expect(screen.queryByText(FRASE_DA_ISSUE)).toBeNull();
    }
  });

  it("o aviso pergunta ao GoTrue pelo endpoint público, e não escreve nada", async () => {
    cena.modo = "so_convite";
    cena.settings = { disable_signup: false };

    await abrirTela();

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "")}/auth/v1/settings`,
    );
    expect(updateSignupMode).not.toHaveBeenCalled();
  });
});

describe("com Supabase separado, o update.sh não leva o modo ao GoTrue", () => {
  const PAINEL = /Authentication → Sign In \/ Up/;

  for (const valor of ["0", undefined]) {
    it(`SINGLE_SERVER=${String(valor)} e 'só convite' com o GoTrue aberto → ensina a DESLIGAR no painel, sem update.sh`, async () => {
      if (valor === undefined) delete process.env.SINGLE_SERVER;
      else vi.stubEnv("SINGLE_SERVER", valor);
      cena.modo = "so_convite";
      cena.settings = { disable_signup: false };

      await abrirTela();

      expect(screen.getByText(TITULO)).toBeInTheDocument();
      expect(screen.getByText(PAINEL).textContent).toMatch(/desligue "Allow new users to sign up"/);
      expect(screen.getByText("DISABLE_SIGNUP=true")).toBeInTheDocument();
      expect(screen.queryByText(COMANDO)).toBeNull();
      expect(document.body.textContent).not.toMatch(/update\.sh/);
    });
  }

  it("'aberto' com o GoTrue fechado → ensina a LIGAR no painel", async () => {
    vi.stubEnv("SINGLE_SERVER", "0");
    cena.modo = "aberto";
    cena.settings = { disable_signup: true };

    await abrirTela();

    expect(screen.getByText(PAINEL).textContent).toMatch(/\bligue "Allow new users to sign up"/);
    expect(screen.getByText("DISABLE_SIGNUP=false")).toBeInTheDocument();
    expect(screen.queryByText(COMANDO)).toBeNull();
  });
});

describe("a régua do aviso é a mesma do kit (#1665)", () => {
  it("só o modo 'so convite' espera disable_signup=true", () => {
    expect(disableSignupEsperado("so_convite")).toBe(true);
    expect(disableSignupEsperado("aberto")).toBe(false);
    expect(disableSignupEsperado("com_aprovacao")).toBe(false);
  });
});
