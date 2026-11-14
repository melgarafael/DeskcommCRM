import { describe, expect, it } from "vitest";

import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/**
 * A DOBRA DE ACENTO DA RÉGUA ÚNICA (`lib/inbox/termo-de-busca.ts`).
 *
 * ─── O defeito que ela fecha ────────────────────────────────────────────────
 * `toLocaleLowerCase` dobra CAIXA e não ACENTO: `'Á'.toLowerCase()` devolve
 * `'á'`, que não é `'a'`. As buscas que rodam em MEMÓRIA no Inbox comparavam
 * com ela — a busca dentro da conversa (#4411) e a do seletor de etiquetas
 * (#4410) — e por isso `orcamento` não achava "Pode mandar o orçamento?" nem
 * "Orçamento enviado". No Brasil as duas grafias convivem, e quem digita
 * rápido é o atendente, sem acento.
 *
 * ─── O que este arquivo trava, e por que ele NÃO é um segundo normalizador ──
 * `termoSemAcento` já é a régua do repo desde a #3918 (a mesma que o
 * `f_unaccent` do Postgres espelha e que a coluna `busca_sem_acento` guarda).
 * Aqui só se mede o que ela promete sobre a matriz de letras que o português
 * usa de fato. Se alguém trocar a dobra por `toLowerCase` puro, os casos com
 * `ç`, `ã` e `á` ficam VERMELHOS — é o que impede a regressão silenciosa.
 *
 * `normalizarTermoDeBusca` NÃO é testada aqui: ela prepara o termo para o
 * PostgREST (`*` como curinga) e tem arquivo próprio. As duas compõem, não se
 * substituem.
 */
describe("termoSemAcento: a dobra de acento usada pela comparação em memória", () => {
  it("tira o acento e a caixa: 'Orçamento enviado' vira 'orcamento enviado'", () => {
    expect(termoSemAcento("Orçamento enviado")).toBe("orcamento enviado");
  });

  it("maiúscula sem acento também é dobrada", () => {
    expect(termoSemAcento("ORCAMENTO")).toBe("orcamento");
    expect(termoSemAcento("Pode mandar o ORÇAMENTO?")).toBe("pode mandar o orcamento?");
  });

  it("ç, ã e á caem para c, a e a", () => {
    expect(termoSemAcento("ç")).toBe("c");
    expect(termoSemAcento("ã")).toBe("a");
    expect(termoSemAcento("á")).toBe("a");
    expect(termoSemAcento("Coração Ação")).toBe("coracao acao");
  });

  it("com acento e sem acento dão o MESMO resultado", () => {
    expect(termoSemAcento("orçamento")).toBe(termoSemAcento("orcamento"));
    expect(termoSemAcento("Orçamento enviado")).toBe(termoSemAcento("orcamento enviado"));
  });

  it("string vazia continua vazia — o piso de busca não é burlado por aqui", () => {
    expect(termoSemAcento("")).toBe("");
  });

  it("as duas grafias se acham numa busca por `includes`, nos DOIS sentidos", () => {
    const etiqueta = termoSemAcento("Orçamento enviado");
    // Quem digita sem acento acha a etiqueta com acento…
    expect(etiqueta.includes(termoSemAcento("orcamento"))).toBe(true);
    // …e quem digita com acento continua achando (o caminho de antes não pode
    // ter sido perdido no conserto).
    expect(etiqueta.includes(termoSemAcento("orçamento"))).toBe(true);
    expect(termoSemAcento("Pode mandar o orçamento?").includes(termoSemAcento("orcamento"))).toBe(
      true,
    );
  });
});
