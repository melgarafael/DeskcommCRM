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
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

describe("MessageBubble — ações sobre mensagem própria", () => {
  it("edita texto recente e confirma a exclusão para todos", async () => {
    const user = userEvent.setup();
    const onEditar = vi.fn(async () => undefined);
    const onApagar = vi.fn(async () => undefined);
    render(<MessageBubble message={msg({
      external_id: "ABC", sent_by_user_id: "usuario-1", sent_at: new Date().toISOString(),
    })} viewerUserId="usuario-1" onEditar={onEditar} onApagar={onApagar} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Editar mensagem" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Editar mensagem" }), { target: { value: "novo texto" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onEditar).toHaveBeenCalledWith("novo texto"));
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Apagar para todos" }));
    expect(screen.getByText("O WhatsApp tentará remover esta mensagem também para o cliente.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Apagar para todos" }).at(-1)!);
    await waitFor(() => expect(onApagar).toHaveBeenCalledOnce());
  });

  it("salva com Enter, preserva Shift+Enter e evita envio duplicado", async () => {
    const user = userEvent.setup();
    const onEditar = vi.fn(async () => undefined);
    render(<MessageBubble message={msg({ external_id: "ABC", sent_at: new Date().toISOString() })}
      onEditar={onEditar} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Editar mensagem" }));
    const campo = screen.getByRole("textbox", { name: "Editar mensagem" });
    fireEvent.change(campo, { target: { value: "primeira linha\nsegunda linha" } });
    fireEvent.keyDown(campo, { key: "Enter", shiftKey: true });
    expect(onEditar).not.toHaveBeenCalled();
    fireEvent.keyDown(campo, { key: "Enter" });
    fireEvent.keyDown(campo, { key: "Enter" });
    await waitFor(() => expect(onEditar).toHaveBeenCalledOnce());
    expect(onEditar).toHaveBeenCalledWith("primeira linha\nsegunda linha");
  });

  it("rola até os controles quando abre a edição da última mensagem", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<MessageBubble message={msg({ external_id: "ABC", sent_at: new Date().toISOString() })}
        onEditar={vi.fn(async () => undefined)} />);
      await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
      await user.click(await screen.findByRole("menuitem", { name: "Editar mensagem" }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth", block: "nearest", inline: "nearest",
      }));
      expect(screen.getByRole("textbox", { name: "Editar mensagem" })).toHaveFocus();
      expect(screen.getByRole("button", { name: "Salvar" })).toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("não oferece editar mensagem antiga nem apagar mensagem recebida", async () => {
    const user = userEvent.setup();
    const onEditar = vi.fn(async () => undefined);
    const onApagar = vi.fn(async () => undefined);
    const { rerender } = render(<MessageBubble message={msg({ external_id: "ABC" })}
      onEditar={onEditar} onApagar={onApagar} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    expect(screen.queryByRole("menuitem", { name: "Editar mensagem" })).not.toBeInTheDocument();
    rerender(<MessageBubble message={msg({ external_id: "ABC", direction: "inbound" })}
      onEditar={onEditar} onApagar={onApagar} />);
    expect(screen.queryByRole("button", { name: "Opções da mensagem" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Apagar para todos" })).not.toBeInTheDocument();
  });

  it("mantém o texto apagado dentro da bolha do CRM sem mostrar o texto revogado pelo cliente", () => {
    const { rerender } = render(<MessageBubble message={msg({ revoked_at: "2026-09-24T11:00:00Z", body: "valor combinado" })} />);
    expect(screen.getByText("Esta mensagem foi apagada")).toBeInTheDocument();
    expect(screen.getByText("valor combinado")).toBeInTheDocument();
    expect(screen.getByText("Visível só aqui no CRM")).toBeInTheDocument();
    expect(screen.getByTestId("message-bubble").className).toContain("opacity-70");
    rerender(<MessageBubble message={msg({ direction: "inbound", revoked_at: "2026-09-24T11:00:00Z", body: "texto do cliente" })} />);
    expect(screen.queryByText("texto do cliente")).not.toBeInTheDocument();
  });

  it("põe o menu dentro da bolha sem ocupar uma coluna ao lado", () => {
    const { container } = render(<MessageBubble message={msg({ external_id: "ABC" })} onApagar={vi.fn(async () => undefined)} />);
    const bolha = screen.getByTestId("message-bubble");
    expect(bolha).toContainElement(screen.getByRole("button", { name: "Opções da mensagem" }));
    expect(container.firstElementChild?.children).toHaveLength(1);
  });
});

describe("MessageBubble — ocultação local de recebida", () => {
  it("oculta corpo e citação, com restauração disponível ao gestor", async () => {
    const user = userEvent.setup();
    const onOcultar = vi.fn(async () => undefined);
    const onRestaurar = vi.fn(async () => undefined);
    const recebida = msg({ direction: "inbound", body: "segredo do cliente" });
    const { rerender } = render(<MessageBubble message={recebida} onOcultar={onOcultar} onRestaurar={onRestaurar} />);
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Ocultar no CRM" }));
    expect(screen.getByText(/continua no WhatsApp do cliente/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Ocultar no CRM" }).at(-1)!);
    await waitFor(() => expect(onOcultar).toHaveBeenCalledOnce());
    rerender(<MessageBubble message={{ ...recebida, metadata: { crm_hidden_at: "2026-09-24T12:00:00Z" } }}
      onOcultar={onOcultar} onRestaurar={onRestaurar} />);
    expect(screen.queryByText("segredo do cliente")).not.toBeInTheDocument();
    expect(screen.getByText("Mensagem ocultada no CRM")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Restaurar no CRM" }));
    await waitFor(() => expect(onRestaurar).toHaveBeenCalledOnce());
  });
});

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

  it("em nome de (#1613) nomeia a PESSOA e a integração, em vez de 'Sistema'", () => {
    // O token é da organização, mas quem decidiu o envio foi uma pessoa no
    // outro sistema (#1613). Os nomes vêm GRAVADOS em
    // `metadata.sent_on_behalf` porque o balão não faz join: sem a coluna e
    // sem os nomes na linha, este caso não teria o que mostrar.
    render(
      <MessageBubble
        message={msg({
          sent_via: "system",
          sent_on_behalf_of_user_id: "pessoa-1",
          metadata: {
            sent_on_behalf: {
              user_id: "pessoa-1",
              user_name: "Fulano da Silva",
              token_name: "ERP Externo",
            },
          },
        })}
      />,
    );
    expect(screen.getByText("Fulano da Silva · via ERP Externo")).toBeInTheDocument();
    expect(screen.queryByText("Sistema")).not.toBeInTheDocument();
  });

  it("em nome de sem nome de token não promete a integração que não se sabe", () => {
    render(
      <MessageBubble
        message={msg({
          sent_via: "system",
          sent_on_behalf_of_user_id: "pessoa-1",
          metadata: { sent_on_behalf: { user_id: "pessoa-1", user_name: "Fulano", token_name: null } },
        })}
      />,
    );
    expect(screen.getByText("Fulano")).toBeInTheDocument();
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
describe("pino compartilhado pelo cliente", () => {
  it("vira cartão que abre o mapa, no lugar do link cru", () => {
    render(
      <MessageBubble
        message={msg({
          direction: "inbound",
          sent_via: "external_device",
          type: "location",
          body: "📍 https://maps.google.com/?q=-25.33,-57.54",
          metadata: { location: { latitude: -25.33, longitude: -57.54 } },
        })}
      />,
    );
    const link = screen.getByRole("link", { name: /Abrir no mapa/ });
    expect(link.getAttribute("href")).toBe("https://maps.google.com/?q=-25.33,-57.54");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByText("📍 https://maps.google.com/?q=-25.33,-57.54")).toBeNull();
  });

  it("sem coordenadas, o corpo aparece como sempre", () => {
    render(<MessageBubble message={msg({ direction: "inbound", type: "location", body: "📍 Location" })} />);
    expect(screen.getByText("📍 Location")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Abrir no mapa/ })).toBeNull();
  });
});
