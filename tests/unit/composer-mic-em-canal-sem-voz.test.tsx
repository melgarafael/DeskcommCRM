/**
 * O MICROFONE DO INBOX NUM CANAL QUE NÃO ENTREGA NOTA DE VOZ — Instagram/Facebook.
 *
 * O gravador do composer sobe ogg/opus: o servidor converte para opus TODO áudio
 * marcado como nota de voz (`lib/messaging/media/voice-transcode.ts`), e o
 * Chrome já grava ogg. A Meta aceita áudio de DM do Instagram só em aac, m4a,
 * wav e mp4 (até 25 MB), e o provedor social repassa a URL sem converter. O
 * mp3 do agente, no mesmo canal, voltou HTTP 400 em toda tentativa (instalação
 * real, 15/11/2026) — e o canal passou a declarar `voiceNote: "none"`.
 *
 * O agente já responde em texto ali. Este arquivo cobra o lado humano: o
 * atendente não ganha um microfone que grava, sobe e termina numa bolha
 * `failed`. A pergunta é à capability, nunca ao provider.
 *
 *  1. `recusaNotaDeVoz` responde pela matriz, canal a canal, e não esconde o
 *     microfone de um canal desconhecido (o caro é sumir com o que funciona);
 *  2. o composer com o canal que recusa não mostra o microfone, e o lugar dele
 *     fica com o Enviar desabilitado — sem ele, o microfone segue lá;
 *  3. o Inbox liga a prop à capability da conversa aberta.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_SOCIAL,
  CHANNEL_PROVIDER_WAHA,
  PROVIDERS_DE_MENSAGEM,
  recusaNotaDeVoz,
} from "@/lib/channels/capabilities";

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer(props: { recusaNotaDeVoz?: boolean } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" {...props} />
    </QueryClientProvider>,
  );
}

describe("recusaNotaDeVoz — a matriz decide, canal a canal", () => {
  it.each([...PROVIDERS_DE_MENSAGEM])("%s: recusa só quando declara voiceNote none", (provider) => {
    expect(recusaNotaDeVoz(provider)).toBe(CHANNEL_CAPABILITIES[provider].voiceNote === "none");
  });

  it("a rede social recusa; o WhatsApp por QR não", () => {
    expect(recusaNotaDeVoz(CHANNEL_PROVIDER_SOCIAL)).toBe(true);
    expect(recusaNotaDeVoz(CHANNEL_PROVIDER_WAHA)).toBe(false);
  });

  it("canal ausente ou mais novo que este build fica com o microfone", () => {
    expect(recusaNotaDeVoz(null)).toBe(false);
    expect(recusaNotaDeVoz(undefined)).toBe(false);
    expect(recusaNotaDeVoz("rede_que_ainda_nao_existe")).toBe(false);
  });
});

describe("Composer — o microfone só onde a nota de voz chega", () => {
  it("canal que recusa: sem microfone, e o Enviar ocupa o lugar desabilitado", () => {
    renderComposer({ recusaNotaDeVoz: true });
    expect(screen.queryByRole("button", { name: /gravar áudio/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^enviar$/i })).toBeDisabled();
  });

  it("canal que recusa: digitar habilita o Enviar, como em qualquer canal", () => {
    renderComposer({ recusaNotaDeVoz: true });
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "oi" } });
    expect(screen.getByRole("button", { name: /^enviar$/i })).toBeEnabled();
  });

  it("sem a marca (o padrão, e o WhatsApp): o microfone continua", () => {
    renderComposer();
    expect(screen.getByRole("button", { name: /gravar áudio/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^enviar$/i })).not.toBeInTheDocument();
  });
});

describe("Inbox — a prop vem da capability da conversa aberta", () => {
  it("o InboxLayout passa recusaNotaDeVoz(provider da conversa) ao Composer", () => {
    const fonte = readFileSync(join(process.cwd(), "components/inbox/InboxLayout.tsx"), "utf8");
    expect(fonte).toMatch(
      /recusaNotaDeVoz=\{recusaNotaDeVoz\(selectedConversation\.channel_sessions\?\.provider\)\}/,
    );
  });
});
