/**
 * A BOLHA APAGADA DIZ QUEM APAGOU — e o texto de quem apagou decide se ele
 * aparece para quem atende (#3277).
 *
 * ─── O que estava invertido ───────────────────────────────────────────────
 *
 * O CRM mostrava o texto da mensagem apagada PELO ATENDENTE (com o rótulo
 * "Visível só aqui no CRM") e escondia o da apagada PELO CONTATO — o inverso do
 * que a operação e a conformidade precisam. O "apagar para todos" do aplicativo
 * é gesto do titular NO CANAL, não pedido de eliminação sob LGPD art. 18 / RGPD
 * art. 17: quem elimina de verdade é o pedido de LGPD desta casa, que anonimiza
 * e é ele que zera o corpo (`lib/lgpd/cascata.ts`). O registro do que foi
 * combinado no atendimento é justamente o que sustenta a defesa do controlador
 * — e o apagamento de quem atende é ato INTERNO, que não deveria escolher o que
 * a equipe lê na Inbox.
 *
 * ─── Como o componente sabe QUEM apagou ───────────────────────────────────
 *
 * A linha guarda `revoked_at`, não o ator. O que ela sustenta é a DIREÇÃO, e
 * ela basta porque o caminho é único de cada lado: "Apagar para todos" só existe
 * em mensagem NOSSA (`podeApagar`) e o apagamento de uma recebida só chega pelo
 * canal. Por isso os quatro casos abaixo passam o AUTOR por `direction` — se um
 * dia o motor passar a carimbar o ator num campo próprio, é este arquivo que
 * diz o que a tela promete.
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR), então o texto
 * esperado é o português; o espanhol é coberto por i18n-espanhol-cobre-a-tela.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

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
    body: "corpo da mensagem",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-10-22T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-10-22T12:00:00.000Z",
    ...over,
  };
}

/** O marcador de apagamento, e não o aviso de retenção ("apagada pela política"). */
const marcadorDaApagada = () => screen.queryByText(/apagada pelo (contato|atendente)/);

const bolha = () => screen.getByTestId("message-bubble");

describe("mensagem apagada: quem apagou decide a cor, o marcador e o texto (#3277)", () => {
  it("apagada PELO CONTATO: cinza, marcador do contato e o texto preservado à vista", () => {
    render(
      <MessageBubble
        message={msg({
          direction: "inbound",
          sent_via: null,
          revoked_at: "2026-10-22T12:30:00.000Z",
          body: "combinamos a entrega para sexta",
        })}
      />,
    );

    expect(screen.getByText("Esta mensagem foi apagada pelo contato")).toBeInTheDocument();
    // O texto do contato APARECE para quem atende, com a legenda de preservação.
    expect(screen.getByText("combinamos a entrega para sexta")).toBeInTheDocument();
    expect(screen.getByText("Conteúdo preservado (LGPD)")).toBeInTheDocument();
    expect(screen.queryByText("O texto continua guardado no registro da empresa.")).toBeNull();

    // Cinza nos DOIS sentidos: a bolha sai das cores da direção.
    expect(bolha().className).toContain("bg-muted");
    expect(bolha().className).toContain("text-muted-foreground");
    expect(bolha().className).toContain("ring-1");
  });

  it("apagada PELO ATENDENTE: cinza, marcador do atendente, nenhum texto e o aviso de onde ele está", () => {
    render(
      <MessageBubble
        message={msg({
          direction: "outbound",
          revoked_at: "2026-10-22T12:30:00.000Z",
          body: "valor combinado",
        })}
      />,
    );

    expect(screen.getByText("Esta mensagem foi apagada pelo atendente")).toBeInTheDocument();
    // Ato interno não escolhe o que a equipe lê: o texto sai da Inbox...
    expect(screen.queryByText("valor combinado")).toBeNull();
    expect(screen.queryByText("Conteúdo preservado (LGPD)")).toBeNull();
    // ...e a bolha diz onde ele está, em vez de deixar a impressão de que sumiu.
    expect(screen.getByText("O texto continua guardado no registro da empresa.")).toBeInTheDocument();

    // Também cinza: a cor da direção sai mesmo sendo mensagem nossa.
    expect(bolha().className).toContain("bg-muted");
    expect(bolha().className).toContain("text-muted-foreground");
    expect(bolha().className).not.toContain("bg-primary");
    expect(bolha().className).not.toContain("text-primary-foreground");
  });

  it("CONTROLE: mensagem viva fica exatamente como hoje — cor da direção, texto à vista e nenhum marcador", () => {
    // Sem este caso, pintar de cinza TODA bolha passaria nos dois acima e
    // mataria a leitura de quem está no ar: o gate ficaria verde pelo motivo
    // errado.
    const { rerender } = render(
      <MessageBubble message={msg({ direction: "outbound", body: "tudo certo por aqui" })} />,
    );
    expect(screen.getByText("tudo certo por aqui")).toBeInTheDocument();
    expect(marcadorDaApagada()).toBeNull();
    expect(bolha().className).toContain("bg-primary");
    expect(bolha().className).not.toContain("ring-1");

    rerender(
      <MessageBubble message={msg({ direction: "inbound", sent_via: null, body: "bom dia" })} />,
    );
    expect(screen.getByText("bom dia")).toBeInTheDocument();
    expect(marcadorDaApagada()).toBeNull();
    expect(bolha().className).not.toContain("ring-1");
    expect(bolha().className).not.toContain("ring-border");
  });

  it("CONTROLE: mídia apagada pela política de retenção segue como hoje, sem marcador de apagamento", () => {
    render(
      <MessageBubble
        message={msg({
          direction: "inbound",
          sent_via: null,
          type: "image",
          body: null,
          metadata: { media_status: "expired", media_retention_days: 30 },
        })}
      />,
    );

    expect(screen.getByText("Mídia apagada pela política de retenção (30 dias)")).toBeInTheDocument();
    expect(marcadorDaApagada()).toBeNull();
    expect(bolha().className).not.toContain("ring-border");
  });
});
