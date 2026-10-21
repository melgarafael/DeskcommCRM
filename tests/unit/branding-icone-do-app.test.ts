// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: "https://storage.example" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/lib/branding", () => ({ marcaEhADoProduto: () => false }));
vi.mock("@/lib/branding/saida", () => ({ NEUTROS_DE_SAIDA: { fundo: "#ffffff" } }));

import { gerarIconeDoApp, lerArquivoDoIcone } from "@/lib/branding/icone-do-app";
import { logger } from "@/lib/logger";
import { TAMANHO_MAXIMO_DO_LOGO } from "@/lib/branding/logo";
import { lerPng } from "../helpers/png-sintetico";

const caminho = "platform/00000000-0000-4000-8000-000000000001.png";
// PNG vermelho, 1×1: arquivo real, em vez de simular o renderizador.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const marca = {
  nome: "Central",
  logoUrl: null,
  accent: "#0000ff",
  accentFg: "#ffffff",
  origens: { nome: "instalacao", cor: "instalacao" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://storage.example");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("arquivo do ícone público da instalação", () => {
  it.each([
    null,
    "https://externo.example/icon.png",
    "platform/../../outro.png",
    "orgs/00000000-0000-4000-8000-000000000001.png",
  ])("não busca endereço livre, traversal ou arquivo de tenant: %s", async (entrada) => {
    const buscar = vi.fn();
    vi.stubGlobal("fetch", buscar);
    expect(await lerArquivoDoIcone(entrada)).toBeNull();
    expect(buscar).not.toHaveBeenCalled();
  });
  it("busca só o Storage configurado, sem redirecionar e com limite de tempo", async () => {
    const buscar = vi.fn().mockResolvedValue(new Response(png));
    vi.stubGlobal("fetch", buscar);
    expect(await lerArquivoDoIcone(caminho)).toBe(
      `data:image/png;base64,${png.toString("base64")}`,
    );
    expect(buscar).toHaveBeenCalledWith(
      `https://storage.example/storage/v1/object/public/brand-logos/${caminho}`,
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("não transforma SVG em imagem de aplicativo", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<svg><script/></svg>")));
    expect(await lerArquivoDoIcone(caminho)).toBeNull();
  });
  it("limita também a resposta em streaming, sem confiar no Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(TAMANHO_MAXIMO_DO_LOGO + 1))),
    );
    expect(await lerArquivoDoIcone(caminho)).toBeNull();
  });
  it("erro de rede mantém o fallback e deixa um aviso sem caminho ou token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret must not reach log")));
    expect(await lerArquivoDoIcone(caminho)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "marca: arquivo do ícone indisponível; usando o desenho da instalação",
    );
  });
});

describe("PNG real do aplicativo", () => {
  it.each([192, 512] as const)("renderiza imagem própria em %i×%i", async (lado) => {
    const corpo = Buffer.from(
      await gerarIconeDoApp(lado, marca, `data:image/png;base64,${png.toString("base64")}`),
    );
    expect(corpo.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(corpo.readUInt32BE(16)).toBe(lado);
    expect(corpo.readUInt32BE(20)).toBe(lado);
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it.each([
    [180, 0.8],
    [512, 0.56],
  ] as const)("o desenho encolhe para a zona segura (%i, conteúdo %f) e o fundo ocupa o lado inteiro", async (lado, conteudo) => {
    const corpo = Buffer.from(
      await gerarIconeDoApp(lado, marca, `data:image/png;base64,${png.toString("base64")}`, conteudo),
    );
    expect(corpo.readUInt32BE(16)).toBe(lado);
    expect(corpo.readUInt32BE(20)).toBe(lado);
    const { rgba } = lerPng(corpo);
    const pixel = (x: number, y: number) => [...rgba.subarray(4 * (y * lado + x), 4 * (y * lado + x) + 3)];
    const meio = Math.floor(lado / 2);
    // A margem que o recorte do sistema come é fundo; o desenho fica no centro.
    expect(pixel(Math.floor((lado * (1 - conteudo)) / 4), meio)).toEqual([255, 255, 255]);
    expect(pixel(meio, meio)).toEqual([255, 0, 0]);
  });
  it("sem encolher (192 e 512 de sempre), o desenho vai até a borda", async () => {
    const corpo = Buffer.from(
      await gerarIconeDoApp(192, marca, `data:image/png;base64,${png.toString("base64")}`),
    );
    const { rgba } = lerPng(corpo);
    const i = 4 * (96 * 192 + 4);
    expect([...rgba.subarray(i, i + 3)]).toEqual([255, 0, 0]);
  });
  it("arquivo com assinatura PNG mas truncado não derruba o ícone do aplicativo", async () => {
    const corpo = Buffer.from(
      await gerarIconeDoApp(192, marca, "data:image/png;base64,iVBORw0KGgo="),
    );
    expect(corpo.readUInt32BE(16)).toBe(192);
    expect(logger.warn).toHaveBeenCalledWith(
      "marca: não foi possível desenhar o arquivo do ícone; usando a inicial",
    );
  });
});
