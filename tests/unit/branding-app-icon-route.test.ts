import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  limite: vi.fn(),
  marca: vi.fn(),
  linha: vi.fn(),
  arquivo: vi.fn(),
  render: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.limite }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: mocks.marca }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: mocks.linha }));
vi.mock("@/lib/branding/icone-do-app", () => ({
  lerArquivoDoIcone: mocks.arquivo,
  gerarIconeDoApp: mocks.render,
}));
import { GET } from "@/app/app-icon/[size]/route";
import { isPublicPath } from "@/lib/auth/public-paths";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.limite.mockResolvedValue({ allowed: true });
  mocks.marca.mockResolvedValue({ nome: "Central" });
  mocks.linha.mockResolvedValue({ favicon_path: "platform/arquivo.png" });
  mocks.arquivo.mockResolvedValue("data:image/png;base64,imagem");
  mocks.render.mockResolvedValue(new ArrayBuffer(32));
});
describe("ícone do app público, sem escolher tenant", () => {
  it.each([
    ["192", 192, 1],
    ["512", 512, 1],
    ["180", 180, 0.8],
    ["maskable", 512, 0.56],
  ] as const)("%s é público antes do login e retorna imagem limitada", async (size, lado, conteudo) => {
    expect(isPublicPath(`/app-icon/${size}`)).toBe(true);
    const resposta = await GET(new Request(`https://crm.example/app-icon/${size}`), {
      params: Promise.resolve({ size }),
    });
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toBe("image/png");
    expect(mocks.marca).toHaveBeenCalledWith(null);
    expect(mocks.render).toHaveBeenCalledWith(
      lado,
      { nome: "Central" },
      "data:image/png;base64,imagem",
      conteudo,
    );
  });
  it("outros tamanhos e subcaminhos não recebem dispensa de autenticação", () => {
    expect(isPublicPath("/app-icon/64")).toBe(false);
    expect(isPublicPath("/app-icon/192/outro")).toBe(false);
    expect(isPublicPath("/app-icon/maskable/outro")).toBe(false);
    expect(isPublicPath("/app-icon/180x")).toBe(false);
  });
  it("valida o tamanho antes de ler marca/Storage", async () => {
    const resposta = await GET(new Request("https://crm.example/app-icon/999"), {
      params: Promise.resolve({ size: "999" }),
    });
    expect(resposta.status).toBe(400);
    expect(mocks.marca).not.toHaveBeenCalled();
  });
  it("rate limit barra processamento público e não usa IP cru na chave", async () => {
    mocks.limite.mockResolvedValue({ allowed: false });
    const resposta = await GET(
      new Request("https://crm.example/app-icon/192", {
        headers: { "x-forwarded-for": "192.0.2.1" },
      }),
      { params: Promise.resolve({ size: "192" }) },
    );
    expect(resposta.status).toBe(429);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.limite.mock.calls[0]?.[0]).toMatch(/^app-icon:[a-f0-9]{64}$/);
  });
});
