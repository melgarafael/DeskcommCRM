// @vitest-environment node
//
// `extrairTextoDoArquivo` traduzia TODO `PdfExtractError` para a mesma frase
// ("Se ele for só imagens escaneadas..."), inclusive quando `extractPdfText`
// já tinha diagnosticado algo bem mais específico (o binário nativo
// `@napi-rs/canvas` ausente na plataforma — um defeito de infraestrutura, não
// do arquivo enviado). Resultado medido: um PDF com texto selecionável, numa
// instalação sem o binário, mostrava ao operador uma mensagem que apontava
// para o arquivo dele como culpado. Este teste prova que a mensagem de
// `extractPdfText` chega intacta até quem lê a fonte de conhecimento.

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as PdfExtractorModule from "@/lib/ai/rag/extractors/pdf";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]),
          error: null,
        }),
      }),
    },
  }),
}));

afterEach(() => {
  vi.doUnmock("@/lib/ai/rag/extractors/pdf");
  vi.resetModules();
});

describe("extrairTextoDoArquivo — repasse de erro do PDF", () => {
  it("repassa a mensagem específica do @napi-rs/canvas, sem trocá-la pela genérica de imagem escaneada", async () => {
    vi.doMock("@/lib/ai/rag/extractors/pdf", async () => {
      const real = await vi.importActual<typeof PdfExtractorModule>(
        "@/lib/ai/rag/extractors/pdf",
      );
      return {
        ...real,
        extractPdfText: async () => {
          throw new real.PdfExtractError(
            "Extração de PDF indisponível: o binário nativo @napi-rs/canvas não foi instalado " +
              "nesta plataforma. Reinstale as dependências SEM podar as opcionais " +
              "(`pnpm install`, não `--no-optional`). Até lá, PDFs não são lidos.",
          );
        },
      };
    });

    const { extrairTextoDoArquivo } = await import("@/lib/ai/rag/ingest/documento");

    await expect(extrairTextoDoArquivo("org/material.pdf")).rejects.toThrow(/@napi-rs\/canvas/);
    await expect(extrairTextoDoArquivo("org/material.pdf")).rejects.not.toThrow(
      /imagens escaneadas/,
    );
  });

  it("mantém a frase de 'imagem escaneada' quando é isso mesmo que aconteceu", async () => {
    vi.doMock("@/lib/ai/rag/extractors/pdf", async () => {
      const real = await vi.importActual<typeof PdfExtractorModule>(
        "@/lib/ai/rag/extractors/pdf",
      );
      return {
        ...real,
        extractPdfText: async () => {
          throw new real.PdfExtractError(
            "não consegui extrair texto deste PDF. Se ele for só imagens escaneadas, " +
              "não há letra nenhuma para ler — envie uma versão com texto selecionável.",
          );
        },
      };
    });

    const { extrairTextoDoArquivo } = await import("@/lib/ai/rag/ingest/documento");

    await expect(extrairTextoDoArquivo("org/material.pdf")).rejects.toThrow(/imagens escaneadas/);
  });
});
