/**
 * O SELO DA MENSAGEM QUE O FLUXO MANDOU PULAR POR CAUSA DA AGENDA (#3848).
 *
 * O caso NÃO é falha de envio: o fluxo foi configurado para não escrever para
 * quem tem compromisso marcado, e o pulo sai registrado — `failed` +
 * `error_code = compromisso_na_agenda` — porque era o código que já existia
 * (posto pelo mantenedor no #3840 para a linha não ficar em `queued` e ser
 * reenviada pelo watchdog). A Inbox mostra "Falhou" para esse código, com
 * "Tentar de novo" — e o reenvio, que não reavalia a agenda, mandaria em
 * silêncio o que a regra decidiu não mandar.
 *
 * Os três casos que este arquivo discrimina:
 *
 *   1. pulada  → selo "Pulada pela agenda", motivo e o compromisso que barrou;
 *   2. pulada  → SEM botão de reenviar, mesmo para quem tem permissão de reenviar;
 *   3. falha   → "Falhou" e botão, como antes.
 *
 * Sabotagens que deixam cada caso vermelho (medidas na mão):
 *   - tirar `MOTIVO_DO_PULO` de `FALHA_SEM_REENVIO` (lib/messaging/reenvio.ts):
 *     o caso 2 fica vermelho (o botão volta);
 *   - trocar `isFailed && !pulo` por `isFailed` no selo: o caso 1 fica vermelho
 *     (aparecem os DOIS selos);
 *   - ler o pulo pelo `metadata` em vez do par status+código: a linha antiga sem
 *     retrato cai no selo de falha.
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR), então o texto
 * esperado é o português; o espanhol é cobrado por i18n-espanhol-cobre-a-tela.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

// O Link real precisa de contexto de roteador para prefetch; aqui ele é só
// âncora — o que está sob teste é o selo e o destino gravado, não a navegação.
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const FRASE_AGENDADO =
  "O contato tem compromisso marcado na agenda — o fluxo está configurado para não enviar quando isso acontece.";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "outbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "Lembrete do seu horário",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "automation",
    sent_by_user_id: null,
    sent_at: "2026-09-08T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-08T12:00:00.000Z",
    ...over,
  };
}

/** A linha que o produtor grava: `failed` + o código do pulo + o retrato. */
const PULADA: Partial<Message> = {
  status: "failed",
  error_code: "compromisso_na_agenda",
  error_message:
    "Não enviada: o contato tem horário marcado e o fluxo está configurado para não enviar.",
  metadata: {
    pulo_da_agenda: { appointment_id: "8f4b1c2d-0000-4000-8000-000000000001", motivo: "agendado", titulo: "Avaliação inicial" },
  },
};

describe("MessageBubble — pulo da agenda", () => {
  it("pulada pela agenda rende o selo próprio, não o de falha, com motivo e compromisso", () => {
    render(<MessageBubble message={msg(PULADA)} />);

    const selo = screen.getByTestId("selo-pulada-pela-agenda");
    expect(selo).toHaveTextContent("Pulada pela agenda");
    // A moldura de erro diria "falhou" enquanto o selo diz "pulada" (#3850).
    expect(screen.getByTestId("message-bubble")).not.toHaveClass("border-destructive");
    expect(screen.queryByText("Falhou")).toBeNull();
    expect(screen.queryByTestId("motivo-da-falha")).toBeNull();

    const bloco = screen.getByTestId("pulo-da-agenda");
    expect(bloco).toHaveTextContent(FRASE_AGENDADO);
    expect(bloco).toHaveTextContent("Compromisso: Avaliação inicial");
    expect(bloco).toHaveTextContent(
      "Para mandar mesmo assim, mude a escolha do fluxo ou escreva pelo campo de resposta.",
    );
    // A ação honesta no lugar do reenvio: abrir o compromisso que barrou, na
    // rota que o Histórico da agenda e o Radar já usam.
    expect(screen.getByRole("link", { name: "Abrir compromisso" })).toHaveAttribute(
      "href",
      "/app/agenda?compromisso=8f4b1c2d-0000-4000-8000-000000000001",
    );
  });

  it("pulada NÃO oferece 'Tentar de novo', nem para quem pode reenviar mensagem de outro", () => {
    const onReenviar = vi.fn(async () => undefined);
    render(
      <MessageBubble
        message={msg({ ...PULADA, sent_via: "user", sent_by_user_id: "outro" })}
        viewerUserId="eu"
        podeReenviarDeOutros
        onReenviar={onReenviar}
      />,
    );

    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    expect(onReenviar).not.toHaveBeenCalled();
    // O selo continua lá: o que sumiu foi o reenvio, não o registro do pulo.
    expect(screen.getByTestId("selo-pulada-pela-agenda")).toHaveTextContent("Pulada pela agenda");
  });

  it("falha de verdade continua com 'Falhou' e com o botão", async () => {
    const onReenviar = vi.fn(async () => undefined);
    render(
      <MessageBubble
        message={msg({
          status: "failed",
          error_code: "storage_sign_failed",
          sent_via: "user",
          sent_by_user_id: "eu",
          updated_at: new Date().toISOString(),
        })}
        viewerUserId="eu"
        onReenviar={onReenviar}
      />,
    );

    expect(screen.queryByTestId("selo-pulada-pela-agenda")).toBeNull();
    expect(screen.queryByTestId("pulo-da-agenda")).toBeNull();
    expect(screen.getByText("Falhou")).toBeInTheDocument();
    expect(screen.getByTestId("message-bubble")).toHaveClass("border-destructive");
    expect(screen.getByTestId("motivo-da-falha")).toHaveTextContent(
      "Não conseguimos preparar o arquivo para envio.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(onReenviar).toHaveBeenCalledWith(false));
  });

  it("linha anterior ao retrato ainda é pulo: selo e motivo, sem link inventado", () => {
    // Antes desta entrega a linha já saía `failed` + `compromisso_na_agenda`,
    // só não dizia QUAL compromisso. Mostrar "Falhou" para ela seria mentir
    // sobre a causa; o destino do compromisso é o único dado que falta.
    render(
      <MessageBubble
        message={msg({
          status: "failed",
          error_code: "compromisso_na_agenda",
          error_message:
            "Não enviada: o contato tem horário marcado e o fluxo está configurado para não enviar.",
        })}
      />,
    );

    expect(screen.getByTestId("selo-pulada-pela-agenda")).toHaveTextContent("Pulada pela agenda");
    expect(screen.getByTestId("pulo-da-agenda")).toHaveTextContent(FRASE_AGENDADO);
    expect(screen.queryByRole("link", { name: "Abrir compromisso" })).toBeNull();
    expect(screen.queryByText("Falhou")).toBeNull();
  });

  it("o motivo medido muda a frase: atendimento em curso não é 'horário marcado'", () => {
    render(
      <MessageBubble
        message={msg({
          ...PULADA,
          metadata: {
            pulo_da_agenda: { appointment_id: "8f4b1c2d-0000-4000-8000-000000000001", motivo: "em_atendimento", titulo: "Avaliação" },
          },
        })}
      />,
    );
    expect(screen.getByTestId("pulo-da-agenda")).toHaveTextContent(
      "O contato está na agenda agora — o fluxo está configurado para não enviar quando isso acontece.",
    );
  });
});
