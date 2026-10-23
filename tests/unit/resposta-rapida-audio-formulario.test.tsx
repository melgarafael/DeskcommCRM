/**
 * O formulário da resposta rápida de ÁUDIO (#2833) frente ao que a rota recusa.
 *
 * A rota fareja os bytes e recusa M4A e WebM (415). O formulário cria o
 * template ANTES de subir o arquivo, então uma recusa ali deixava:
 *  (a) na criação, uma resposta rápida sem texto e sem áudio na barra do Inbox;
 *  (b) na troca de áudio, o recurso sem o áudio que funcionava, porque o PATCH
 *      que tira o antigo ia antes do upload do novo.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ordem: [] as string[],
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: async (url: string, corpo: unknown) => {
      h.ordem.push("post");
      return h.post(url, corpo);
    },
    patch: async (url: string, corpo: unknown) => {
      h.ordem.push("patch");
      h.patch(url, corpo);
      return { data: {} };
    },
    delete: async (url: string) => {
      h.ordem.push("delete");
      return h.del(url);
    },
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
const audio = (n: number) => ({
  storage_path: `${ORG}/templates/${TPL}/0000000${n}-0000-4000-8000-000000000000.ogg`,
  media_mime: "audio/ogg",
  media_size_bytes: 3,
});
const arquivo = (nome: string, type: string) => new File([new Uint8Array([1, 2, 3])], nome, { type });

function abrir(template: Record<string, unknown> | null) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TemplateFormDialog open onOpenChange={() => {}} canShare={false} template={template as never} />
    </QueryClientProvider>,
  );
}

const escolherAudio = (file: File) =>
  fireEvent.change(document.getElementById("tpl-audio")!, { target: { files: [file] } });

beforeEach(() => {
  h.ordem = [];
  h.post.mockReset();
  h.patch.mockReset();
  h.del.mockReset();
  h.upload.mockReset();
});

describe("resposta rápida de áudio: o formulário não cria o que a rota vai recusar (#2833)", () => {
  it("(a) M4A é recusado na escolha: nenhum template é criado", async () => {
    abrir(null);
    fireEvent.click(screen.getByRole("button", { name: "Áudio" }));
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Boas-vindas" } });
    escolherAudio(arquivo("gravacao.m4a", "audio/mp4"));
    fireEvent.submit(screen.getByLabelText("Título").closest("form")!);

    await new Promise((r) => setTimeout(r, 20));
    expect(h.post).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("(b) o upload do áudio falha na criação: o template recém-criado é apagado", async () => {
    abrir(null);
    h.post.mockResolvedValue({ data: { id: TPL } });
    h.upload.mockRejectedValue(new Error("unsupported_media_type"));
    h.del.mockResolvedValue(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Áudio" }));
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Boas-vindas" } });
    escolherAudio(arquivo("voz.ogg", "audio/ogg"));
    fireEvent.submit(screen.getByLabelText("Título").closest("form")!);

    await waitFor(() => expect(h.ordem).toEqual(["post", "upload:voz.ogg", "delete"]));
    expect(h.del).toHaveBeenCalledWith(`/api/v1/message-templates/${TPL}`);
  });

  it("(c) trocar o áudio: o novo sobe ANTES do PATCH que tira o antigo", async () => {
    abrir({ id: TPL, title: "Voz", body: "", shortcut: null, owner_user_id: "u1", midias: [audio(1)] });
    h.upload.mockResolvedValue([audio(1), audio(2)]);

    escolherAudio(arquivo("nova.ogg", "audio/ogg"));
    fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() => expect(h.ordem).toEqual(["upload:nova.ogg", "patch"]));
    const [, corpo] = h.patch.mock.calls[0]!;
    expect((corpo as { midias: { storage_path: string }[] }).midias.map((m) => m.storage_path)).toEqual([
      audio(2).storage_path,
    ]);
  });

  it("(c') o upload do áudio novo falha: nenhum PATCH, o áudio antigo fica", async () => {
    abrir({ id: TPL, title: "Voz", body: "", shortcut: null, owner_user_id: "u1", midias: [audio(1)] });
    h.upload.mockRejectedValue(new Error("unsupported_media_type"));

    escolherAudio(arquivo("nova.ogg", "audio/ogg"));
    fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() => expect(h.ordem).toEqual(["upload:nova.ogg"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.patch).not.toHaveBeenCalled();
  });
});
