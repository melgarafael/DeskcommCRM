/**
 * A PRÉVIA DO ÍCONE SÓ TROCA DEPOIS DE A ESCRITA RESPONDER (#1879).
 *
 * A spec `tests/e2e/icone-da-aba.spec.ts` falhava de vez em quando com "o toast
 * disse atualizado, mas a prévia não trocou": ela esperava o TEXTO do toast e
 * então cobrava `[data-previa-do-icone="arquivo"] img` com 5 s de teto. O toast
 * é escrito em `CampoDoIconeDaAba.tsx:88`, um passo ANTES de o corpo da resposta
 * ser lido (:89) e de o estado que pinta a prévia ser trocado (:90) — quem
 * espera o toast está esperando um sintoma, e o teto de 5 s mede o relógio do
 * runner, não o produto.
 *
 * Este teste fixa a ORDEM que a spec nova assume: com o `fetch` pendurado e,
 * depois, com o CORPO da resposta pendurado também, a prévia continua
 * "desenhado" — e só vira "arquivo" quando o corpo resolve. É a prova de que a
 * espera pelo evento (a resposta da rota) é necessária E suficiente, sem
 * aumentar teto nenhum.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { CampoDoIconeDaAba } from "@/components/branding/CampoDoIconeDaAba";

/** A URL que a rota do logo devolve — o mesmo formato que a spec e2e cobra. */
const URL_GRAVADA =
  "https://projeto.supabase.co/storage/v1/object/public/brand-logos/platform/11111111-1111-4111-8111-111111111111.png";

/** Uma promessa que só resolve quando o teste mandar — o "servidor lento". */
function adiada<T>() {
  let resolver!: (valor: T) => void;
  const promessa = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return { promessa, resolver };
}

function subirPelaTela() {
  const { container } = render(<CampoDoIconeDaAba iconeDaCamada={{ url: null }} />);
  const campo = container.querySelector("#icone-da-aba") as HTMLInputElement;
  const previa = container.querySelector("[data-previa-do-icone]") as HTMLElement;
  fireEvent.change(campo, {
    target: { files: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "icone.png", { type: "image/png" })] },
  });
  return { container, previa };
}

describe("o campo do ícone da aba espera a ESCRITA, não o relógio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("só troca a prévia quando o corpo da resposta chega", async () => {
    const escrita = adiada<{ ok: boolean; json: () => Promise<unknown> }>();
    const corpo = adiada<unknown>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => escrita.promessa),
    );

    const { container, previa } = subirPelaTela();

    // Nada aconteceu ainda no servidor: a prévia é o desenho e o toast não saiu.
    expect(previa).toHaveAttribute("data-previa-do-icone", "desenhado");
    expect(toast.success).not.toHaveBeenCalled();

    // O `fetch` respondeu (headers), mas o CORPO ainda não: continua desenhado.
    escrita.resolver({ ok: true, json: () => corpo.promessa as Promise<never> });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Ícone da aba atualizado."));
    expect(previa).toHaveAttribute("data-previa-do-icone", "desenhado");

    // O corpo chegou: é agora que a tela troca — e é esse o evento que a spec espera.
    corpo.resolver({ data: { logo_url: URL_GRAVADA } });
    await waitFor(() =>
      expect(container.querySelector("[data-previa-do-icone]")).toHaveAttribute(
        "data-previa-do-icone",
        "arquivo",
      ),
    );
    expect(container.querySelector('[data-previa-do-icone="arquivo"] img')).toHaveAttribute(
      "src",
      URL_GRAVADA,
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("mantém o desenhado quando a rota recusa a subida", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: { code: "rate_limited" } }),
      })),
    );

    const { previa } = subirPelaTela();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(previa).toHaveAttribute("data-previa-do-icone", "desenhado");
    expect(toast.success).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
