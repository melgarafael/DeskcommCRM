/**
 * OS CONTEÚDOS NOVOS DA RESPOSTA RÁPIDA, PONTA A PONTA (#3009).
 *
 * A régua em si está em `resposta-rapida-tipos.test.ts`. Aqui ela é exercida nos
 * TRÊS lugares que a leem, com os componentes de verdade:
 *
 *   CADASTRO  `TemplateFormDialog` — texto, imagem e áudio independentes: o caso
 *             novo (texto+imagem+áudio) é ACEITO e vira `body` + `midias`; e o
 *             formulário RECUSA salvar sem conteúdo nenhum, com o motivo da
 *             régua.
 *   BARRA     `BarraDeRecursos` — o botão diz o que o clique prepara
 *             (`data-recurso-tipo`) e a resposta inválida carrega o motivo.
 *             A resposta SÓ DE TEXTO sai sem ícone, como antes — byte a byte.
 *   ENVIO     `Composer` — a resposta combinada entra na fila de anexos com
 *             prévia, o texto vira legenda do primeiro anexo que a aceita, e o
 *             envio sai por `useUploadMedia` + `useSendMessage`, o caminho de
 *             sempre (nada de transporte novo). A resposta inválida é recusada
 *             com motivo visível, sem escrever nada no campo.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enviar: vi.fn(),
  subirAnexo: vi.fn(),
  criarTemplate: vi.fn(),
  subirTemplate: vi.fn(),
  apagarTemplate: vi.fn(),
  toastErro: vi.fn(),
  toastOk: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: h.toastErro, success: h.toastOk, warning: vi.fn() },
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({
    // O envio de verdade é assíncrono; aqui o `onSuccess` é chamado na hora para
    // a fila andar — é o que faz o 2º anexo sair depois do 1º.
    mutate: (payload: unknown, opcoes?: { onSuccess?: () => void }) => {
      h.enviar(payload);
      opcoes?.onSuccess?.();
    },
    isPending: false,
  }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: h.subirAnexo, isPending: false }),
}));
vi.mock("@/hooks/templates/useUploadTemplateMedia", () => ({
  useUploadTemplateMedia: () => ({ mutateAsync: h.subirTemplate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  // Sem grupo (#3245): a barra e o slash-menu são os de antes dos grupos.
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({ data: RECURSOS, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: (url: string, corpo: unknown) => h.criarTemplate(url, corpo),
    patch: async () => ({ data: {} }),
    delete: async (url: string) => h.apagarTemplate(url),
    get: async () => ({ data: [], meta: { has_more: false } }),
  },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  usePaisDaOrgAtiva: () => null,
}));

import { Composer } from "@/components/inbox/Composer";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import { TemplateFormDialog } from "@/app/app/templates/_components/TemplateFormDialog";
import type { Recurso } from "@/lib/inbox/recursos";
import { MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO } from "@/lib/inbox/resposta-rapida";

const ORG = "11111111-1111-4111-8111-111111111111";
const TPL = "22222222-2222-4222-8222-222222222222";
const CONV = "aaaaaaaa-3333-4000-8000-000000000001";

const TEXTO_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const AUDIO_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const COMBINADA_ID = "cccccccc-3333-4333-8333-333333333333";
const VAZIA_ID = "dddddddd-4444-4444-8444-444444444444";

const ARQUIVO_IMAGEM = "0a0b0c0d-0000-4000-8000-000000000002.jpg";
const ARQUIVO_AUDIO = "0a0b0c0d-0000-4000-8000-000000000003.ogg";
const AUDIO_PATH = `${ORG}/templates/${AUDIO_ID}/${ARQUIVO_AUDIO}`;
const IMAGEM_PATH = `${ORG}/templates/${COMBINADA_ID}/${ARQUIVO_IMAGEM}`;
const AUDIO_COMBINADA_PATH = `${ORG}/templates/${COMBINADA_ID}/${ARQUIVO_AUDIO}`;

/**
 * As quatro respostas que a barra desenha:
 *
 *   TEXTO      o caso de 99% da base — o que NÃO pode mudar de aparência.
 *   AUDIO      o recurso de áudio da #2833 (corpo vazio + uma entrada `.ogg`).
 *   COMBINADA  o caso NOVO da #3009: texto + imagem + áudio.
 *   VAZIA      sem conteúdo nenhum — o que a régua recusa.
 */
const RECURSOS = [
  {
    id: TEXTO_ID,
    title: "Boas vindas",
    body: "Oi {{primeiro_nome}}, tudo bem?",
    shortcut: null,
    owner_user_id: null,
    midias: [],
  },
  {
    id: AUDIO_ID,
    title: "Áudio preço",
    body: "",
    shortcut: null,
    owner_user_id: null,
    midias: [{ storage_path: AUDIO_PATH, media_mime: "audio/ogg", media_size_bytes: 1234 }],
  },
  {
    id: COMBINADA_ID,
    title: "Tabela e áudio",
    body: "Olha os dois, {{primeiro_nome}}",
    shortcut: null,
    owner_user_id: null,
    midias: [
      { storage_path: IMAGEM_PATH, media_mime: "image/jpeg", media_size_bytes: 4321 },
      { storage_path: AUDIO_COMBINADA_PATH, media_mime: "audio/ogg", media_size_bytes: 999 },
    ],
  },
  {
    id: VAZIA_ID,
    title: "Resposta vazia",
    body: "   ",
    shortcut: null,
    owner_user_id: null,
    midias: [],
  },
];

function renderComposer() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId={CONV} contactName="Ana" />
    </QueryClientProvider>,
  );
}

function renderFormulario() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TemplateFormDialog open onOpenChange={() => {}} canShare={false} template={null} />
    </QueryClientProvider>,
  );
}

const arquivo = (nome: string, type: string) =>
  new File([new Uint8Array([1, 2, 3])], nome, { type });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  h.criarTemplate.mockResolvedValue({ data: { id: TPL } });
  h.subirTemplate.mockResolvedValue([]);
  h.subirAnexo.mockImplementation(
    async ({ file }: { file: File }) => ({
      storage_path: `${ORG}/upload/${file.name}`,
      media_mime: file.type,
      media_size_bytes: 3,
      kind: file.type.startsWith("audio/") ? "audio" : "image",
    }),
  );
  h.fetch.mockResolvedValue({
    ok: true,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" }),
  });
  vi.stubGlobal("fetch", h.fetch);
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CADASTRO — texto, imagem e áudio independentes
 * ══════════════════════════════════════════════════════════════════════════════ */

describe("cadastro (#3009): o caso novo é aceito, o vazio é recusado com motivo", () => {
  const nomear = (titulo: string) =>
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: titulo } });
  const submeter = () => fireEvent.submit(screen.getByLabelText("Título").closest("form")!);

  it("texto + imagem + áudio: aceito, e o POST leva o corpo e os dois arquivos sobem", async () => {
    renderFormulario();
    nomear("Tabela e áudio");
    fireEvent.change(screen.getByLabelText("Mensagem"), {
      target: { value: "Olha a tabela e o áudio" },
    });
    fireEvent.change(document.getElementById("tpl-midias")!, {
      target: { files: [arquivo("tabela.png", "image/png")] },
    });
    fireEvent.change(document.getElementById("tpl-audio")!, {
      target: { files: [arquivo("explicacao.ogg", "audio/ogg")] },
    });
    submeter();

    await waitFor(() => expect(h.criarTemplate).toHaveBeenCalledTimes(1));
    // O TEXTO e a MÍDIA convivem na mesma resposta — era exatamente o que o
    // modo "áudio" impedia.
    expect(h.criarTemplate.mock.calls[0]![1]).toMatchObject({
      title: "Tabela e áudio",
      body: "Olha a tabela e o áudio",
    });
    await waitFor(() => expect(h.subirTemplate).toHaveBeenCalledTimes(2));
    const subidos = h.subirTemplate.mock.calls.map(
      (chamada) => (chamada[0] as { file: File }).file.name,
    );
    expect(subidos).toEqual(["tabela.png", "explicacao.ogg"]);
    expect(h.toastErro).not.toHaveBeenCalled();
  });

  it("só imagem: aceito sem texto — o campo Mensagem deixou de ser obrigatório", async () => {
    renderFormulario();
    nomear("Só a foto");
    fireEvent.change(document.getElementById("tpl-midias")!, {
      target: { files: [arquivo("foto.png", "image/png")] },
    });
    submeter();

    await waitFor(() => expect(h.criarTemplate).toHaveBeenCalledTimes(1));
    expect(h.criarTemplate.mock.calls[0]![1]).toMatchObject({ title: "Só a foto", body: "" });
    await waitFor(() => expect(h.subirTemplate).toHaveBeenCalledTimes(1));
    expect(h.subirTemplate.mock.calls[0]![0]).toMatchObject({
      file: expect.objectContaining({ name: "foto.png" }),
    });
  });

  it("sem conteúdo nenhum: NÃO salva, e o motivo é o da régua", async () => {
    renderFormulario();
    nomear("Nada dentro");
    submeter();

    await waitFor(() => expect(h.toastErro).toHaveBeenCalledWith(MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO));
    expect(h.criarTemplate).not.toHaveBeenCalled();
    expect(h.subirTemplate).not.toHaveBeenCalled();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * BARRA — o botão diz o que o clique prepara
 * ══════════════════════════════════════════════════════════════════════════════ */

describe("barra do Inbox (#3009): o tipo vem da régua", () => {
  it("preserva o bloqueio do rascunho e também identifica uma resposta inválida", () => {
    const escolher = vi.fn();
    const dica = "Há um rascunho no campo. Envie ou limpe antes de escolher uma resposta rápida.";
    render(
      <BarraDeRecursos
        recursos={RECURSOS as unknown as Recurso[]}
        onEscolher={escolher}
        disabled
        dica={dica}
        storage={null}
      />,
    );

    const valida = screen.getByRole("button", { name: /tabela e áudio/i });
    expect(valida).toBeDisabled();
    expect(valida).toHaveAttribute("data-recurso-tipo", "texto+imagem+audio");
    expect(valida).toHaveAttribute("title", dica);
    const invalida = screen.getByRole("button", { name: /resposta vazia/i });
    expect(invalida).toBeDisabled();
    expect(invalida.getAttribute("title")).toContain(dica);
    expect(invalida.getAttribute("title")).toContain(MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO);
    fireEvent.click(valida);
    fireEvent.click(invalida);
    expect(escolher).not.toHaveBeenCalled();
  });

  it("os quatro casos: dois de antes byte a byte, o novo e o inválido", () => {
    render(
      <BarraDeRecursos
        recursos={RECURSOS as unknown as Recurso[]}
        onEscolher={vi.fn()}
        storage={null}
      />,
    );

    const barra = screen.getByTestId("barra-de-recursos");
    const botao = (nome: RegExp) => within(barra).getByRole("button", { name: nome });

    // REGRESSÃO: só texto continua sendo o TÍTULO puro, sem ícone.
    const soTexto = botao(/^Boas vindas$/);
    expect(soTexto).toHaveAttribute("data-recurso-tipo", "texto");
    // REGRESSÃO: o áudio da #2833 continua com o 🎧 na frente.
    const soAudio = botao(/áudio preço/i);
    expect(soAudio).toHaveAttribute("data-recurso-tipo", "audio");
    expect(soAudio.textContent).toBe("🎧 Áudio preço");

    // O CASO NOVO: texto+imagem+áudio, com os dois ícones na ordem canônica.
    const osTres = botao(/tabela e áudio/i);
    expect(osTres).toHaveAttribute("data-recurso-tipo", "texto+imagem+audio");
    expect(osTres.textContent).toBe("🖼🎧 Tabela e áudio");

    // O INVÁLIDO: o botão existe (a marcação da #3282 é quem decide quem
    // aparece), mas diz por que o clique não prepara nada.
    const vazia = botao(/resposta vazia/i);
    expect(vazia).toHaveAttribute("data-recurso-tipo", "invalida");
    expect(vazia).toHaveAttribute("title", MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ENVIO — a fila de anexos de sempre, agora com os três conteúdos
 * ══════════════════════════════════════════════════════════════════════════════ */

describe("envio (#3009): combinada vai para a fila e sai pelo caminho de sempre", () => {
  it("texto+imagem+áudio: fila com os dois anexos, texto como legenda, nada enviado no clique", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /tabela e áudio/i }));

    const fila = await screen.findByRole("dialog");
    // As duas mídias na fila, baixadas pela rota do template — na ordem gravada:
    // a imagem é a capa (com prévia) e o áudio vem em seguida, como um item da
    // fila (é um botão de remover por anexo, então dois botões = duas mídias).
    expect(within(fila).getByRole("img")).toBeInTheDocument();
    expect(within(fila).getAllByRole("button", { name: "Remover imagem" })).toHaveLength(2);
    expect(h.fetch).toHaveBeenCalledWith(`/api/v1/message-templates/${COMBINADA_ID}/midias/0`);
    expect(h.fetch).toHaveBeenCalledWith(`/api/v1/message-templates/${COMBINADA_ID}/midias/1`);
    // O corpo virou LEGENDA (não pode estar nos dois lugares: sairia duplicado).
    expect(within(fila).getByLabelText("Legenda")).toHaveValue("Olha os dois, Ana");
    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("");
    // Escolher não envia — quem decide é o operador.
    expect(h.enviar).not.toHaveBeenCalled();

    // O ENVIO de verdade: cada anexo pelo caminho de sempre, e a legenda só no
    // primeiro que a aceita (imagem sim, áudio não — #3151).
    fireEvent.click(within(fila).getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(h.enviar).toHaveBeenCalledTimes(2));
    expect(h.enviar.mock.calls.map((chamada) => chamada[0])).toEqual([
      expect.objectContaining({
        type: "image",
        body: "Olha os dois, Ana",
        conversation_id: CONV,
      }),
      expect.objectContaining({ type: "audio", body: undefined, conversation_id: CONV }),
    ]);
  });

  it("resposta sem conteúdo: recusada com o motivo, sem tocar no campo", () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /resposta vazia/i }));

    expect(h.toastErro).toHaveBeenCalledWith(MOTIVO_RESPOSTA_RAPIDA_SEM_CONTEUDO);
    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("");
    expect(h.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("REGRESSÃO: só texto continua indo para o campo, e só áudio para a fila", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /^Boas vindas$/ }));
    const campo = screen.getByLabelText(/mensagem/i);
    expect(campo).toHaveValue("Oi Ana, tudo bem?");
    expect(screen.queryByRole("dialog")).toBeNull();

    // A main protege o rascunho já preenchido: escolher outra resposta não o
    // substitui. O caso de áudio começa depois de o operador limpar o campo.
    const botaoDeAudio = screen.getByRole("button", { name: /áudio preço/i });
    expect(botaoDeAudio).toBeDisabled();
    fireEvent.click(botaoDeAudio);
    expect(campo).toHaveValue("Oi Ana, tudo bem?");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(campo, { target: { value: "" } });
    expect(botaoDeAudio).toBeEnabled();
    fireEvent.click(botaoDeAudio);
    const fila = await screen.findByRole("dialog");
    expect(within(fila).getByText(ARQUIVO_AUDIO)).toBeInTheDocument();
    expect(h.enviar).not.toHaveBeenCalled();
  });
});
