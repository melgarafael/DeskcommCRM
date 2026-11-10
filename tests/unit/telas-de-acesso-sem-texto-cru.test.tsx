/**
 * AS TELAS DE ACESSO NÃO MOSTRAM TEXTO CRU, E A ABA FALA O IDIOMA DO CORPO.
 *
 * - o cadastro do segundo fator mostrava o `message` do GoTrue — inglês, em todo idioma (« A factor with the friendly
 *   name … already exists »);
 * - a regeneração dos códigos de recuperação mostrava « Erro: mfa_not_enrolled », ou a mensagem crua do banco;
 * - o rótulo « Email » da recuperação por código estava fora de t();
 * - o título da aba das sete telas de acesso era um objeto fixo em português (`metadata = { title: "Entrar" }`).
 *
 * Em português, a tela fica como antes.
 */
import { readFileSync } from "node:fs";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  enrollMfa: vi.fn(),
  confirmMfaEnroll: vi.fn(),
  regenerar: vi.fn(),
  toastErro: vi.fn(),
  aceita: null as string | null,
  locale: null as string | null,
}));
vi.mock("@/app/actions/auth/enrollMfa", () => ({ enrollMfa: m.enrollMfa }));
vi.mock("@/app/actions/auth/confirmMfaEnroll", () => ({ confirmMfaEnroll: m.confirmMfaEnroll }));
vi.mock("@/app/actions/auth/useRecoveryCode", () => ({ useRecoveryCode: vi.fn() }));
vi.mock("@/app/actions/settings/regenerateRecoveryCodes", () => ({ regenerateRecoveryCodes: m.regenerar }));
vi.mock("@/app/actions/settings/signOutEverywhere", () => ({ signOutEverywhere: vi.fn() }));
vi.mock("@/app/actions/auth/politicaDeMfa", () => ({ definirExigenciaDeMfa: vi.fn(), desativarMfaDaConta: vi.fn() }));
vi.mock("@/components/voice/PainelDeChamadaDeVoz", () => ({ PainelDeChamadaDeVoz: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: m.toastErro } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(m.aceita ? { "accept-language": m.aceita } : {}),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: m.locale ? { user_metadata: { locale: m.locale } } : null } }) },
  }),
}));

import { SecurityClient } from "@/app/app/settings/security/_client";
import { MfaEnrollModal } from "@/components/auth/MfaEnrollModal";
import { RecoveryForm } from "@/components/auth/RecoveryForm";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

beforeEach(() => {
  m.enrollMfa.mockReset();
  m.confirmMfaEnroll.mockReset();
  m.regenerar.mockReset();
  m.toastErro.mockReset();
  m.aceita = null;
  m.locale = null;
});
afterEach(() => cleanup());

const noIdioma = (idioma: Idioma, filho: ReactNode) => <IdiomaProvider locale={idioma}>{filho}</IdiomaProvider>;

describe("o cadastro do segundo fator não mostra o texto cru do GoTrue", () => {
  const CRU = 'A factor with the friendly name "Acesso 2026-10-21" for this user already exists';

  it.each([
    ["es", "No se pudo iniciar la configuración."],
    ["pt-BR", "Não foi possível iniciar a configuração."],
  ] as const)("ao começar, em %s", async (idioma, esperado) => {
    m.enrollMfa.mockResolvedValue({ ok: false, error: "enroll_failed", message: CRU });
    render(noIdioma(idioma, <MfaEnrollModal motivo="escolha" />));
    fireEvent.click(screen.getByRole("button", { name: traduzir("Iniciar configuração", idioma) }));
    expect(await screen.findByText(esperado)).toBeTruthy();
    expect(screen.queryByText(/friendly name/)).toBeNull();
  });

  it("a confirmação que falha fora do código errado também fica na frase do produto", async () => {
    m.enrollMfa.mockResolvedValue({ ok: true, factor_id: "f1", qr_data_url: "data:,", uri: "otpauth://x", secret: "ABC" });
    m.confirmMfaEnroll.mockResolvedValue({ ok: false, error: "challenge_failed", message: "MFA challenge failed" });
    render(noIdioma("es", <MfaEnrollModal motivo="escolha" />));
    fireEvent.click(screen.getByRole("button", { name: "Iniciar configuración" }));
    const campos = await screen.findAllByLabelText(/Dígito/);
    campos.forEach((campo, i) => fireEvent.change(campo, { target: { value: String(i + 1) } }));
    expect(await screen.findByText("No se pudo confirmar. Intenta de nuevo.")).toBeTruthy();
    expect(screen.queryByText("MFA challenge failed")).toBeNull();
  });
});

describe("a regeneração dos códigos não mostra o código do erro", () => {
  async function regenera(idioma: Idioma, error: string) {
    m.regenerar.mockResolvedValue({ ok: false, error });
    render(
      noIdioma(
        idioma,
        <SecurityClient mfaEnrolled obrigatorio={false} podeExigirDaEquipe={false} papelMinimo="none" diasDeCarencia={0} dispositivos={[]} />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: traduzir("Regenerar códigos de recuperação", idioma) }));
    const dialogo = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialogo).getByRole("button", { name: traduzir("Confirmar", idioma) }));
    });
    await waitFor(() => expect(m.toastErro).toHaveBeenCalledTimes(1));
    return m.toastErro.mock.calls[0]![0] as string;
  }

  it.each([
    ["es", "mfa_not_enrolled", "Habilita MFA antes de generar códigos."],
    ["es", "unauthenticated", "Tu sesión expiró. Entra de nuevo."],
    ["es", "duplicate key value violates unique constraint", "No pude guardar ese cambio ahora."],
    ["pt-BR", "mfa_not_enrolled", "Habilite MFA antes de gerar códigos."],
    ["pt-BR", "unauthenticated", "Sua sessão expirou. Entre de novo."],
  ] as const)("%s, %s", async (idioma, error, esperado) => {
    expect(await regenera(idioma, error)).toBe(esperado);
  });
});

describe("o rótulo do e-mail da recuperação por código passa por t()", () => {
  it.each([
    ["es", "Correo"],
    ["pt-BR", "Email"],
  ] as const)("%s", (idioma, esperado) => {
    render(noIdioma(idioma, <RecoveryForm />));
    expect(screen.getByText(esperado, { selector: "label" })).toBeTruthy();
  });
});

describe("o título da aba das telas de acesso segue o idioma do corpo", () => {
  const PAGINAS: Array<[string, string]> = [
    ["app/(public)/login/page.tsx", "Entrar"],
    ["app/(public)/login/continuar/page.tsx", "Confirmar acesso"],
    ["app/(public)/login/forgot/page.tsx", "Recuperar senha"],
    ["app/(public)/login/mfa/page.tsx", "Verificação em duas etapas"],
    ["app/(public)/login/recovery/page.tsx", "Recuperar acesso"],
    ["app/(public)/login/reset/page.tsx", "Nova senha"],
    ["app/(public)/signup/page.tsx", "Criar conta"],
  ];

  it.each(PAGINAS)("%s declara o título pelo idioma do visitante", (arquivo, titulo) => {
    const src = readFileSync(arquivo, "utf8");
    expect(src).not.toMatch(/export const metadata\b/);
    // O literal mora na página, onde a cerca `i18n-espanhol-cobre-a-tela` o vê.
    expect(src).toContain(`export const generateMetadata = () => tituloDaTelaPublica((t) => t(${JSON.stringify(titulo)}));`);
    expect(DICIONARIO[titulo]?.es, titulo).toBeTruthy();
  });

  it.each([
    ["navegador em espanhol, sem sessão", "es-ES,es;q=0.9", null, "Crear cuenta"],
    ["navegador em português, perfil em espanhol", "pt-BR,pt;q=0.9", "es", "Crear cuenta"],
    ["navegador em português, sem sessão", "pt-BR,pt;q=0.9", null, "Criar conta"],
    ["nada", null, null, "Criar conta"],
  ])("%s: « %s »", async (_rotulo, aceita, locale, esperado) => {
    m.aceita = aceita;
    m.locale = locale;
    vi.resetModules();
    const { tituloDaTelaPublica } = await import("@/lib/i18n/titulo-da-tela-publica");
    expect((await tituloDaTelaPublica((t) => t("Criar conta"))).title).toBe(esperado);
  });
});
