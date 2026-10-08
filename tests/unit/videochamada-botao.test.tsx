import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VideoCallButton } from "@/components/inbox/VideoCallButton";

/**
 * O BOTÃO DE VÍDEO SÓ EXISTE QUANDO A INSTALAÇÃO OFERECE VIDEOCHAMADA (#2440),
 * e o link que ele entrega precisa ser um link DE VERDADE (#2441).
 *
 * Os quatro contratos aqui vieram todos do review do #2441:
 *
 *  1. **Sem servidor, `null`** — padrão da casa (`WACALLS_API_BASE_URL`):
 *     esconde, nunca erro. Um dialog vazio seria pior que nada.
 *  2. **Nova aba, não iframe** — o `Permissions-Policy` de produção
 *     (`camera=(), microphone=(self)`) nega câmera e microfone em iframe de
 *     outra origem, e o `meet.jit.si` derruba chamada embutida em 5 minutos.
 *     Medido pelo mantenedor: `{camera:false, microphone:false}`.
 *  3. **Sala aleatória por abertura** — o formato antigo derivava a sala do
 *     UUID da conversa: o id interno saía para o cliente final e o link de uma
 *     consulta entrava na seguinte.
 *  4. **A janela de 24h é do COMPOSER, não é minha** — a rota não barra quem
 *     envia da tela (vira 131047 silencioso, #1614), então o "Enviar link"
 *     desliga com a janela fechada e o motivo fica visível.
 */

const sendMock = vi.hoisted(() => vi.fn());
const copiarMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
// O componente usa o helper (regra do repo: cliente nunca chama
// navigator.clipboard na mão — em http://IP não existe isSecureContext).
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (texto: string) => copiarMock(texto) as Promise<boolean>,
}));

const CONVERSA = "3f1d2b7c-9a44-4e11-8f21-5b6c7d8e9f00";

/** Canal com hetero-restrição (`freeformOutsideWindow: false`) — é o que a
 *  janela de 24h alcança de verdade. `waha` seria `sem_restricao` e não testava nada. */
const CANAL_COM_JANELA = "meta_cloud";

function injetaServidor(valor: string | undefined) {
  if (typeof window !== "undefined") {
    window.__PUBLIC_ENV__ = { ...(window.__PUBLIC_ENV__ ?? {}), JITSI_SERVER_URL: valor };
  }
}

/** O cliente escreveu `horasAtras` — a janela segue aberta se < 24h. */
function ultimaMensagem(horasAtras: number) {
  return new Date(Date.now() - horasAtras * 3_600_000).toISOString();
}

function abrirDialog() {
  return userEvent.setup().click(screen.getByTestId("btn-videochamada"));
}

function linkDaSala(): HTMLAnchorElement {
  // `Button asChild` = Radix Slot: os props (inclusive `data-testid`) entram no
  // PRÓPRIO `<a>` que é filho, não num `<button>` por cima. Por isso o que o
  // testid devolve já é a âncora — procurar um `<a>` dentro dele acha `null`
  // e é assim que este teste começou a falhar.
  const no = screen.getByTestId("btn-abrir-sala");
  return (no.tagName === "A" ? no : no.querySelector("a")) as HTMLAnchorElement;
}

describe("VideoCallButton", () => {
  beforeEach(() => {
    sendMock.mockReset();
    copiarMock.mockReset();
    copiarMock.mockResolvedValue(true);
    sendMock.mockImplementation((_args: unknown, cb?: { onSuccess?: () => void }) => {
      cb?.onSuccess?.();
    });
    injetaServidor(undefined);
  });

  it("sem JITSI_SERVER_URL o botão não renderiza (esconde, nunca erro)", () => {
    const { container } = render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        lastInboundAt={ultimaMensagem(1)}
      />,
    );
    expect(screen.queryByTestId("btn-videochamada")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("a sala vai numa NOVA ABA — iframe não recebe câmera nem microfone", async () => {
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        lastInboundAt={ultimaMensagem(1)}
      />,
    );
    await abrirDialog();

    // Sem iframe algum: é o ponto 1 do review. Se aparecer um, falhe aqui.
    expect(screen.queryByTestId("iframe-videochamada")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();

    const a = linkDaSala();
    expect(a.getAttribute("target")).toBe("_blank");
    // `noopener`: sem ela a sala aberta recebe window.opener e manipula a
    // tela do atendimento de quem abriu.
    expect(a.getAttribute("rel") ?? "").toContain("noopener");
    // `noreferrer`: a URL do atendimento não vai como Referer para o Jitsi.
    expect(a.getAttribute("rel") ?? "").toContain("noreferrer");
    expect(a.getAttribute("href")).toMatch(/^https:\/\/meet\.jit\.si\/sala-/);
    // Origem fora de http(s) não pode virar href (Zod já barra; isto é a rede).
    expect(a.getAttribute("href")).not.toMatch(/^javascript:/i);
  });

  it("a sala é aleatória por abertura — fechar e reabrir não é a mesma chamada", async () => {
    injetaServidor("https://meet.jit.si");
    const user = userEvent.setup();
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        lastInboundAt={ultimaMensagem(1)}
      />,
    );

    await user.click(screen.getByTestId("btn-videochamada"));
    const primeira = linkDaSala().getAttribute("href");
    expect(primeira).toMatch(/^https:\/\/meet\.jit\.si\/sala-/);

    // Fechar e reabrir = OUTRA chamada: a anterior deixa de valer.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("btn-abrir-sala")).toBeNull());

    await user.click(screen.getByTestId("btn-videochamada"));
    const segunda = linkDaSala().getAttribute("href");
    expect(segunda).not.toBe(primeira);

    // E nada do id da conversa vaza para fora (o motivo da troca do formato).
    expect(segunda).not.toContain(CONVERSA);
  });

  it("'Enviar link na conversa' manda a URL como mensagem desta conversa", async () => {
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        lastInboundAt={ultimaMensagem(1)}
      />,
    );
    await abrirDialog();
    const href = linkDaSala().getAttribute("href")!;

    await userEvent.click(screen.getByTestId("btn-enviar-link-video"));
    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(
        { conversation_id: CONVERSA, body: href },
        expect.anything(),
      );
    });
    expect(sendMock.mock.calls.length).toBe(1);
  });

  it("'Copiar link' não toca na API: é só clipboard", async () => {
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        lastInboundAt={ultimaMensagem(1)}
      />,
    );
    await abrirDialog();
    const href = linkDaSala().getAttribute("href")!;

    await userEvent.click(screen.getByTestId("btn-copiar-link-video"));
    await waitFor(() => expect(copiarMock).toHaveBeenCalledWith(href));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("janela fechada: o envio desliga e o MOTIVO fica à vista", async () => {
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        // 48h atrás = janela fechada (o cliente não escreve desde ontem).
        lastInboundAt={ultimaMensagem(48)}
      />,
    );
    await abrirDialog();

    const botao = screen.getByTestId("btn-enviar-link-video");
    expect(botao).toBeDisabled();
    // A trava não some: sem isto o operador só descobre a regra pelo erro da
    // plataforma (o 131047 silencioso da #1614).
    expect(screen.getByTestId("video-bloqueio").textContent).toContain(
      "A janela de 24h fechou há",
    );
    // O resto continua de pé: abrir e copiar não dependem do canal.
    expect(screen.getByTestId("btn-abrir-sala")).toBeTruthy();
    expect(screen.getByTestId("btn-copiar-link-video")).toBeEnabled();

    await userEvent.click(botao);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("cliente nunca escreveu: janela nunca abriu, e o texto diz isso (não inventa duração)", async () => {
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton conversationId={CONVERSA} provider={CANAL_COM_JANELA} lastInboundAt={null} />,
    );
    await abrirDialog();

    expect(screen.getByTestId("btn-enviar-link-video")).toBeDisabled();
    expect(screen.getByTestId("video-bloqueio").textContent).toContain(
      "a janela de 24h nunca abriu",
    );
  });

  it("canal sem restrição (provider desconhecido / sem sessão) não trava nada", async () => {
    injetaServidor("https://meet.jit.si");
    render(<VideoCallButton conversationId={CONVERSA} provider={null} lastInboundAt={null} />);
    await abrirDialog();

    // `sem_restricao`: não há relógio a mostrar, então travar aqui seria
    // impedir um envio que sairia sem problema.
    expect(screen.getByTestId("btn-enviar-link-video")).toBeEnabled();
    expect(screen.queryByTestId("video-bloqueio")).toBeNull();
  });

  it("bloqueio vindo do header trava igual (contato bloqueado, conversa encerrada…)", async () => {
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        lastInboundAt={ultimaMensagem(1)}
        bloqueio="Contato bloqueado — envio de mensagens desabilitado."
      />,
    );
    await abrirDialog();

    expect(screen.getByTestId("btn-enviar-link-video")).toBeDisabled();
    expect(screen.getByTestId("video-bloqueio").textContent).toContain("Contato bloqueado");
  });

  it("rede sem modelo aprovado (zernio_social): o texto é o do composer, não oferece modelo", async () => {
    // O composer, nesta mesma conversa, manda aguardar o cliente: não há modelo
    // aprovado nesta rede. O diálogo dizia "só um modelo aprovado sai daqui" —
    // dois textos para a mesma trava, e o do vídeo mandava procurar o que não existe.
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider="zernio_social"
        lastInboundAt={ultimaMensagem(48)}
      />,
    );
    await abrirDialog();

    expect(screen.getByTestId("btn-enviar-link-video")).toBeDisabled();
    const motivo = screen.getByTestId("video-bloqueio").textContent ?? "";
    expect(motivo).toBe(
      "Aguarde uma nova mensagem do cliente para reabrir o atendimento nesta rede.",
    );
    expect(motivo).not.toContain("modelo aprovado");
  });

  it("conversa encerrada: o envio desliga sem texto inventado, como o composer", async () => {
    injetaServidor("https://meet.jit.si");
    render(
      <VideoCallButton
        conversationId={CONVERSA}
        provider={CANAL_COM_JANELA}
        lastInboundAt={ultimaMensagem(1)}
        encerrada
      />,
    );
    await abrirDialog();

    expect(screen.getByTestId("btn-enviar-link-video")).toBeDisabled();
    // O composer só faz `disabled` em conversa encerrada; um texto só do vídeo
    // seria a segunda voz para a mesma trava.
    expect(screen.queryByTestId("video-bloqueio")).toBeNull();
    expect(screen.getByTestId("btn-copiar-link-video")).toBeEnabled();
  });
});
