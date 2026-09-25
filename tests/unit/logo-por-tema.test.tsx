/** Dois logos sem perder o fallback, a herança ou a prévia após upload. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampoDeLogo } from "@/components/branding/CampoDeLogo";
import { resolverMarca } from "@/lib/branding/resolve";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const clara = "https://example.test/claro.png";
const escura = "https://example.test/escuro.png";
const imagem = (tema: string) =>
  document.querySelector<HTMLImageElement>(`[data-previa-do-logo='${tema}'] img`)!;
function campo(dark: string | null = null) {
  return render(
    <CampoDeLogo
      escopo="organizacao"
      logoDaCamada={{ url: clara, escuraUrl: dark }}
      logoHerdado={null}
      origemDoHerdado="da instalação"
      nomeEmVigor="Empresa"
    />,
  );
}
describe("par de logos e herança", () => {
  it("herda os dois logos quando a organização não define nenhum", () => {
    const m = resolverMarca(
      [{ origem: "organizacao" }, { origem: "banco", logoUrl: clara, logoDarkUrl: escura }],
      REGUA_DO_PRODUTO,
    );
    expect(m.logoUrl).toBe(clara);
    expect(m.logoDarkUrl).toBe(escura);
  });
  it("logo próprio da organização bloqueia arte escura da outra marca", () => {
    const m = resolverMarca(
      [
        { origem: "organizacao", logoUrl: clara },
        { origem: "banco", logoUrl: "/outra.png", logoDarkUrl: escura },
      ],
      REGUA_DO_PRODUTO,
    );
    expect(m.logoUrl).toBe(clara);
    expect(m.logoDarkUrl).toBeUndefined();
  });
  it("permite substituir somente a arte escura", () => {
    const m = resolverMarca(
      [
        { origem: "organizacao", logoDarkUrl: escura },
        { origem: "banco", logoUrl: clara },
      ],
      REGUA_DO_PRODUTO,
    );
    expect(m.logoUrl).toBe(clara);
    expect(m.logoDarkUrl).toBe(escura);
    expect(m.origens.logoDarkUrl).toBe("organizacao");
  });
  it("sem arte escura mantém o logo padrão protegido", () => {
    campo();
    expect(imagem("escuro").src).toBe(clara);
    expect(imagem("escuro").parentElement!.className).toContain("bg-white");
  });
  it("arte escura preserva transparência e não altera a prévia clara", () => {
    campo(escura);
    expect(imagem("claro").src).toBe(clara);
    expect(imagem("escuro").src).toBe(escura);
    expect(imagem("escuro").parentElement!.className).not.toContain("bg-white");
  });
  it("upload escuro aparece mesmo se refresh não chegar; remover restaura o padrão", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { logo_url: escura } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { logo_url: null } }) });
    vi.stubGlobal("fetch", fetchMock);
    campo();
    fireEvent.change(screen.getByLabelText("Logo para o tema escuro (opcional)"), {
      target: { files: [new File(["png"], "logo.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(imagem("escuro").src).toBe(escura));
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get("tema")).toBe("escuro");
    expect(form.get("escopo")).toBe("organizacao");
    expect(imagem("claro").src).toBe(clara);
    fireEvent.click(screen.getByText("Remover logo escuro"));
    await waitFor(() => expect(imagem("escuro").src).toBe(clara));
    expect(fetchMock.mock.calls[1]![0]).toContain("tema=escuro");
    expect(imagem("escuro").parentElement!.className).toContain("bg-white");
  });
});
