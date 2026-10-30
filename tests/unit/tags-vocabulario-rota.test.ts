/**
 * O CONTRATO DA ROTA DE VOCABULÁRIO DE ETIQUETAS — executado, não lido.
 *
 * `tests/unit/tags-vocabulario.test.ts` vigia TEXTO-FONTE: os 12 casos leem o
 * `.sql`, o `route.ts` e o `catalogo.ts` com regex e conferem que certas strings
 * existem e em que ordem aparecem. Nenhum deles executa a rota, o schema ou a
 * tela — todo o COMPORTAMENTO mora no arquivo de invariante, que só roda sob
 * Docker (`pnpm test:db`).
 *
 * A medida da assimetria, feita na triagem: apagar
 * `and c.organization_id = p_org` do laço de contatos da migration 0264 — o
 * vazamento entre inquilinos clássico — deixa `tags-vocabulario.test.ts` com
 * 12 passed, ZERO vermelhos, porque nenhum dos 12 lê esse predicado. O que este
 * arquivo fecha é a parte que não precisa de banco nenhum: as bordas do schema
 * que a rota usa para recusar antes de chamar a função.
 */
import { describe, expect, it } from "vitest";

import { vocabularioDeTagsSchema } from "@/lib/schemas/tags";

/** A mensagem da primeira recusa — é ela que a rota devolve em `details`. */
const recusa = (entrada: unknown): string | null => {
  const r = vocabularioDeTagsSchema.safeParse(entrada);
  if (r.success) return null;
  return r.error.issues[0]?.message ?? "";
};

describe("vocabularioDeTagsSchema — o que a rota recusa antes de tocar o banco", () => {
  it("renomear sem destino é recusado como destino_obrigatorio", () => {
    expect(recusa({ acao: "renomear", tag: "a" })).toBe("destino_obrigatorio");
  });

  it("juntar sem destino também — juntar em nada não é operação", () => {
    expect(recusa({ acao: "juntar", tag: "a" })).toBe("destino_obrigatorio");
  });

  it("renomear para o nome exatamente igual, depois de aparar, é destino_igual_a_tag", () => {
    expect(recusa({ acao: "renomear", tag: " VIP ", destino: "VIP" })).toBe("destino_igual_a_tag");
  });

  it.each([
    ["vip", "VIP"],
    ["Prospecção", "prospecção"],
  ])("renomear %s para %s preserva a grafia pedida para a operação", (tag, destino) => {
    expect(vocabularioDeTagsSchema.parse({ acao: "renomear", tag, destino })).toEqual({
      acao: "renomear", tag, destino,
    });
  });

  it("juntar 'vip' em 'VIP' PASSA — é o caso que existe para desduplicar grafia", () => {
    // Controle positivo do caso acima: sem ele, "recusa tudo que difere só na
    // caixa" ficaria verde e a ação central de juntar estaria morta.
    expect(vocabularioDeTagsSchema.safeParse({ acao: "juntar", tag: "vip", destino: "VIP" }).success).toBe(true);
  });

  it("excluir não pede destino", () => {
    expect(vocabularioDeTagsSchema.safeParse({ acao: "excluir", tag: "a" }).success).toBe(true);
  });

  it("ação fora das três é acao_invalida", () => {
    expect(recusa({ acao: "apagar", tag: "a" })).toBe("acao_invalida");
  });

  it("etiqueta vazia ou só de espaço é tag_obrigatoria", () => {
    expect(recusa({ acao: "excluir", tag: "" })).toBe("tag_obrigatoria");
    expect(recusa({ acao: "excluir", tag: "   " })).toBe("tag_obrigatoria");
  });

  it("etiqueta acima do teto do seletor do Inbox é recusada", () => {
    // 60 é o mesmo teto de `conversationTagSchema`: um nome que cabe no
    // vocabulário e não cabe no seletor seria criado e nunca oferecido.
    expect(recusa({ acao: "excluir", tag: "x".repeat(61) })).toBe("tag_longa_demais");
    expect(vocabularioDeTagsSchema.safeParse({ acao: "excluir", tag: "x".repeat(60) }).success).toBe(true);
  });
});

describe("vocabularioDeTagsSchema — a cor (issue #1271, fatia S6)", () => {
  /** O que o schema devolve depois de normalizar. */
  const normalizado = (entrada: unknown) => vocabularioDeTagsSchema.parse(entrada) as {
    cor?: string | null;
  };

  it("definir_cor sem o campo `cor` é cor_obrigatoria", () => {
    // Ausente ≠ nulo: nulo é "limpe a cor". Sem o campo não dá para distinguir
    // "limpe" de "esqueci de mandar", e a operação reportaria alteração à toa.
    expect(recusa({ acao: "definir_cor", tag: "vip" })).toBe("cor_obrigatoria");
  });

  it("definir_cor com `cor: null` PASSA — é o pedido de tirar a cor", () => {
    expect(vocabularioDeTagsSchema.safeParse({ acao: "definir_cor", tag: "vip", cor: null }).success).toBe(true);
  });

  it("a cor entra normalizada: `#ABC`, sem cerquilha e com espaço viram `#aabbcc`", () => {
    for (const bruto of ["#AABBCC", "aabbcc", " #aabbcc "]) {
      expect(normalizado({ acao: "definir_cor", tag: "vip", cor: bruto }).cor).toBe("#aabbcc");
    }
    // Forma curta também: a leitura precisa tolerar o que já estiver gravado à
    // mão em `settings.tags`, e é a MESMA função que normaliza os dois lados.
    expect(normalizado({ acao: "definir_cor", tag: "vip", cor: "#f0a" }).cor).toBe("#ff00aa");
  });

  it("cor malformada é cor_invalida — nome, 5 dígitos, caractere fora de hex", () => {
    for (const ruim of ["verde", "#12345", "#zzzzzz", "rgb(0,0,0)", "#0091ff;"]) {
      expect(recusa({ acao: "definir_cor", tag: "vip", cor: ruim }), ruim).toBe("cor_invalida");
    }
  });

  it("definir_cor não renomeia: destino junto é destino_invalido_para_acao", () => {
    // Aceitar um destino aqui faria a tela prometer duas coisas e a função fazer
    // uma — e o nome entraria no vocabulário pela porta da cor.
    expect(recusa({ acao: "definir_cor", tag: "vip", destino: "VIP", cor: "#0091ff" })).toBe(
      "destino_invalido_para_acao",
    );
  });

  it("as ações que falam de NOME recusam cor junto (cor_invalida_para_acao)", () => {
    // Ignorar em silêncio deixaria a tela acreditar que mandou cor na renomeação.
    for (const acao of ["renomear", "juntar", "excluir"]) {
      expect(
        recusa({ acao, tag: "vip", destino: acao === "excluir" ? undefined : "VIP", cor: "#0091ff" }),
        acao,
      ).toBe("cor_invalida_para_acao");
    }
  });

  it("a ação nova não abriu a porta para as ações inexistentes", () => {
    expect(recusa({ acao: "definir_corzinha", tag: "vip", cor: "#0091ff" })).toBe("acao_invalida");
  });
});
