/** Edição de áudio no teto de mídias e remoção que só persiste ao salvar. */
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MidiaDeTemplate } from "@/lib/templates/midias";

const h = vi.hoisted(() => ({
  midias: [] as MidiaDeTemplate[],
  ordem: [] as string[],
  patch: vi.fn(),
  upload: vi.fn(),
  erro: vi.fn(),
  sucesso: vi.fn(),
  falharUpload: false,
}));

vi.mock("sonner", () => ({ toast: { error: h.erro, success: h.sucesso } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    patch: async (url: string, corpo: unknown) => {
      h.ordem.push("patch");
      return h.patch(url, corpo);
    },
    post: vi.fn(),
  },
}));
vi.mock("@/hooks/templates/useUploadTemplateMedia", () => ({
  useUploadTemplateMedia: () => ({
    isPending: false,
    mutateAsync: async (args: { templateId: string; file: File }) => {
      h.ordem.push("upload");
      return h.upload(args);
    },
  }),
}));

import { TemplateFormDialog } from "@/app/app/templates/_components/TemplateFormDialog";
import { MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO } from "@/lib/inbox/resposta-rapida";

const ORG = "11111111-1111-4111-8111-111111111111";
const TPL = "22222222-2222-4222-8222-222222222222";
const midia = (n: number, audio = false): MidiaDeTemplate => ({
  storage_path: `${ORG}/templates/${TPL}/0000000${n}-0000-4000-8000-000000000000.${audio ? "ogg" : "jpg"}`,
  media_mime: audio ? "audio/ogg" : "image/jpeg",
  media_size_bytes: 3,
});
const imagens = [1, 2, 3, 4].map((n) => midia(n));
const antigo = midia(6, true);
const novo = midia(7, true);
const copiar = (lista: MidiaDeTemplate[]) => lista.map((m) => ({ ...m }));

function abrir(lista = [...imagens, antigo], body = "Mensagem útil") {
  h.midias = copiar(lista);
  const template = { id: TPL, title: "Áudio e imagens", body, shortcut: null,
    owner_user_id: "u1", midias: copiar(lista) };
  function Tela() {
    const [open, setOpen] = useState(true);
    return <>
      <button onClick={() => setOpen(true)}>Reabrir edição</button>
      <TemplateFormDialog open={open} onOpenChange={setOpen} canShare={false} template={template} />
    </>;
  }
  render(<QueryClientProvider client={new QueryClient()}><Tela /></QueryClientProvider>);
}

const salvar = () => fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));
const escolher = () => fireEvent.change(document.getElementById("tpl-audio")!, {
  target: { files: [new File([new Uint8Array([1, 2, 3])], "voz nova ç +%.ogg", { type: "audio/ogg" })] },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.ordem = [];
  h.falharUpload = false;
  h.patch.mockReset();
  h.upload.mockReset();
  h.patch.mockImplementation(async (_url: string, corpo: { midias?: MidiaDeTemplate[] }) => {
    if (corpo.midias) h.midias = copiar(corpo.midias);
    return { data: { id: TPL, midias: copiar(h.midias) } };
  });
  // O dublê conserva o teto e a semântica da rota: sem substituição explícita,
  // upload acrescenta. Não esconde o segundo áudio que o formulário antigo cria.
  h.upload.mockImplementation(async (args: { substituirAudio?: string }) => {
    if (h.falharUpload) throw new Error("upload_failed");
    if (args.substituirAudio) {
      const indice = h.midias.findIndex((m) => m.storage_path === args.substituirAudio);
      if (indice < 0) throw new Error("conflict");
      h.midias = h.midias.map((m, i) => i === indice ? novo : m);
    } else {
      if (h.midias.length >= 5) throw new Error("limite_de_midias");
      h.midias = [...h.midias, novo];
    }
    return copiar(h.midias);
  });
});

describe("troca e remoção de áudio sem perder o arquivo anterior", () => {
  it("troca o áudio de uma resposta com cinco mídias sem precisar remover imagem", async () => {
    abrir();
    escolher();
    salvar();
    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    expect(h.ordem[0]).toBe("upload");
    await waitFor(() => expect(h.sucesso).toHaveBeenCalledWith("Resposta rápida atualizada."));
    expect(h.midias).toEqual([...imagens, novo]);
    expect(h.upload.mock.calls[0]![0]).toMatchObject({
      substituirAudio: antigo.storage_path, midiasEsperadas: [...imagens, antigo],
    });
  });

  it("remover uma imagem e trocar áudio no teto não deixa dois áudios gravados", async () => {
    abrir();
    fireEvent.click(screen.getAllByRole("button", { name: /remover imagem/i })[0]!);
    escolher();
    salvar();
    await waitFor(() => expect(h.sucesso).toHaveBeenCalledWith("Resposta rápida atualizada."));
    expect(h.midias).toEqual([...imagens.slice(1), novo]);
    expect(h.midias.filter((m) => m.storage_path.endsWith(".ogg"))).toHaveLength(1);
    expect(h.ordem).toEqual(["upload", "patch"]);
  });

  it("upload recusado conserva as cinco mídias antigas e não anuncia sucesso", async () => {
    abrir();
    h.falharUpload = true;
    escolher();
    salvar();
    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    expect(h.midias).toEqual([...imagens, antigo]);
    expect(h.sucesso).not.toHaveBeenCalled();
  });

  it("troca persistida seguida de PATCH falho: retry usa a lista nova sem subir o áudio de novo", async () => {
    abrir();
    h.patch.mockRejectedValueOnce(new Error("patch_failed"));
    escolher();
    salvar();
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1));
    expect(h.midias).toEqual([...imagens, novo]);
    expect(h.sucesso).not.toHaveBeenCalled();
    salvar();
    await waitFor(() => expect(h.sucesso).toHaveBeenCalledWith("Resposta rápida atualizada."));
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.patch.mock.calls[1]![1]).toMatchObject({ midias_esperadas: [...imagens, novo] });
    expect(h.midias).toEqual([...imagens, novo]);
  });

  it("marcar a remoção, desfazer e cancelar não escreve; reabrir mantém o áudio", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Remover áudio" }));
    expect(h.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Desfazer remoção do áudio" }));
    expect(screen.getByLabelText("Áudio da resposta rápida")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remover áudio" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Reabrir edição" }));
    expect(screen.getByLabelText("Áudio da resposta rápida")).toBeInTheDocument();
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.midias).toEqual([...imagens, antigo]);
  });

  it("salvar a remoção mantém texto/imagens e manda o snapshot esperado", async () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Remover áudio" }));
    salvar();
    await waitFor(() => expect(h.sucesso).toHaveBeenCalledWith("Resposta rápida atualizada."));
    expect(h.midias).toEqual(imagens);
    expect(h.patch.mock.calls[0]![1]).toMatchObject({ midias_esperadas: [...imagens, antigo] });
  });

  it("retirar o único conteúdo é recusado antes de escrever", async () => {
    abrir([antigo], "");
    fireEvent.click(screen.getByRole("button", { name: "Remover áudio" }));
    salvar();
    await waitFor(() => expect(h.erro).toHaveBeenCalledWith(MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO));
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.midias).toEqual([antigo]);
  });
});
