/**
 * O balão diz de quem saiu a mensagem.
 *
 * `external_device` é a resposta dada pelo WhatsApp do CELULAR (fora do CRM) —
 * antes ela chegava à bolha sem rótulo, indistinguível do que foi digitado no
 * CRM. Este teste prende cada valor de `sent_via` ao rótulo certo, mais o caso
 * que NÃO leva rótulo (mensagem recebida).
 *
 * `sent_via='user'` não diz QUAL humano digitou — só que um humano digitou. Por
 * isso "Você" depende de duas pontas: `viewerUserId` (quem lê) e
 * `sent_by_user_id` (quem enviou). Faltando qualquer uma, o rótulo é
 * "Atendente"; os casos abaixo prendem as três combinações (sou eu, é o colega,
 * não se sabe).
 *
 * Não há caso para `'automation'`: nenhum emissor grava esse valor, e o
 * componente deixou de nomeá-lo. Quem guarda essa propriedade — nas duas
 * direções — é tests/unit/rotulo-de-origem-tem-emissor.test.ts.
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR), então o texto
 * esperado é o português — o espanhol é coberto por i18n-espanhol-cobre-a-tela.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

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

describe("MessageBubble — rótulo de origem", () => {
  it("resposta pelo celular (external_device) mostra 'Celular'", () => {
    render(<MessageBubble message={msg({ sent_via: "external_device" })} />);
    expect(screen.getByText("Celular")).toBeInTheDocument();
  });

  it("automação tem rótulo próprio — o motor passou a gravar esse valor (#652)", () => {
    // Até a #652 ninguém carimbava `'automation'` — tudo que não era pessoa saía
    // `'ai'` —, e este caso prendia o rótulo AUSENTE: a tela não podia oferecer
    // uma distinção que o motor não fazia. Com o carimbo em `origemDaMensagem`,
    // o rótulo ganhou emissor e o caso inverte de lado. O par continua vigiado
    // nas duas direções por tests/unit/rotulo-de-origem-tem-emissor.test.ts.
    render(<MessageBubble message={msg({ sent_via: "automation" })} />);
    expect(screen.getByText("Automação")).toBeInTheDocument();
  });

  it("digitada no CRM por QUEM ESTÁ LENDO mostra 'Você'", () => {
    render(
      <MessageBubble
        message={msg({ sent_via: "user", sent_by_user_id: "u-eu" })}
        viewerUserId="u-eu"
      />,
    );
    expect(screen.getByText("Você")).toBeInTheDocument();
  });

  it("digitada no CRM pelo COLEGA mostra 'Atendente', nunca 'Você'", () => {
    render(
      <MessageBubble
        message={msg({ sent_via: "user", sent_by_user_id: "u-colega" })}
        viewerUserId="u-eu"
      />,
    );
    expect(screen.getByText("Atendente")).toBeInTheDocument();
    expect(screen.queryByText("Você")).not.toBeInTheDocument();
  });

  it("sem emissor gravado (sent_by_user_id nulo) mostra 'Atendente'", () => {
    // Os dois nulos se equivalem em `===`. Sem a guarda de `viewerUserId != null`
    // este caso voltaria a dizer "Você" para uma mensagem de dono desconhecido.
    render(<MessageBubble message={msg({ sent_via: "user", sent_by_user_id: null })} />);
    expect(screen.getByText("Atendente")).toBeInTheDocument();
    expect(screen.queryByText("Você")).not.toBeInTheDocument();
  });

  it("crm (o DEFAULT da coluna) segue a mesma regra de 'user'", () => {
    render(
      <MessageBubble
        message={msg({ sent_via: "crm", sent_by_user_id: "u-eu" })}
        viewerUserId="u-eu"
      />,
    );
    expect(screen.getByText("Você")).toBeInTheDocument();
  });

  it("IA continua mostrando 'IA' (comportamento preservado)", () => {
    render(<MessageBubble message={msg({ sent_via: "ai" })} />);
    expect(screen.getByText("IA")).toBeInTheDocument();
  });

  it("mensagem recebida (inbound) não leva rótulo de origem", () => {
    render(
      <MessageBubble message={msg({ sent_via: "external_device", direction: "inbound" })} />,
    );
    expect(screen.queryByText("Celular")).not.toBeInTheDocument();
  });

  it("system leva 'Sistema' — a integração respondeu, mas não foi a IA", () => {
    // Antes este caso exigia o CONTRÁRIO ("não inventa rótulo"), e estava certo
    // enquanto nenhuma linha gravava `system`. Desde a #866 o envio por token
    // grava esse valor: sem o ramo, a bolha voltava a omitir a autoria de quem
    // falou — e a tela lia como se tudo tivesse saído do CRM.
    render(<MessageBubble message={msg({ sent_via: "system" })} />);
    expect(screen.getByText("Sistema")).toBeInTheDocument();
    expect(screen.queryByText("IA")).not.toBeInTheDocument();
  });
});

describe("MessageBubble — contenção de layout e quebra de palavras (#1451)", () => {
  it("texto longo sem espaços (ex: chave Pix) tem quebra forçada wrap-anywhere e bolha tem min-w-0", () => {
    const pixLongo =
      "00020126580014br.gov.bcb.pix0136a1b2c3d4-e5f6-7890-abcd-ef1234567890520400005303986540510.005802BR5913TESTE TESTE6008BRASILIA62070503***6304ABCD";
    const { container } = render(<MessageBubble message={msg({ body: pixLongo })} />);

    const p = screen.getByText(pixLongo);
    expect(p).toBeInTheDocument();
    expect(p.className).toContain("wrap-anywhere");
    // O Tailwind 4 gera `.break-words` (overflow-wrap: break-word) DEPOIS da
    // classe arbitrária `[overflow-wrap:anywhere]`, com a mesma especificidade:
    // juntas, vence o break-word e a quebra forçada fica sem efeito.
    expect(p.className).not.toContain("break-words");

    const bolha = p.closest(".max-w-\\[75\\%\\]");
    expect(bolha).not.toBeNull();
    expect(bolha?.className).toContain("min-w-0");

    const linha = container.firstElementChild as HTMLElement;
    expect(linha.className).toContain("min-w-0");
  });
});

