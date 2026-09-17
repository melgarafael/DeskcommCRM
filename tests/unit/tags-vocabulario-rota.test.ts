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

  it("renomear para o MESMO nome, mesmo com outra caixa, é destino_igual_a_tag", () => {
    // A função de banco devolveria `alterou: false` e a tela diria "nada mudou"
    // sem explicar por quê.
    expect(recusa({ acao: "renomear", tag: "VIP", destino: "vip" })).toBe("destino_igual_a_tag");
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
