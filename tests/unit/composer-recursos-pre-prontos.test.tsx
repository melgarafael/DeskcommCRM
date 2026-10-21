/**
 * A BARRA DE RECURSOS USA O MESMO CAMINHO DO `/` (#2833).
 *
 * O defeito que este arquivo prende, e que foi MEDIDO no PR #2847: a barra
 * tinha um plano próprio que devolvia só o TEXTO — uma resposta rápida COM
 * IMAGEM clicada na barra perdia a imagem (o clique punha o texto no campo e
 * `payloadDeUso` levava `midias.length = 1` para lugar nenhum). A troca é de
 * CAMINHO: o clique da barra entrega o recurso ao MESMO `applyTemplate` que o
 * slash-menu (`/`) usa.
 *
 * O que cada caso prova, e por que nesta forma:
 *
 *   (a) TEXTO — o corpo interpolado cai no CAMPO, editável, e nada é enviado no
 *       clique. É o comportamento que NÃO podia mudar (99% dos recursos).
 *   (b) ÁUDIO e (d) IMAGEM — a mídia entra na FILA DE ANEXOS que já existe
 *       (`AttachmentPreviewDialog`), com prévia e a legenda do corpo. O (d) é o
 *       caso que fica VERMELHO pelo motivo certo se a mídia sumir: sem o
 *       caminho do `/`, não há diálogo nenhum, o `fetch` da rota de mídia não
 *       sai e a imagem não chega à fila.
 *   (c) o TIPO do recurso sai do CAMINHO do arquivo, nunca do `media_mime` da
 *       linha (coluna gravável pelo PostgREST) — a régua que o 🎧 da barra lê.
 *
 * Nada aqui dobra o próprio alvo: o teste clica os botões de verdade e lê o que
 * a tela mostra. O envio (`useSendMessage`) é um espião só para provar que o
 * clique NÃO envia.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const postMock = vi.fn();
const getMock = vi.fn();
const fetchMock = vi.fn();

const ORG = "11111111-1111-4111-8111-111111111111";
/**
 * O id de cada recurso é o id da LINHA de `message_templates` — o MESMO que a
 * rota de mídia usa para baixar os bytes (`/message-templates/:id/midias/:i`).
 */
const TEXTO_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const AUDIO_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const IMAGEM_ID = "cccccccc-3333-4333-8333-333333333333";
/** Os caminhos que a rota de upload gera: `<org>/templates/<template>/<uuid>.<ext>`. */
const AUDIO_PATH = `${ORG}/templates/${AUDIO_ID}/0a0b0c0d-0000-4000-8000-000000000001.ogg`;
const IMAGEM_PATH = `${ORG}/templates/${IMAGEM_ID}/0a0b0c0d-0000-4000-8000-000000000002.jpg`;

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
    // Recurso de ÁUDIO (#2833): não há coluna `tipo` — o áudio é uma entrada de
    // `midias`, e é o CAMINHO dela (que a rota escolheu pelos bytes) que diz que
    // este recurso é de áudio.
    id: AUDIO_ID,
    title: "Áudio preço",
    body: "",
    shortcut: null,
    owner_user_id: null,
    midias: [{ storage_path: AUDIO_PATH, media_mime: "audio/ogg", media_size_bytes: 1234 }],
  },
  {
    // O caso do defeito: recurso COM IMAGEM. No caminho próprio (o que saiu) a
    // imagem ficava para trás e só o texto chegava ao campo.
    id: IMAGEM_ID,
    title: "Tabela de preços",
    body: "Olha a tabela, {{primeiro_nome}}",
    shortcut: null,
    owner_user_id: null,
    midias: [{ storage_path: IMAGEM_PATH, media_mime: "image/jpeg", media_size_bytes: 48213 }],
  },
];

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: RECURSOS, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: (...args: unknown[]) => postMock(...args) as Promise<unknown>,
    get: (...args: unknown[]) => getMock(...args) as Promise<unknown>,
  },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
}));

import { Composer } from "@/components/inbox/Composer";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import { ehRecursoDeAudio, type Recurso } from "@/lib/inbox/recursos";

const CONV = "aaaaaaaa-3333-4000-8000-000000000001";
const texto = RECURSOS[0] as unknown as Recurso;
const audio = RECURSOS[1] as unknown as Recurso;
const imagem = RECURSOS[2] as unknown as Recurso;

function renderComposer(props: Record<string, unknown> = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId={CONV} contactName="Ana" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // O compositor sempre monta o seletor de contato (`ContactPickerDialog`), e
  // ele chama a lista de contatos mesmo fechado: sem uma página válida, o
  // `getNextPageParam` estoura e leva a árvore renderizada junto.
  getMock.mockResolvedValue({ data: [], meta: { has_more: false } });
  // Só a rota de mídia do template é chamada: os BYTES de cada entrada de
  // `midias`, pela própria origem — o caminho que o `/` já usava.
  fetchMock.mockResolvedValue({
    ok: true,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("ehRecursoDeAudio (a régua do 🎧 da barra)", () => {
  it("quem decide é o CAMINHO, não o `media_mime` da linha", () => {
    // A coluna é gravável pelo PostgREST: um `.ogg` com `media_mime` mentiroso
    // continua sendo áudio (o caminho foi gravado pelo upload), e um `.jpg`
    // marcado como áudio continua sendo imagem.
    expect(
      ehRecursoDeAudio({
        midias: [{ storage_path: AUDIO_PATH, media_mime: "image/jpeg", media_size_bytes: 1 }],
      }),
    ).toBe(true);
    expect(
      ehRecursoDeAudio({
        midias: [{ storage_path: IMAGEM_PATH, media_mime: "audio/ogg", media_size_bytes: 1 }],
      }),
    ).toBe(false);
  });
});

describe("BarraDeRecursos", () => {
  it("um botão por título e o clique escolhe o recurso", () => {
    const onEscolher = vi.fn();
    render(<BarraDeRecursos recursos={[texto, audio, imagem]} onEscolher={onEscolher} />);
    fireEvent.click(screen.getByRole("button", { name: /boas vindas/i }));
    expect(onEscolher).toHaveBeenCalledWith(expect.objectContaining({ id: TEXTO_ID }));
  });
});

describe("Composer + recursos pré-prontos", () => {
  it("(a) recurso SÓ DE TEXTO põe o texto NO CAMPO, editável, e NÃO envia sozinho", () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /boas vindas/i }));

    const campo = screen.getByLabelText(/mensagem/i);
    expect(campo).toHaveValue("Oi Ana, tudo bem?");
    // Editável: o operador ainda decide o que sai.
    expect(campo).not.toBeDisabled();
    // O critério central da issue: nenhum envio no clique.
    expect(sendMock).not.toHaveBeenCalled();
    // Sem mídia não há fila: nenhum diálogo de anexo abre.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("(b) recurso de ÁUDIO põe a mídia na FILA DE ANEXOS, sem enviar no clique", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /áudio preço/i }));

    // A fila de anexos que já existia — com prévia — e não mais a barra de
    // "anexo-de-recurso-pendente" do caminho próprio (essa saiu).
    const fila = await screen.findByRole("dialog");
    expect(within(fila).getByText(AUDIO_PATH.split("/").pop() as string)).toBeInTheDocument();
    expect(screen.queryByTestId("anexo-de-recurso-pendente")).toBeNull();
    // Os bytes vieram da MESMA rota do `/`.
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/message-templates/${AUDIO_ID}/midias/0`);
    // Armar não envia.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("(d) ⭐ recurso COM IMAGEM: a imagem chega à FILA com prévia e o texto vira LEGENDA", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /tabela de preços/i }));

    const fila = await screen.findByRole("dialog");
    // A prévia da imagem — exatamente o que o caminho próprio PERDIA.
    expect(within(fila).getByRole("img")).toBeInTheDocument();
    // O corpo interpolado entra como LEGENDA, não no campo: o texto não pode
    // estar nos dois lugares, senão a mensagem sairia duplicada.
    expect(within(fila).getByLabelText("Legenda")).toHaveValue("Olha a tabela, Ana");
    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/message-templates/${IMAGEM_ID}/midias/0`);
    // E o clique não enviou nada.
    expect(sendMock).not.toHaveBeenCalled();
  });

  /**
   * O `/` volta a abrir depois de um recurso de MÍDIA (medido na prova de tela
   * do #2847, passo f). Escolher marca o menu como dispensado; com mídia o campo
   * fica vazio sem passar pelo `onChange`, e o flag ficava preso: o `/` seguinte
   * não abria nada até o operador digitar outra coisa. Vale pela barra (campo já
   * vazio) e pelo próprio `/`.
   */
  it.each([
    ["pela barra", () => fireEvent.click(screen.getByRole("button", { name: /áudio preço/i }))],
    [
      "pelo /",
      () => {
        fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "/áudio" } });
        fireEvent.click(within(screen.getByRole("listbox")).getByText("Áudio preço"));
      },
    ],
  ])("(f) depois de um recurso de áudio escolhido %s, o próximo `/` abre o menu", async (_, escolher) => {
    renderComposer();

    escolher();
    const fila = await screen.findByRole("dialog");
    fireEvent.click(within(fila).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "/boas" } });
    expect(within(screen.getByRole("listbox")).getByText("Boas vindas")).toBeInTheDocument();
  });
});
