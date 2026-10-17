/**
 * SEM SMTP, O PAINEL DO ADMIN AVISA — E COM SMTP, NÃO.
 *
 * ─── O defeito (#2755, item 3) ──────────────────────────────────────────────
 *
 * Numa instalação sem SMTP, quem administra só descobria isso lendo o log do
 * `update.sh` — e o log é a última tela que alguém abre. Faltava o sinal
 * PERSISTENTE no painel: em qualquer tela do admin, "esta instalação não manda
 * e-mail", com a porta da remediação (`/admin/email`).
 *
 * ─── O que se guarda ────────────────────────────────────────────────────────
 *
 *   - sem SMTP a casca do admin mostra o aviso, e o aviso aponta `/admin/email`;
 *   - COM SMTP (linha da tela, host E remetente) o aviso NÃO aparece — o
 *     CONTROLE, e o defeito simétrico: um aviso exibido a quem já configurou
 *     ensina a ignorá-lo;
 *   - host SEM remetente não é SMTP usável (mesma régua do kit e do #2767);
 *   - o banco que FALHA não vira "sem SMTP": um soluço dele não é falta de
 *     configuração, e o aviso não aparece.
 *
 * O `lerSmtp` roda DE VERDADE — o dublê está no cliente do banco, na forma que
 * ele responde (`{ data, error }`, ou lançando), não na função que decide; é o
 * mesmo recorte de `esqueci-a-senha-sem-smtp-diz-o-motivo.test.ts`.
 *
 * A casca sob teste é a casca de verdade (`AdminShell`), não uma maquete dela:
 * o aviso tem de estar DENTRO do denominador comum a todas as telas de
 * `/admin`, e é isto que o teste mede.
 *
 * Confira com: pnpm vitest run tests/unit/admin-avisa-sem-smtp.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

type LinhaSmtp = {
  smtp_host: string | null;
  smtp_port: number;
  smtp_security: "starttls";
  smtp_username: string | null;
  smtp_password_encrypted: string | null;
  from_email: string | null;
  from_name: string | null;
};
type RespostaBanco =
  | { data: LinhaSmtp | null; error: null }
  | { data: null; error: { message: string } }
  | "lanca";

const LINHA_COM_SMTP: LinhaSmtp = {
  smtp_host: "smtp.revenda.com.br",
  smtp_port: 587,
  smtp_security: "starttls",
  smtp_username: "nao-responda@revenda.com.br",
  smtp_password_encrypted: null,
  from_email: "nao-responda@revenda.com.br",
  from_name: "Revenda",
};

const estado = {
  banco: { data: null, error: null } as RespostaBanco,
  resend: false,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (estado.banco === "lanca") throw new Error("conexão recusada");
            return estado.banco;
          },
        }),
      }),
    }),
  }),
}));
// A Resend é lida por `valorDaInstalacao`, que cai no `env` já parseado na
// importação — `vi.stubEnv` não a alcança. O dublê fica na pergunta "a Resend
// entrega?", e a composição que decide a tarja (`instalacaoSemSmtp`) roda real.
vi.mock("@/lib/email/resend", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isEmailConfigured: async () => estado.resend,
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "",
  encryptWebhookSecret: async () => "",
}));

// O `AdminSidebar` chama `usePathname`; o resto da casca é real (mesmo recorte
// de `admin-shell-tooltip.test.tsx`).
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/inbox" }));

// O `ThemeProvider` lê `matchMedia` para resolver o tema "system", e o jsdom
// não implementa.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia;

import { AdminShell } from "@/components/admin/AdminShell";
import { instalacaoSemSmtp } from "@/lib/email/estado";
import { ThemeProvider } from "@/lib/theme";

/** Monta a casca do admin como o layout faz: a leitura entra ANTES do render. */
async function montarPainelDoAdmin() {
  const semSmtp = await instalacaoSemSmtp();
  render(
    <ThemeProvider>
      <AdminShell userEmail="dono@revenda.test" semSmtp={semSmtp}>
        <p>conteúdo da tela</p>
      </AdminShell>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  estado.banco = { data: null, error: null };
  estado.resend = false;
  // O caso que a #2755 descreve: servidor único, onde o login só recebe o SMTP do CRM.
  vi.stubEnv("SINGLE_SERVER", "1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("painel do admin — o sinal de 'sem SMTP' (#2755, item 3)", () => {
  it("⭐ sem SMTP o aviso aparece e aponta /admin/email", async () => {
    await montarPainelDoAdmin();

    expect(screen.getByRole("status")).toBeInTheDocument();
    const remediacao = screen.getByRole("link", { name: /admin\/email/ });
    expect(remediacao).toHaveAttribute("href", "/admin/email");
  });

  it("⭐ CONTROLE — com SMTP configurado o aviso NÃO aparece", async () => {
    estado.banco = { data: LINHA_COM_SMTP, error: null };

    await montarPainelDoAdmin();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("host SEM remetente não conta como SMTP (mesma régua do kit)", async () => {
    estado.banco = { data: { ...LINHA_COM_SMTP, from_email: null }, error: null };

    await montarPainelDoAdmin();

    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it.each([
    ["devolve erro", { data: null, error: { message: "relation does not exist" } }],
    ["lança", "lanca"],
  ] as const)("o banco que %s NÃO vira 'sem SMTP' — sem aviso", async (_, banco) => {
    estado.banco = banco;

    await montarPainelDoAdmin();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("servidor único com a Resend configurada e sem SMTP MANTÉM a tarja: o login só recebe o SMTP", async () => {
    estado.resend = true;

    await montarPainelDoAdmin();

    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("fora do servidor único COM a Resend, sem tarja: o login tem e-mail próprio e o resto sai pela Resend", async () => {
    vi.stubEnv("SINGLE_SERVER", "");
    estado.resend = true;

    await montarPainelDoAdmin();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("⭐ fora do servidor único SEM a Resend e sem SMTP, a tarja APARECE: convites e avisos não saem", async () => {
    vi.stubEnv("SINGLE_SERVER", "");

    await montarPainelDoAdmin();

    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
