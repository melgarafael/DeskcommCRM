import { describe, expect, it } from "vitest";

import { EVENTO_DE_COMENTARIO, parseZernioComment } from "./comentario";

/**
 * O leitor do comentário, sozinho — sem banco, sem rota (#4075).
 *
 * O caso que importa aqui é o DESCARTE: um payload que não é comentário (de
 * mensagem, de outra rede, sem id) tem que devolver `null` em vez de virar uma
 * linha torta. E o casamento tem que ser ESTRITO no nome do evento: aceitar
 * "qualquer coisa com `comment` dentro" gravaria o comentário de um evento que
 * o provedor ainda não documentou como comentário.
 */

const doComentario = (over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) => ({
  event: EVENTO_DE_COMENTARIO,
  account: { id: "conta-1", platform: "instagram" },
  comment: {
    id: "comentario-1",
    postId: "post-1",
    platform: "instagram",
    text: "QUERO o link",
    from: { id: "autor-1", username: "cliente", name: "Cliente" },
    createdAt: "2026-11-05T12:00:00.000Z",
    ...comment,
  },
  ...over,
});

describe("parseZernioComment", () => {
  it("lê o comentário do Instagram na forma do provedor", () => {
    expect(parseZernioComment(doComentario())).toEqual({
      externalId: "comentario-1",
      postId: "post-1",
      platform: "instagram",
      text: "QUERO o link",
      authorId: "autor-1",
      authorUsername: "cliente",
      authorName: "Cliente",
      accountId: "conta-1",
      createdAt: "2026-11-05T12:00:00.000Z",
      fromSelf: false,
    });
  });

  it("aceita as grafias da Meta para post, texto e autor", () => {
    const lido = parseZernioComment(
      doComentario({}, {
        postId: undefined,
        post_id: "post-da-meta",
        text: undefined,
        content: "achado",
        from: undefined,
        author: { id: "autor-meta", username: "meta_user" },
      }),
    );

    expect(lido).toMatchObject({
      postId: "post-da-meta",
      text: "achado",
      authorId: "autor-meta",
      authorUsername: "meta_user",
    });
  });

  it("marca como do PRÓPRIO perfil quando o autor é a conta conectada", () => {
    const lido = parseZernioComment(
      doComentario(
        { account: { id: "conta-1", platform: "instagram", selfId: "perfil-1" } },
        { from: { id: "perfil-1", username: "loja" } },
      ),
    );

    expect(lido?.fromSelf).toBe(true);
  });

  it("respeita o `isSelf` que o provedor mandar", () => {
    const lido = parseZernioComment(
      doComentario({}, { from: { id: "outro", username: "outro", isSelf: true } }),
    );

    expect(lido?.fromSelf).toBe(true);
  });

  it("texto vazio continua sendo comentário — só não casa palavra nenhuma", () => {
    const lido = parseZernioComment(doComentario({}, { text: "   " }));

    expect(lido?.text).toBe("");
  });

  it("devolve null para evento que NÃO é comentário", () => {
    expect(parseZernioComment(doComentario({ event: "message.received" }))).toBeNull();
    expect(parseZernioComment(doComentario({ event: "comment" }))).toBeNull();
    expect(parseZernioComment(doComentario({ event: undefined }))).toBeNull();
  });

  it("devolve null para comentário de outra rede", () => {
    expect(
      parseZernioComment(
        doComentario({ account: { id: "conta-1", platform: "facebook" } }, { platform: "facebook" }),
      ),
    ).toBeNull();
  });

  it("devolve null sem o que identifica o comentário", () => {
    expect(parseZernioComment(doComentario({}, { id: undefined }))).toBeNull();
    expect(parseZernioComment(doComentario({}, { postId: undefined }))).toBeNull();
    expect(parseZernioComment(doComentario({}, { from: undefined }))).toBeNull();
    expect(parseZernioComment(doComentario({ comment: undefined }))).toBeNull();
  });

  it("devolve null para payload que nem objeto é", () => {
    expect(parseZernioComment(null)).toBeNull();
    expect(parseZernioComment("comment.created")).toBeNull();
    expect(parseZernioComment([])).toBeNull();
  });
});
