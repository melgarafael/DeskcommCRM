/**
 * A TELA DO APP DA META: O TOKEN APARECE UMA VEZ, E NENHUM SEGREDO VAI AO NAVEGADOR.
 *
 * ─── O defeito que esta tela fecha ───────────────────────────────────────────
 *
 * A migration 0257 criou `platform_meta_app` e a server action que a grava, e
 * nenhuma tela as chamava — `git grep updateMetaApp -- app components` devolvia
 * só o próprio arquivo. A tabela só se preenchia por SQL, e a promessa de "token
 * gerado pelo servidor e mostrado uma vez" não tinha onde acontecer.
 *
 * ─── As duas metades, e por que as duas ─────────────────────────────────────
 *
 * 1. O que a PÁGINA (server component) entrega ao formulário. As props de um
 *    client component viajam no payload do RSC, ficam no HTML servido e em
 *    qualquer cache do navegador. Por isso o caso ⭐ não confere "o campo está
 *    vazio na tela" — confere que NENHUM valor secreto, nem cifrado, nem do
 *    `.env`, está nas props, e que a página não decifra nada.
 *
 * 2. O que o FORMULÁRIO faz com a resposta da action: o token recém-gerado
 *    aparece para copiar, e só ali. Uma tela que só dissesse "salvo" repetiria
 *    o beco sem saída que a action existe para evitar.
 *
 * Sabotagem que confirma que a guarda vigia: fazer `page.tsx` passar
 * `linha.app_secret_encrypted` ao formulário deixa o caso ⭐ vermelho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const CIFRA_DO_SEGREDO = "\\x_cifra_do_segredo_da_meta";
const CIFRA_DO_TOKEN = "\\x_cifra_do_token_da_meta";
const SEGREDO_DO_ENV = "segredo-do-env-que-nao-pode-vazar";
const TOKEN_DO_ENV = "token-do-env-que-nao-pode-vazar";
const TOKEN_GERADO = "tOkEn_gerado_pelo_servidor_0123456789abcdef";

let linha: Record<string, string | null> | null = null;
let erroDaLeitura: { code: string; message: string } | null = null;
let usuario: { is_platform_admin: boolean; idioma: "pt-BR" } | null = null;

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => usuario }));

vi.mock("@/lib/supabase/admin", () => ({
  // Sem `rpc`: se a página tentasse decifrar alguma coisa, estouraria aqui.
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: linha, error: erroDaLeitura }) }),
      }),
    }),
  }),
}));

const decifrar = vi.fn();
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: (...a: unknown[]) => decifrar(...a) }));

const updateMetaApp = vi.fn();
const rotacionarVerifyTokenDaMeta = vi.fn();
vi.mock("@/app/actions/settings/updateMetaApp", () => ({
  updateMetaApp: (...a: unknown[]) => updateMetaApp(...a),
  rotacionarVerifyTokenDaMeta: (...a: unknown[]) => rotacionarVerifyTokenDaMeta(...a),
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const toastErro = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (m: string) => toastErro(m) } }));

const copiar = vi.fn(async (_valor: string) => true);
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: (v: string) => copiar(v) }));

import Page from "@/app/admin/(protected)/meta/page";
import { FormularioDaMeta } from "@/app/admin/(protected)/meta/_form";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  usuario = { is_platform_admin: true, idioma: "pt-BR" };
  linha = null;
  erroDaLeitura = null;
  process.env.META_APP_SECRET = SEGREDO_DO_ENV;
  process.env.META_WEBHOOK_VERIFY_TOKEN = TOKEN_DO_ENV;
  decifrar.mockReset();
  updateMetaApp.mockReset();
  rotacionarVerifyTokenDaMeta.mockReset();
  refresh.mockReset();
  toastErro.mockReset();
  copiar.mockClear();
});

afterEach(() => {
  cleanup();
  process.env = { ...ORIGINAL };
});

type Props = Parameters<typeof FormularioDaMeta>[0];

async function propsDaPagina(): Promise<Props> {
  const elemento = (await Page()) as { type: unknown; props: Props };
  expect(elemento.type).toBe(FormularioDaMeta);
  return elemento.props;
}

describe("/admin/meta — o que a página entrega ao navegador", () => {
  it("⭐ com tudo configurado, nenhum segredo atravessa — nem cifrado, nem o do .env", async () => {
    linha = {
      app_secret_encrypted: CIFRA_DO_SEGREDO,
      verify_token_encrypted: CIFRA_DO_TOKEN,
      verify_token_created_at: "2026-09-15T13:00:00.000Z",
      updated_at: "2026-09-15T13:00:00.000Z",
    };

    const props = await propsDaPagina();
    const payload = JSON.stringify(props);

    for (const segredo of [CIFRA_DO_SEGREDO, CIFRA_DO_TOKEN, SEGREDO_DO_ENV, TOKEN_DO_ENV]) {
      expect(payload, `a página entregou ${segredo} ao navegador`).not.toContain(segredo);
    }
    // O que atravessa: SE existe, e QUANDO. Nada que abra o que existe.
    expect(props).toMatchObject({
      temSegredoSalvo: true,
      temTokenSalvo: true,
      temNoAmbiente: true,
      leituraFalhou: false,
    });
    expect(props.tokenGeradoEm).toBe("15/09/2026, 10:00");
    expect(decifrar).not.toHaveBeenCalled();
  });

  it("instalação que nunca configurou: tudo falso, e o .env aparece como reserva", async () => {
    const props = await propsDaPagina();

    expect(props).toMatchObject({
      temSegredoSalvo: false,
      temTokenSalvo: false,
      tokenGeradoEm: null,
      atualizadoEm: null,
      temNoAmbiente: true,
      leituraFalhou: false,
    });
  });

  it("leitura que falha não vira 'nunca configurado' sem aviso", async () => {
    erroDaLeitura = { code: "42P01", message: 'relation "platform_meta_app" does not exist' };

    expect((await propsDaPagina()).leituraFalhou).toBe(true);
  });

  it("quem não administra a instalação não enxerga a tela", async () => {
    usuario = { is_platform_admin: false, idioma: "pt-BR" };

    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

const NADA_CONFIGURADO: Props = {
  temSegredoSalvo: false,
  temTokenSalvo: false,
  tokenGeradoEm: null,
  atualizadoEm: null,
  temNoAmbiente: false,
  leituraFalhou: false,
};

const TUDO_CONFIGURADO: Props = {
  ...NADA_CONFIGURADO,
  temSegredoSalvo: true,
  temTokenSalvo: true,
  tokenGeradoEm: "15/09/2026, 10:00",
  atualizadoEm: "15/09/2026, 10:00",
};

describe("/admin/meta — o formulário", () => {
  it("sem nada configurado: pede a chave, explica que o token nasce sozinho e não oferece rotação", async () => {
    render(<FormularioDaMeta {...NADA_CONFIGURADO} />);

    expect(screen.getByTestId("meta-token-estado").textContent).toMatch(/Ainda não existe/);
    expect(screen.queryByTestId("meta-gerar-token")).toBeNull();
    expect(screen.queryByTestId("meta-token-gerado")).toBeNull();

    const salvar = screen.getByTestId("meta-salvar") as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Chave secreta do aplicativo"), "curta");
    expect(salvar.disabled).toBe(true);
  });

  it("configurado: diz que existe e quando nasceu, sem mostrar valor nenhum", () => {
    render(<FormularioDaMeta {...TUDO_CONFIGURADO} />);

    expect(screen.getByLabelText("Chave secreta do aplicativo").getAttribute("placeholder")).toMatch(
      /já cadastrada/,
    );
    expect(screen.getByTestId("meta-token-estado").textContent).toBe("Gerado em 15/09/2026, 10:00.");
    expect(screen.getByTestId("meta-gerar-token").textContent).toBe("Gerar novo token");
    expect(screen.queryByTestId("meta-token-gerado")).toBeNull();
  });

  it("⭐ o primeiro save mostra o token que o servidor gerou, pronto para copiar — sem ler nada de volta", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    updateMetaApp.mockResolvedValue({ ok: true, verifyToken: TOKEN_GERADO });
    render(<FormularioDaMeta {...NADA_CONFIGURADO} />);

    await userEvent.type(
      screen.getByLabelText("Chave secreta do aplicativo"),
      "0123456789abcdef0123456789abcdef",
    );
    await userEvent.click(screen.getByTestId("meta-salvar"));

    const campo = (await screen.findByTestId("meta-token-gerado")) as HTMLInputElement;
    expect(campo.value).toBe(TOKEN_GERADO);
    expect(updateMetaApp).toHaveBeenCalledWith({ app_secret: "0123456789abcdef0123456789abcdef" });
    expect(screen.getByText("Copie agora.")).toBeTruthy();

    await userEvent.click(screen.getByTestId("meta-copiar-token"));
    expect(copiar).toHaveBeenCalledWith(TOKEN_GERADO);

    // A URL de callback mora em Conexões. Na mesma aba, ir buscá-la apagaria o
    // token desta página — que não tem como ser lido de novo.
    expect(screen.getByTestId("meta-abrir-conexoes").getAttribute("target")).toBe("_blank");

    // O token veio da resposta da action, e só dela: a tela não buscou nada.
    expect(fetch).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("gerar novo token pede confirmação com o efeito, e só então roda", async () => {
    rotacionarVerifyTokenDaMeta.mockResolvedValue({ ok: true, verifyToken: TOKEN_GERADO });
    render(<FormularioDaMeta {...TUDO_CONFIGURADO} />);

    await userEvent.click(screen.getByTestId("meta-gerar-token"));

    expect(await screen.findByText(/O token atual deixa de valer na hora/)).toBeTruthy();
    expect(rotacionarVerifyTokenDaMeta).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("meta-confirmar-novo-token"));

    await waitFor(() => expect(rotacionarVerifyTokenDaMeta).toHaveBeenCalledTimes(1));
    expect(((await screen.findByTestId("meta-token-gerado")) as HTMLInputElement).value).toBe(TOKEN_GERADO);
  });

  it("recusa da action vira frase para leigo, e nenhum token aparece", async () => {
    updateMetaApp.mockResolvedValue({ ok: false, error: "invalid_input" });
    render(<FormularioDaMeta {...NADA_CONFIGURADO} />);

    await userEvent.type(screen.getByLabelText("Chave secreta do aplicativo"), "0123456789abcdef-x");
    await userEvent.click(screen.getByTestId("meta-salvar"));

    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(expect.stringMatching(/32 caracteres/)));
    expect(screen.queryByTestId("meta-token-gerado")).toBeNull();
  });
});
