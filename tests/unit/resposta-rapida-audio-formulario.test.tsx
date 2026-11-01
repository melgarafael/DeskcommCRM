/**
 * O formulário da resposta rápida de ÁUDIO (#2833) frente ao que a rota recusa.
 *
 * A rota fareja os bytes e recusa M4A e WebM (415). O formulário cria o
 * template ANTES de subir o arquivo. A ausência de confirmação não comprova
 * que nada foi gravado; rollback incondicional poderia apagar o vencedor.
 * Casos anteriores à escrita continuam recusados antes da criação:
 *  (a) na criação, o seletor recusa M4A antes de criar a resposta;
 *  (b) na troca de áudio, o recurso sem o áudio que funcionava, porque o PATCH
 *      que tira o antigo ia antes do upload do novo.
 */
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ordem: [] as string[],
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  upload: vi.fn(),
  alerta: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: h.alerta, success: vi.fn() } }));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: async (url: string, corpo: unknown) => {
      h.ordem.push("post");
      return h.post(url, corpo);
    },
    patch: async (url: string, corpo: unknown) => {
      h.ordem.push("patch");
      return h.patch(url, corpo);
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
  h.alerta.mockReset();
  h.ordem = [];
  h.post.mockReset();
  h.patch.mockReset();
  h.patch.mockImplementation(async (_url: string, corpo: { midias?: unknown; midias_esperadas: unknown }) => ({
    data: { midias: corpo.midias ?? corpo.midias_esperadas },
  }));
  h.del.mockReset();
  h.upload.mockReset();
});

describe("resposta rápida de áudio: o formulário não cria o que a rota vai recusar (#2833)", () => {
  /*
   * O seletor de modo "Texto"/"Áudio" saiu com a #3009: as três seções
   * (mensagem, imagens, áudio) convivem no formulário, e o campo de áudio está
   * sempre na tela. O que estes casos prendem não mudou — M4A recusado antes de
   * criar, criação preservada quando falta confirmação, áudio novo antes do PATCH que
   * tira o antigo —, só a navegação até o campo.
   */
  it("(a) M4A é recusado na escolha: nenhum template é criado", async () => {
    abrir(null);
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Boas-vindas" } });
    escolherAudio(arquivo("gravacao.m4a", "audio/mp4"));
    fireEvent.submit(screen.getByLabelText("Título").closest("form")!);

    await new Promise((r) => setTimeout(r, 20));
    expect(h.post).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("(b) o upload falha na criação: conserva a linha para conferência/edição", async () => {
    abrir(null);
    h.post.mockResolvedValue({ data: { id: TPL } });
    h.upload.mockRejectedValue(new Error("unsupported_media_type"));
    h.del.mockResolvedValue(undefined);

    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Boas-vindas" } });
    escolherAudio(arquivo("voz.ogg", "audio/ogg"));
    fireEvent.submit(screen.getByLabelText("Título").closest("form")!);

    await waitFor(() => expect(h.ordem).toEqual(["post", "upload:voz.ogg"]));
    expect(h.del).not.toHaveBeenCalled();
  });

  it.each(["confirmação perdida", "409 com writer vencedor"])(
    "criação com %s conserva a linha/bytes e fecha sem recriar",
    async (resultado) => {
      let linha: { midias: ReturnType<typeof audio>[] } | null = { midias: [] };
      const objetos = new Map<string, string>();
      h.post.mockResolvedValue({ data: { id: TPL, midias: [] } });
      h.upload.mockImplementation(async () => {
        // A escrita existe, embora a Promise não entregue uma confirmação ao
        // formulário. No 409, ela pertence ao escritor que venceu o CAS.
        linha!.midias = [audio(2)];
        objetos.set(audio(2).storage_path, "bytes persistidos");
        throw new Error(resultado);
      });
      h.del.mockImplementation(async () => { linha = null; objetos.clear(); });
      function Tela() {
        const [open, setOpen] = useState(true);
        return <TemplateFormDialog open={open} onOpenChange={setOpen} canShare={false} />;
      }
      render(<QueryClientProvider client={new QueryClient()}><Tela /></QueryClientProvider>);
      fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Boas-vindas" } });
      escolherAudio(arquivo("voz.ogg", "audio/ogg"));
      fireEvent.submit(screen.getByLabelText("Título").closest("form")!);

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(h.del).not.toHaveBeenCalled();
      expect(linha?.midias).toEqual([audio(2)]);
      expect(objetos.get(audio(2).storage_path)).toBe("bytes persistidos");
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.upload).toHaveBeenCalledTimes(1);
      expect(h.alerta).toHaveBeenCalledWith("A resposta já foi criada. Confira a lista antes de tentar novamente.");
    },
  );

  it("(c) trocar o áudio: a substituição sobe ANTES do PATCH, que usa a resposta fresca", async () => {
    abrir({ id: TPL, title: "Voz", body: "", shortcut: null, owner_user_id: "u1", midias: [audio(1)] });
    h.upload.mockResolvedValue([audio(2)]);

    escolherAudio(arquivo("nova.ogg", "audio/ogg"));
    fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() => expect(h.ordem).toEqual(["upload:nova.ogg", "patch"]));
    expect(h.upload.mock.calls[0]![0]).toMatchObject({
      substituirAudio: audio(1).storage_path, midiasEsperadas: [audio(1)],
    });
    const [, corpo] = h.patch.mock.calls[0]!;
    expect(corpo).toMatchObject({ midias_esperadas: [audio(2)] });
    expect(corpo).not.toHaveProperty("midias");
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
