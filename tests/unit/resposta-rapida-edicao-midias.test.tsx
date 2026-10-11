/**
 * Edição das imagens da resposta rápida (#2526): a ORDEM remover-antes-de-subir
 * e o retry que não sobe de novo o que já entrou.
 *
 * (1) O teto de 5 vale a cada upload. Se a nova subisse antes do PATCH que
 *     remove, trocar uma imagem num template cheio daria 422.
 * (2) Se o 2º upload falha, salvar de novo sobe só ele — o 1º já está na linha.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ordem: [] as string[],
  patch: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    patch: async (url: string, corpo: unknown) => {
      h.ordem.push("patch");
      h.patch(url, corpo);
      return { data: {} };
    },
    post: vi.fn(),
  },
}));
vi.mock("@/hooks/templates/useUploadTemplateMedia", () => ({
  useUploadTemplateMedia: () => ({
    isPending: false,
    mutateAsync: async (args: { templateId: string; file: File }) => {
      h.ordem.push(`upload:${args.file.name}`);
      return h.upload(args);
    },
  }),
}));

import { TemplateFormDialog } from "@/app/app/templates/_components/TemplateFormDialog";

const ORG = "11111111-1111-4111-8111-111111111111";
const TPL = "22222222-2222-4222-8222-222222222222";
const midia = (n: number) => ({
  storage_path: `${ORG}/templates/${TPL}/0000000${n}-0000-4000-8000-000000000000.jpg`,
  media_mime: "image/jpeg",
  media_size_bytes: 3,
});
const png = (nome: string) => new File([new Uint8Array([0x89, 0x50])], nome, { type: "image/png" });

function abrir(qtd: number) {
  const template = {
    id: TPL,
    title: "Catalogo",
    body: "Veja o modelo",
    shortcut: null,
    owner_user_id: "u1",
    midias: Array.from({ length: qtd }, (_, i) => midia(i + 1)),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TemplateFormDialog open onOpenChange={() => {}} canShare={false} template={template} />
    </QueryClientProvider>,
  );
}

const escolher = (...files: File[]) =>
  fireEvent.change(document.getElementById("tpl-midias")!, { target: { files } });
const salvar = () => fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

beforeEach(() => {
  h.ordem = [];
  h.patch.mockReset();
  h.upload.mockReset();
});

describe("edição das imagens da resposta rápida (#2526)", () => {
  it("(1) trocar uma imagem num template cheio: o PATCH que remove vai ANTES do upload", async () => {
    abrir(5);
    h.upload.mockResolvedValue([midia(2), midia(3), midia(4), midia(5), midia(6)]);

    fireEvent.click(screen.getAllByRole("button", { name: /remover imagem/i })[0]!);
    escolher(png("nova.png"));
    salvar();

    await waitFor(() => expect(h.ordem).toEqual(["patch", "upload:nova.png"]));
    const [, corpo] = h.patch.mock.calls[0]!;
    expect((corpo as { midias: { storage_path: string }[] }).midias.map((m) => m.storage_path)).toEqual(
      [2, 3, 4, 5].map((n) => midia(n).storage_path),
    );
  });

  it("(2) o 2º upload falha: salvar de novo sobe só o 2º, e não remove de novo", async () => {
    abrir(2);
    h.upload
      .mockResolvedValueOnce([midia(2), midia(7)])
      .mockRejectedValueOnce(new Error("upload_failed"))
      .mockResolvedValueOnce([midia(2), midia(7), midia(8)]);

    fireEvent.click(screen.getAllByRole("button", { name: /remover imagem/i })[0]!);
    escolher(png("a.png"), png("b.png"));
    salvar();
    await waitFor(() => expect(h.ordem).toEqual(["patch", "upload:a.png", "upload:b.png"]));

    salvar();
    await waitFor(() => expect(h.ordem).toHaveLength(5));
    expect(h.ordem.slice(3)).toEqual(["patch", "upload:b.png"]);
    expect(h.patch.mock.calls[1]![1]).not.toHaveProperty("midias");
  });
});
