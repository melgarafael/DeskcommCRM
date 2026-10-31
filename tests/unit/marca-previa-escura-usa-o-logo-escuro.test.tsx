/**
 * A prévia "Aparência escura" da tela Marca da ORGANIZAÇÃO tem de mostrar o
 * logo escuro salvo — e o campo do logo escuro tem de oferecer "Remover logo
 * escuro" (issue #3793).
 *
 * ── Por que o teste monta o FORMULÁRIO, e não o `CampoDeLogo` sozinho ────────
 *
 * O defeito medido não estava no campo compartilhado: ele recebe `escuraUrl` e
 * desenha a prévia escura com ela (é o que `tests/unit/logo-por-tema.test.tsx`
 * já prova). O que faltava era o chamador — esta tela montava a camada da
 * organização com `logo_path` e SEM `logo_dark_path`, então a resolução nunca
 * dizia "o escuro é desta camada" e a tela se comportava como se a empresa não
 * tivesse logo escuro nenhum.
 *
 * Testar o `CampoDeLogo` com `escuraUrl` na mão passaria nos dois mundos e não
 * vigia nada. O que este arquivo vigia é a LIGAÇÃO: dado o que está gravado em
 * `settings.branding`, a tela chega ao campo com o logo escuro certo.
 *
 * ── O que conta como comportamento observável ───────────────────────────────
 *
 * A URL que o `<img>` da prévia escura recebe (o `src`) e a presença do botão
 * que apaga aquele arquivo. Nada de asserção sobre nomes de prop, `data-*`
 * interno ou texto de código-fonte: o que a pessoa vê é a arte no quadro
 * escuro e o botão ao lado do campo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/settings/updateMarcaDaOrganizacao", () => ({
  updateMarcaDaOrganizacao: vi.fn(),
}));

import { FormularioDaMarcaDaOrganizacao } from "@/app/app/settings/marca/_form";
import { urlPublicaDoLogo } from "@/lib/branding/logo";

/** Base do Storage nas duas camadas; o mesmo valor que a página injeta em runtime. */
const BASE = "https://storage.exemplo.test";
const CAMINHO_CLARO = "11111111-1111-4111-8111-111111111111/claro.png";
const CAMINHO_ESCURO = "11111111-1111-4111-8111-111111111111/escuro.png";

beforeEach(() => {
  // É daqui que `logoDaCamada` monta a URL no navegador (`lib/branding/logo.ts`).
  // Sem isto a base é string vazia e o caminho viraria `null` — o teste mediria
  // "sem logo" nos dois casos e não distinguiria claro de escuro.
  (window as unknown as { __PUBLIC_ENV__?: unknown }).__PUBLIC_ENV__ = {
    NEXT_PUBLIC_SUPABASE_URL: BASE,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __PUBLIC_ENV__?: unknown }).__PUBLIC_ENV__;
});

/** O `<img>` que a prévia de um tema desenhou. */
function arteDaPrevia(tema: "claro" | "escuro"): HTMLImageElement {
  const img = document.querySelector<HTMLImageElement>(`[data-previa-do-logo='${tema}'] img`);
  if (!img) throw new Error(`a prévia "${tema}" não desenhou imagem nenhuma`);
  return img;
}

function montar(marca: { logo_path: string | null; logo_dark_path?: string | null }) {
  return render(
    <FormularioDaMarcaDaOrganizacao
      gravada={{
        app_name: "Empresa de teste",
        accent_hex: null,
        accent_dark_hex: null,
        logo_path: marca.logo_path,
        // O campo real do banco (`settings.branding.logo_dark_path`) — o nome
        // que a barra lateral lê. Era este que a tela não repassava.
        logo_dark_path: marca.logo_dark_path ?? null,
        email_from_name: null,
        email_reply_to: null,
      }}
      instalacao={{}}
      ambiente={{}}
      vocabulario={{ lei: "LGPD", rotuloNomeLegal: "Razão social" }}
    />,
  );
}

describe("prévia escura da marca da organização (#3793)", () => {
  it("com logo escuro salvo, a prévia escura recebe a URL do escuro e o botão de remover aparece", () => {
    montar({ logo_path: CAMINHO_CLARO, logo_dark_path: CAMINHO_ESCURO });

    expect(arteDaPrevia("claro").src).toBe(urlPublicaDoLogo(CAMINHO_CLARO, BASE));
    expect(arteDaPrevia("escuro").src).toBe(urlPublicaDoLogo(CAMINHO_ESCURO, BASE));
    expect(screen.getByRole("button", { name: "Remover logo escuro" })).toBeInTheDocument();
    // A arte escura específica dispensa a moldura branca de proteção de contraste.
    expect(arteDaPrevia("escuro").parentElement?.className ?? "").not.toContain("bg-white");
  });

  it("sem logo escuro, a prévia escura cai no logo claro e o botão de remover some", () => {
    montar({ logo_path: CAMINHO_CLARO });

    expect(arteDaPrevia("escuro").src).toBe(urlPublicaDoLogo(CAMINHO_CLARO, BASE));
    expect(screen.queryByRole("button", { name: "Remover logo escuro" })).toBeNull();
    // O logo claro continua removível: o botão que sumiu é só o do escuro.
    expect(screen.getByRole("button", { name: "Remover" })).toBeInTheDocument();
    // Logo único no tema escuro mantém a proteção de contraste do #659.
    expect(arteDaPrevia("escuro").parentElement?.className ?? "").toContain("bg-white");
  });

  it("o botão de remover apaga de fato: some, e a prévia escura volta ao logo claro", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: { logo_url: null } }) });
    vi.stubGlobal("fetch", fetchMock);

    montar({ logo_path: CAMINHO_CLARO, logo_dark_path: CAMINHO_ESCURO });
    fireEvent.click(screen.getByRole("button", { name: "Remover logo escuro" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/marca/logo?escopo=organizacao&tema=escuro",
        { method: "DELETE" },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remover logo escuro" })).toBeNull(),
    );
    expect(arteDaPrevia("escuro").src).toBe(urlPublicaDoLogo(CAMINHO_CLARO, BASE));
  });
});
