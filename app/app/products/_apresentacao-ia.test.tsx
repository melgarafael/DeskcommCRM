import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { CatalogProductAiPresentation } from "@/app/app/products/_apresentacao-ia";
import { apiClient } from "@/lib/api/client";
import type { CatalogProductPresentationPublic } from "@/lib/catalogo/apresentacao";
import type { Produto } from "@/lib/schemas/produtos";

const APARTAMENTO: Produto = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "APTO-MOEMA",
  nome: "Apartamento em Moema",
  descricao: null,
  marca: null,
  categoria: "Imóveis",
  preco_cents: 850_000_00,
  moeda: "BRL",
  custo_cents: null,
  controla_estoque: false,
  quantidade: 1,
  ativo: true,
  origem: "manual",
  imagem_url: null,
  fotos: ["imoveis/moema/fachada.jpg", "imoveis/moema/sala.jpg"],
  updated_at: "2026-10-14T12:00:00.000Z",
};

function apresentacao(
  overrides: Partial<CatalogProductPresentationPublic> = {},
): CatalogProductPresentationPublic {
  return {
    enabled: true,
    kind: "text",
    title: "Apartamento perto do parque",
    text_content: "Duas suítes, varanda e duas vagas.",
    use_catalog_photos: true,
    show_price: true,
    has_audio: false,
    audio_mime: null,
    audio_size_bytes: null,
    audio_url: null,
    updated_at: "2026-10-14T12:00:00.000Z",
    ...overrides,
  };
}

function abrirPreview(value: CatalogProductPresentationPublic) {
  vi.mocked(apiClient.get).mockResolvedValue({ data: value });
  render(
    <CatalogProductAiPresentation
      product={APARTAMENTO}
      photoUrls={{
        "imoveis/moema/fachada.jpg": "https://storage.test/fachada.jpg",
        "imoveis/moema/sala.jpg": "https://storage.test/sala.jpg",
      }}
    />,
  );
  fireEvent.click(screen.getByTestId("abrir-apresentacao-ia"));
  return screen.findByTestId("preview-apresentacao");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preview da apresentação do catálogo usa o plano executável", () => {
  it("item único de texto combina título e corpo, preserva fotos e termina no preço", async () => {
    await abrirPreview(apresentacao());

    expect(screen.getByTestId("quantidade-mensagens").textContent).toContain("4 mensagens");
    const messages = screen.getAllByTestId(/^mensagem-apresentacao-/);
    expect(messages).toHaveLength(4);
    expect(messages[0]?.textContent).toBe(
      "1.Apartamento perto do parque\n\nDuas suítes, varanda e duas vagas.",
    );
    expect(messages[1]?.textContent).toContain("Fotos cadastradas 1");
    expect(messages[1]?.querySelector("img")?.getAttribute("src")).toBe(
      "https://storage.test/fachada.jpg",
    );
    expect(messages[2]?.textContent).toContain("Fotos cadastradas 2");
    expect(messages[2]?.querySelector("img")?.getAttribute("src")).toBe(
      "https://storage.test/sala.jpg",
    );
    expect(messages[3]?.textContent).toContain("Preço:");
    expect(messages[3]?.textContent).toContain("850.000,00");
  });

  it("áudio segue depois do título e antes das fotos cadastradas", async () => {
    await abrirPreview(
      apresentacao({
        kind: "audio",
        text_content: null,
        show_price: false,
        has_audio: true,
        audio_mime: "audio/ogg; codecs=opus",
        audio_size_bytes: 1024,
        audio_url: "https://storage.test/apresentacao.ogg",
      }),
    );

    expect(screen.getByTestId("quantidade-mensagens").textContent).toContain("4 mensagens");
    const messages = screen.getAllByTestId(/^mensagem-apresentacao-/);
    expect(messages.map((message) => message.textContent)).toEqual([
      "1.Apartamento perto do parque",
      "2.",
      "3.Fotos cadastradas 1",
      "4.Fotos cadastradas 2",
    ]);
    expect(screen.getByTestId("preview-apresentacao-audio").getAttribute("src")).toBe(
      "https://storage.test/apresentacao.ogg",
    );
  });

  it("apresentação desativada representa zero envios e não inventa uma sequência", async () => {
    await abrirPreview(apresentacao({ enabled: false }));

    expect(screen.getByTestId("quantidade-mensagens").textContent).toContain("0 mensagens");
    expect(screen.getByTestId("estado-preview-apresentacao").textContent).toBe(
      "Apresentação pela IA: Desativada",
    );
    expect(screen.queryAllByTestId(/^mensagem-apresentacao-/)).toHaveLength(0);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
  });
});
