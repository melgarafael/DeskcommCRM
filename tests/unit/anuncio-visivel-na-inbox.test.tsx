/**
 * O anúncio que trouxe a pessoa aparece na inbox: na bolha da mensagem nascida
 * do clique e no painel ao lado.
 *
 * Pedido de uma operação real: "quando um cliente vem de um anúncio, que esse
 * anúncio apareça na conversa e ao lado, para saber por qual anúncio da Meta ele
 * veio". O dado do contato já existia (`source_metadata.ad_*`, que só a ficha do
 * contato mostrava); o da mensagem (`metadata.anuncio`) passa a ser gravado pela
 * ingestão — ver `mensagem-guarda-o-seu-anuncio.test.ts`.
 *
 * Os endereços vêm de fora (o payload do anúncio) e vão parar em `href`/`src`:
 * por isso o filtro `https:` é medido aqui nos dois leitores.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import {
  lerAnuncioDaMensagem,
  lerAnuncioDoContato,
  metadataDoAnuncio,
  urlSegura,
  type AtribuicaoDeAnuncio,
} from "@/lib/leads/atribuicao-de-anuncio";
import type { Message } from "@/lib/types/messaging";

const atribuicao = (over: Partial<AtribuicaoDeAnuncio> = {}): AtribuicaoDeAnuncio => ({
  plataforma: "meta_ads",
  sourceId: "clique-1",
  adId: "120200000000000001",
  titulo: "FRETE GRÁTIS",
  corpo: "Lavadora de alta pressão. Pague na entrega.",
  sourceUrl: "https://fb.me/lavadora",
  miniatura: "https://scontent.example.fbcdn.net/lavadora.jpg",
  bruto: {},
  ...over,
});

describe("urlSegura — só https chega a href/src da inbox", () => {
  it.each([
    ["https://fb.me/lavadora", "https://fb.me/lavadora"],
    ["http://fb.me/lavadora", null],
    ["javascript:alert(1)", null],
    ["data:text/html,<b>x</b>", null],
    ["não é url", null],
    ["", null],
    [42, null],
  ])("%s → %s", (entrada, esperado) => {
    expect(urlSegura(entrada)).toBe(esperado);
  });
});

describe("metadataDoAnuncio — a mensagem guarda o link e a imagem, não o clique", () => {
  it("título, texto, id, link e miniatura", () => {
    expect(metadataDoAnuncio(atribuicao())).toEqual({
      anuncio: {
        titulo: "FRETE GRÁTIS",
        texto: "Lavadora de alta pressão. Pague na entrega.",
        ad_id: "120200000000000001",
        url: "https://fb.me/lavadora",
        miniatura: "https://scontent.example.fbcdn.net/lavadora.jpg",
      },
    });
  });

  it("endereço que não é https não é gravado", () => {
    const { anuncio } = metadataDoAnuncio(atribuicao({ sourceUrl: "javascript:alert(1)", miniatura: "http://x/y.jpg" }));
    expect(anuncio).toEqual({
      titulo: "FRETE GRÁTIS",
      texto: "Lavadora de alta pressão. Pague na entrega.",
      ad_id: "120200000000000001",
    });
  });

  it("lerAnuncioDaMensagem devolve os endereços só se forem https", () => {
    expect(lerAnuncioDaMensagem({ titulo: "T", url: "javascript:x", miniatura: "https://a/b.jpg" })).toEqual({
      titulo: "T",
      texto: null,
      ad_id: null,
      url: null,
      miniatura: "https://a/b.jpg",
    });
  });
});

describe("lerAnuncioDoContato — o primeiro toque, como a inbox o mostra", () => {
  const carimbado = {
    ad_platform: "meta_ads",
    ad_id: "120200000000000001",
    ad_title: "FRETE GRÁTIS",
    ad_body: "Lavadora de alta pressão.",
    ad_source_url: "https://fb.me/lavadora",
    ad_captured_at: "2026-10-12T13:42:00.000Z",
  };

  it("contato carimbado a partir desta versão: a miniatura vem de ad_thumbnail_url", () => {
    expect(lerAnuncioDoContato({ ...carimbado, ad_thumbnail_url: "https://cdn.example/nova.jpg" })).toEqual({
      titulo: "FRETE GRÁTIS",
      texto: "Lavadora de alta pressão.",
      ad_id: "120200000000000001",
      url: "https://fb.me/lavadora",
      miniatura: "https://cdn.example/nova.jpg",
      capturado_em: "2026-10-12T13:42:00.000Z",
    });
  });

  it("contato carimbado antes: a miniatura sai do payload cru, nas duas formas", () => {
    expect(lerAnuncioDoContato({ ...carimbado, ad_raw: { thumbnail_url: "https://cdn.example/oficial.jpg" } })?.miniatura).toBe(
      "https://cdn.example/oficial.jpg",
    );
    expect(lerAnuncioDoContato({ ...carimbado, ad_raw: { thumbnailUrl: "https://cdn.example/qr.jpg" } })?.miniatura).toBe(
      "https://cdn.example/qr.jpg",
    );
  });

  it("sem plataforma não há anúncio (contato que não veio de clique)", () => {
    expect(lerAnuncioDoContato({ waha_chat_id: "x", notify_name: "y" })).toBeNull();
    expect(lerAnuncioDoContato(null)).toBeNull();
    expect(lerAnuncioDoContato("lixo")).toBeNull();
  });

  it("clique do Google (só o gclid, sem peça criativa): sem cartão — o rótulo do cartão é da Meta", () => {
    // A forma que `extrairEEstamparAtribuicaoGoogle` carimba: plataforma e
    // clique, sem id, título, texto nem link.
    expect(
      lerAnuncioDoContato({
        ad_platform: "google_ads",
        ad_source_id: "gclid-1",
        ad_id: null,
        ad_title: null,
        ad_body: null,
        ad_source_url: null,
        ad_thumbnail_url: null,
        ad_raw: { token: "ABC123", click_identifiers: { gclid: "gclid-1" } },
        ad_captured_at: "2026-10-12T13:42:00.000Z",
      }),
    ).toBeNull();
  });

  it("link perigoso some, o resto fica", () => {
    const a = lerAnuncioDoContato({ ...carimbado, ad_source_url: "javascript:alert(1)" });
    expect(a?.url).toBeNull();
    expect(a?.titulo).toBe("FRETE GRÁTIS");
  });
});

function mensagem(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "received",
    ack: null,
    error_code: null,
    error_message: null,
    body: "Qual é o preço?",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: "2026-10-12T13:42:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    created_at: "2026-10-12T13:42:00.000Z",
    updated_at: "2026-10-12T13:42:00.000Z",
    ...over,
  } as Message;
}

describe("a bolha da mensagem nascida do clique mostra o anúncio", () => {
  it("título, texto, imagem e link no topo da bolha, acima do texto do cliente", () => {
    render(<MessageBubble message={mensagem({ metadata: metadataDoAnuncio(atribuicao()) })} />);
    const cartao = screen.getByTestId("anuncio-card");
    expect(cartao).toHaveTextContent("FRETE GRÁTIS");
    expect(cartao).toHaveTextContent("Lavadora de alta pressão. Pague na entrega.");
    expect(screen.getByRole("link", { name: /Ver anúncio/ })).toHaveAttribute("href", "https://fb.me/lavadora");
    expect(cartao.querySelector("img")).toHaveAttribute("src", "https://scontent.example.fbcdn.net/lavadora.jpg");
    // Acima do que o cliente escreveu, como o WhatsApp mostra no celular.
    const texto = screen.getByText("Qual é o preço?");
    expect(cartao.compareDocumentPosition(texto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("mensagem antiga (só título e texto) mostra o cartão sem link nem imagem", () => {
    render(
      <MessageBubble
        message={mensagem({ metadata: { anuncio: { titulo: "ENTREGA RÁPIDA", texto: "Protetor solar.", ad_id: "1" } } })}
      />,
    );
    expect(screen.getByTestId("anuncio-card")).toHaveTextContent("ENTREGA RÁPIDA");
    expect(screen.queryByRole("link", { name: /Ver anúncio/ })).toBeNull();
    expect(screen.getByTestId("anuncio-card").querySelector("img")).toBeNull();
  });

  it("mensagem sem anúncio e mensagem ENVIADA não mostram cartão", () => {
    const { unmount } = render(<MessageBubble message={mensagem()} />);
    expect(screen.queryByTestId("anuncio-card")).toBeNull();
    unmount();
    render(
      <MessageBubble
        message={mensagem({ direction: "outbound", sent_via: "ai", metadata: metadataDoAnuncio(atribuicao()) })}
      />,
    );
    expect(screen.queryByTestId("anuncio-card")).toBeNull();
  });
});
