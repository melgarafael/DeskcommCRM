/**
 * A PRÉVIA ESCURA E O "REMOVER LOGO ESCURO" DA MARCA DA ORGANIZAÇÃO USAM O LOGO
 * ESCURO GRAVADO.
 *
 * Com os dois logos da organização salvos, a camada da organização que o
 * formulário monta recebia o `logo_path` mas não o `logo_dark_path`. Como um
 * logo próprio encerra a herança do par (`resolverMarca`), a prévia "Aparência
 * escura" caía no logo claro e "Remover logo escuro" sumia — enquanto a barra
 * lateral, que resolve a pilha completa, mostrava o escuro certo. O formulário
 * da instalação (`/admin/marca`) nunca teve o problema porque passa os dois.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/settings/updateMarcaDaOrganizacao", () => ({
  updateMarcaDaOrganizacao: vi.fn(),
}));

import { FormularioDaMarcaDaOrganizacao } from "@/app/app/settings/marca/_form";
import { urlPublicaDoLogo } from "@/lib/branding/logo";

const BASE = "https://proj.supabase.co";
const CLARO = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png";
const ESCURO = "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.png";

const urlClara = urlPublicaDoLogo(CLARO, BASE);
const urlEscura = urlPublicaDoLogo(ESCURO, BASE);

function imagem(tema: "claro" | "escuro"): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>(`[data-previa-do-logo='${tema}'] img`);
}

function pintar(gravada: { logo_path: string | null; logo_dark_path: string | null }) {
  return render(
    <FormularioDaMarcaDaOrganizacao
      gravada={{
        app_name: null,
        accent_hex: null,
        accent_dark_hex: null,
        email_from_name: null,
        email_reply_to: null,
        ...gravada,
      }}
      instalacao={{
        app_name: null,
        logo_url: null,
        logo_path: null,
        accent_hex: null,
        accent_dark_hex: null,
      }}
      ambiente={{}}
      vocabulario={{ lei: "LGPD", rotuloNomeLegal: "Razão social" }}
    />,
  );
}

describe("marca da organização: a prévia escura usa o logo escuro gravado", () => {
  beforeEach(() => {
    (window as unknown as { __PUBLIC_ENV__?: Record<string, string> }).__PUBLIC_ENV__ = {
      NEXT_PUBLIC_SUPABASE_URL: BASE,
    };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (window as unknown as { __PUBLIC_ENV__?: Record<string, string> }).__PUBLIC_ENV__;
  });

  it("a prévia escura mostra o logo escuro, não o claro", () => {
    pintar({ logo_path: CLARO, logo_dark_path: ESCURO });
    expect(imagem("claro")!.getAttribute("src")).toBe(urlClara);
    expect(imagem("escuro")!.getAttribute("src")).toBe(urlEscura);
    // A arte escura própria dispensa a moldura branca de proteção de contraste.
    expect(imagem("escuro")!.parentElement?.className ?? "").not.toContain("bg-white");
  });

  it("oferece 'Remover logo escuro' quando há logo escuro gravado", () => {
    pintar({ logo_path: CLARO, logo_dark_path: ESCURO });
    expect(screen.getByText("Remover logo escuro")).toBeInTheDocument();
  });

  it("sem logo escuro próprio, a prévia escura segue o logo claro e não há remover", () => {
    pintar({ logo_path: CLARO, logo_dark_path: null });
    expect(imagem("escuro")!.getAttribute("src")).toBe(urlClara);
    expect(screen.queryByText("Remover logo escuro")).toBeNull();
    // Logo único no tema escuro mantém a proteção de contraste do #659.
    expect(imagem("escuro")!.parentElement?.className ?? "").toContain("bg-white");
  });

  it("o botão de remover apaga de fato: some, e a prévia escura volta ao logo claro", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: { logo_url: null } }) });
    vi.stubGlobal("fetch", fetchMock);

    pintar({ logo_path: CLARO, logo_dark_path: ESCURO });
    fireEvent.click(screen.getByRole("button", { name: "Remover logo escuro" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/marca/logo?escopo=organizacao&tema=escuro",
        { method: "DELETE" },
      ),
    );
    await waitFor(() => expect(screen.queryByText("Remover logo escuro")).toBeNull());
    expect(imagem("escuro")!.getAttribute("src")).toBe(urlClara);
  });
});
