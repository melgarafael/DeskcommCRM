import { describe, expect, it } from "vitest";

import {
  MAXIMO_DE_PALAVRAS,
  MAXIMO_DE_POSTS,
  comentarioCasa,
  configDoComentario,
} from "./gatilho-do-comentario";

/**
 * A régua do gatilho (#4075) — a mesma normalização das condições.
 *
 * O que estes casos protegem é o que o operador chama de "não funcionou":
 * a palavra escrita com acento na tela e sem acento no comentário (ou o
 * contrário), e o campo vazio que, se casasse, responderia TODO comentário do
 * perfil — inclusive o de quem está reclamando.
 */

const config = (posts: string[], palavras: string[]) => ({ posts, palavras });

describe("configDoComentario", () => {
  it("lê a configuração gravada", () => {
    expect(configDoComentario({ posts: ["post-1"], palavras: ["QUERO", "link"] })).toEqual({
      posts: ["post-1"],
      palavras: ["QUERO", "link"],
    });
  });

  it("posts são opcionais — ausentes significam QUALQUER post", () => {
    expect(configDoComentario({ palavras: ["QUERO"] })).toEqual({ posts: [], palavras: ["QUERO"] });
  });

  it("recusa configuração sem palavra: sem palavra não há gatilho", () => {
    expect(configDoComentario({})).toBeNull();
    expect(configDoComentario({ posts: ["post-1"], palavras: [] })).toBeNull();
    expect(configDoComentario({ palavras: ["   "] })).toBeNull();
    expect(configDoComentario({ palavras: "QUERO" })).toBeNull();
  });

  it("recusa lista acima do teto e item acima do tamanho", () => {
    const muitas = Array.from({ length: MAXIMO_DE_PALAVRAS + 1 }, (_, i) => `p${i}`);
    expect(configDoComentario({ palavras: muitas })).toBeNull();

    const muitosPosts = Array.from({ length: MAXIMO_DE_POSTS + 1 }, (_, i) => `post-${i}`);
    expect(configDoComentario({ posts: muitosPosts, palavras: ["QUERO"] })).toBeNull();

    expect(configDoComentario({ palavras: ["a".repeat(81)] })).toBeNull();
  });

  it("recusa payload que não é objeto", () => {
    expect(configDoComentario(null)).toBeNull();
    expect(configDoComentario([])).toBeNull();
    expect(configDoComentario("QUERO")).toBeNull();
  });

  it("tira repetição preservando a ordem escrita", () => {
    expect(configDoComentario({ palavras: ["link", "QUERO", "link"] })?.palavras).toEqual([
      "link",
      "QUERO",
    ]);
  });
});

describe("comentarioCasa", () => {
  it("casa a palavra no meio do texto", () => {
    expect(comentarioCasa(config([], ["QUERO"]), { post_id: "post-1", text: "eu quero sim" })).toBe(
      true,
    );
  });

  it("acento e caixa NÃO importam — a régua do `contains` (#2973)", () => {
    const acao = config([], ["Ação"]);

    expect(comentarioCasa(acao, { post_id: "post-1", text: "quero a ACAO" })).toBe(true);
    expect(comentarioCasa(acao, { post_id: "post-1", text: "quero a ação" })).toBe(true);
    expect(comentarioCasa(config([], ["preço"]), { post_id: "post-1", text: "qual o PRECO?" })).toBe(
      true,
    );
    expect(
      comentarioCasa(config([], ["orçamento"]), { post_id: "post-1", text: "manda o orcamento" }),
    ).toBe(true);
  });

  it("não casa quando o texto não tem a palavra", () => {
    expect(
      comentarioCasa(config([], ["QUERO"]), { post_id: "post-1", text: "que post lindo" }),
    ).toBe(false);
  });

  it("posts vazios valem para qualquer post; posts escolhidos recortam", () => {
    expect(comentarioCasa(config([], ["QUERO"]), { post_id: "qualquer", text: "QUERO" })).toBe(true);

    const soNumPost = config(["post-1"], ["QUERO"]);
    expect(comentarioCasa(soNumPost, { post_id: "post-1", text: "QUERO" })).toBe(true);
    expect(comentarioCasa(soNumPost, { post_id: "post-2", text: "QUERO" })).toBe(false);
  });

  it("uma palavra ilegível não vira 'casa tudo'", () => {
    // `normalizarParaContains("!!!")` sai vazio, e `includes("")` casaria
    // qualquer texto — a mesma armadilha que o `formaDaRegra` fecha.
    expect(comentarioCasa(config([], ["!!!"]), { post_id: "post-1", text: "oi" })).toBe(false);
    expect(comentarioCasa(config([], ["!!!", "QUERO"]), { post_id: "post-1", text: "oi" })).toBe(
      false,
    );
  });

  it("texto vazio ou ausente não casa", () => {
    expect(comentarioCasa(config([], ["QUERO"]), { post_id: "post-1", text: "" })).toBe(false);
    expect(comentarioCasa(config([], ["QUERO"]), { post_id: "post-1" })).toBe(false);
  });

  it("comentário sem post não casa — o recorte precisa saber de onde veio", () => {
    expect(comentarioCasa(config([], ["QUERO"]), { text: "QUERO" })).toBe(false);
  });

  it("configuração ilegível não casa NADA (o lado seguro)", () => {
    expect(comentarioCasa(null, { post_id: "post-1", text: "QUERO" })).toBe(false);
    expect(comentarioCasa(config([], []), { post_id: "post-1", text: "QUERO" })).toBe(false);
    expect(comentarioCasa(config([], ["QUERO"]), null)).toBe(false);
  });
});
