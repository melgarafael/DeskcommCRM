/**
 * O SCHEMA DA VERSÃO GUARDA O FILTRO POR ETIQUETA — e não inventa nada.
 *
 * É o schema da rota PATCH /versions/[vid], por onde a tela salva. Sem o campo
 * declarado o Zod o descartaria em silêncio e o filtro nunca ligaria pela tela
 * (o mesmo defeito que o aviso de fora do horário teve). E sem `default`: uma
 * chave completada pelo servidor trava o botão Publicar (`mesmo-rascunho.ts`).
 */
import { describe, expect, it } from "vitest";

import { lerFiltroDeEtiquetas } from "@/lib/agent-engine/agent/filtro-de-etiquetas";
import { versionPatchSchema } from "@/lib/ai/agents/validation";

describe("o schema da versão guarda o filtro por etiqueta", () => {
  it("preserva as duas listas e grava normalizado", () => {
    const parsed = versionPatchSchema.safeParse({
      trigger_config: {
        filters: { contact_tags_include: [" Cliente ", "cliente"], contact_tags_exclude: ["VIP"] },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.trigger_config?.filters).toMatchObject({
      contact_tags_include: ["cliente"],
      contact_tags_exclude: ["vip"],
    });
    expect(lerFiltroDeEtiquetas(parsed.data?.trigger_config)).toEqual({ incluir: ["cliente"], excluir: ["vip"] });
  });

  it("não inventa as chaves quando a tela não mandou (senão o Publicar trava)", () => {
    const parsed = versionPatchSchema.safeParse({ trigger_config: { filters: { ignore_groups: true } } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.trigger_config?.filters).not.toHaveProperty("contact_tags_include");
    expect(parsed.data?.trigger_config?.filters).not.toHaveProperty("contact_tags_exclude");
  });

  it("recusa mais de 20 etiquetas numa lista", () => {
    const muitas = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const parsed = versionPatchSchema.safeParse({ trigger_config: { filters: { contact_tags_include: muitas } } });
    expect(parsed.success).toBe(false);
  });
});
