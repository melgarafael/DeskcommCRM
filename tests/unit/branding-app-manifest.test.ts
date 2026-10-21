import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ marca: vi.fn(), linha: vi.fn(), lingua: { valor: null as string | null } }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.lingua.valor ? { "accept-language": mocks.lingua.valor } : {}),
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: mocks.marca }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: mocks.linha }));
import manifest, { dynamic } from "@/app/manifest";
beforeEach(() => {
  mocks.lingua.valor = null;
  mocks.marca.mockResolvedValue({ nome: "Central" });
  mocks.linha.mockResolvedValue(null);
});
describe("manifest do ícone configurável", () => {
  it("oferece os dois tamanhos reais e o maskable, com leitura em runtime", async () => {
    const valor = await manifest();
    expect(dynamic).toBe("force-dynamic");
    expect(valor.icons).toEqual([
      { src: "/app-icon/192", sizes: "192x192", type: "image/png" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png" },
      { src: "/app-icon/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });
  it("tem identidade estável igual ao start_url de quem já instalou", async () => {
    const valor = await manifest();
    expect(valor.id).toBe("/app");
    expect(valor.start_url).toBe("/app");
    expect(valor.description).toBeTruthy();
  });
  it("trocar ou remover o arquivo muda as URLs sem trocar identidade/start_url", async () => {
    mocks.linha.mockResolvedValueOnce({ favicon_path: "platform/primeiro.png" });
    const antes = await manifest();
    mocks.linha.mockResolvedValueOnce({ favicon_path: "platform/segundo.png" });
    const depois = await manifest();
    expect(antes.icons?.[0]?.src).not.toBe(depois.icons?.[0]?.src);
    expect(depois.icons?.[0]?.src).toBe("/app-icon/192?v=platform%2Fsegundo.png");
    expect(depois.icons?.[2]?.src).toBe("/app-icon/maskable?v=platform%2Fsegundo.png");
    expect((await manifest()).icons?.[0]?.src).toBe("/app-icon/192");
    expect(antes.start_url).toBe(depois.start_url);
    expect(antes.scope).toBe(depois.scope);
    expect(antes.id).toBe(depois.id);
  });
  it("a descrição segue o idioma do aparelho que pede (não há idioma da instalação)", async () => {
    expect((await manifest()).description).toBe("Atendimento e vendas pelo WhatsApp, também no celular.");
    mocks.lingua.valor = "es-AR,es;q=0.9";
    expect((await manifest()).description).toBe("Atención y ventas por WhatsApp, también en el celular.");
  });
});
