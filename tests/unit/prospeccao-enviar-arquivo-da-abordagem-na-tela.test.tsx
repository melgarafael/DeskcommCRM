/**
 * O ARQUIVO ENVIADO PELA TELA DA CAMPANHA (#4751).
 *
 * A prova de ponta: o que o componente passa para `onChange` — e `_client.tsx`
 * grava direto em `config.midia_da_abordagem` — é o descritor que a rota
 * devolveu, byte por byte, e é esse `storage_path` que `prepararMidiaDaAbordagem`
 * assina no envio. Se a tela remontasse o caminho (ou trocasse o mime), o teste
 * da cadeia cai.
 *
 * O segundo caso é a recusa: a rota recusa áudio, e a tela mostra a frase sem
 * tocar na configuração — nada de `onChange` com arquivo inválido.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ArquivoDaAbordagem } from "@/components/prospecting/ArquivoDaAbordagem";
import { descreverArquivoDaAbordagem } from "@/lib/prospecting/arquivo-da-abordagem";
import { prepararMidiaDaAbordagem } from "@/lib/prospecting/midia-da-abordagem";

const ORG = "0b110000-0000-4000-8000-000000000001";
const ARQUIVO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
const DESCRITOR = descreverArquivoDaAbordagem({ organizationId: ORG, id: ARQUIVO, bytes: PDF });

function montar(onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ArquivoDaAbordagem valor={undefined} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

function arquivo(nome: string, tipo: string, conteudo: string): File {
  return new File([conteudo], nome, { type: tipo });
}

beforeEach(() => {
  api.get.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("enviar o arquivo pela tela", () => {
  it("o descritor da rota chega ao onChange e é o caminho que o worker assina", async () => {
    expect(DESCRITOR.ok).toBe(true);
    if (!DESCRITOR.ok) return;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ data: { midia: DESCRITOR.midia, nome: "proposta.pdf" } }),
      })),
    );

    const onChange = montar();
    fireEvent.change(screen.getByLabelText("Enviar um arquivo do computador"), {
      target: { files: [arquivo("proposta.pdf", "application/pdf", "%PDF-1.7\n1 0 obj\n")] },
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(DESCRITOR.midia));
    // O caminho da tela é `{org}/prospecting/<uuid>.pdf`, e ele aparece na lista.
    expect(onChange.mock.calls[0]?.[0]).toEqual({
      storage_path: `${ORG}/prospecting/${ARQUIVO}.pdf`,
      media_mime: "application/pdf",
      media_size_bytes: PDF.length,
    });

    // A MESMA função do worker assina exatamente esse caminho, nesse bucket.
    const pedidos: { bucket: string; path: string }[] = [];
    const admin = {
      storage: {
        from(bucket: string) {
          return {
            createSignedUrl: async (path: string) => {
              pedidos.push({ bucket, path });
              return { data: { signedUrl: "https://storage.local/assinada" }, error: null };
            },
          };
        },
      },
    } as unknown as SupabaseClient;
    const pronta = await prepararMidiaDaAbordagem(admin, onChange.mock.calls[0]?.[0]);
    expect(pronta?.ok).toBe(true);
    expect(pedidos).toEqual([
      { bucket: "whatsapp-media", path: `${ORG}/prospecting/${ARQUIVO}.pdf` },
    ]);
  });

  it("a recusa da rota vira texto na tela e não mexe na configuração", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 415,
        json: async () => ({ error: { message: "O arquivo precisa ser uma imagem (JPG, PNG ou WEBP), um vídeo (MP4, 3GP ou MOV) ou um PDF." } }),
      })),
    );

    const onChange = montar();
    fireEvent.change(screen.getByLabelText("Enviar um arquivo do computador"), {
      target: { files: [arquivo("voz.ogg", "audio/ogg", "OggS")] },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("O arquivo precisa ser uma imagem"),
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
