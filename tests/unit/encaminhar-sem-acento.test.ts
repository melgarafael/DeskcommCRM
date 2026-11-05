/**
 * A BUSCA DO "ENCAMINHAR" IGNORA ACENTO (#4072).
 *
 * ─── O defeito, medido na tela ──────────────────────────────────────────────
 *
 * Ao encaminhar uma mensagem, a janela oferece as conversas já carregadas e
 * filtra por nome. O filtro era `c.rotulo.toLowerCase().includes(termo)`, e
 * `'joão'.includes('joao')` é falso: quem digitava `joao` não achava **João** e
 * rolava a lista inteira. Acento é outra letra para `includes`; `toLowerCase`
 * só resolve caixa.
 *
 * ─── A regra é uma só, e já existe no repo ──────────────────────────────────
 *
 * `termoSemAcento` (`lib/inbox/termo-de-busca.ts`) — a mesma dos outros dois
 * pontos desta família (#4070 e #4071) e a mesma que o banco espelha em
 * `f_unaccent` (migration 9098, conferida por
 * `tests/invariants/busca-do-inbox-ignora-acento.test.ts`). A comparação
 * normaliza OS DOIS LADOS: quem digita com acento acha quem está sem, e quem
 * digita sem acha quem está com.
 *
 * ─── O que este arquivo também prende (os lados opostos) ────────────────────
 *
 * - o RÓTULO EXIBIDO continua o do cadastro, com acento — a correção é na
 *   comparação, nunca no texto que a pessoa lê;
 * - busca vazia devolve a lista inteira, na ordem, e a conversa atual continua
 *   fora dela (encaminhar para si mesma não existe);
 * - termo que não casa devolve vazio, e não a lista toda;
 * - a ordem e o "limite" (a lista que chegou) não mudam: o filtro não ordena,
 *   não fatia e não inventa destino.
 */
import { describe, expect, it } from "vitest";

import { destinosDoEncaminhamento } from "@/components/inbox/EncaminharDialog";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/** O `t` de mentira: só o literal de "sem nome" passaria por ele. */
const t = (texto: string) => texto;

function conversa(id: string, nome: string | null): ConversationWithContact {
  return { id, contacts: nome === null ? null : { display_name: nome } } as unknown as ConversationWithContact;
}

const CONVERSAS: ConversationWithContact[] = [
  conversa("c-joao", "João Pereira"),
  conversa("c-atual", "João Pereira"), // a conversa aberta: mesma pessoa, outro id
  conversa("c-ana", "Ana Lima"),
  conversa("c-orcamento", "Orçamento Condomínio"),
  conversa("c-sem-nome", null),
];

const ATUAL = "c-atual";

const destinos = (busca: string) =>
  destinosDoEncaminhamento(CONVERSAS, ATUAL, busca, t);

const ids = (busca: string) => destinos(busca).map((d) => d.id);

describe("#4072 — o encaminhar casa sem acento, dos dois lados", () => {
  it("⭐ 'joao' acha 'João Pereira' — e o rótulo sai COM acento", () => {
    const achados = destinos("joao");

    expect(achados.map((d) => d.id)).toEqual(["c-joao"]);
    // O que a tela mostra (e o atendente clica) é o nome do cadastro.
    expect(achados[0]!.rotulo).toBe("João Pereira");
  });

  it("⭐ 'joão' (com acento) acha o contato cadastrado SEM acento", () => {
    const semAcento = [conversa("c-x", "Joao Pereira")];

    const achados = destinosDoEncaminhamento(semAcento, null, "joão", t);

    expect(achados.map((d) => d.id)).toEqual(["c-x"]);
    // O rótulo exibido é o do cadastro — sem acento, porque é assim que está lá.
    expect(achados[0]!.rotulo).toBe("Joao Pereira");
  });

  it("caixa e acento somados: 'JOAO', 'Joao' e 'joao' devolvem o mesmo destino", () => {
    for (const grafia of ["joao", "Joao", "JOAO", "JOÃO", "João"]) {
      expect(ids(grafia), `"${grafia}" não achou o João`).toEqual(["c-joao"]);
    }
  });

  it("acento em outra posição e em palavra comum: 'orcamento' acha 'Orçamento Condomínio'", () => {
    expect(ids("orcamento")).toEqual(["c-orcamento"]);
    expect(ids("ORÇAMENTO")).toEqual(["c-orcamento"]);
    expect(ids("condominio")).toEqual(["c-orcamento"]);
  });

  it("a conversa ATUAL continua fora da lista, inclusive quando a busca casaria com ela", () => {
    // `c-atual` tem o MESMO nome do `c-joao`: se a exclusão se perdesse, o caso
    // acima devolveria dois destinos e o atendente encaminharia para si mesmo.
    expect(ids("joao")).toEqual(["c-joao"]);
    expect(ids("joao")).not.toContain(ATUAL);
  });

  it("busca VAZIA devolve todos os destinos, na ordem de chegada", () => {
    expect(ids("")).toEqual(["c-joao", "c-ana", "c-orcamento", "c-sem-nome"]);
    expect(ids("   ")).toEqual(["c-joao", "c-ana", "c-orcamento", "c-sem-nome"]);
  });

  it("termo que não casa devolve VAZIO — a busca não virou 'mostra tudo'", () => {
    expect(ids("zzz")).toEqual([]);
    expect(ids("joaozzz")).toEqual([]);
  });

  it("a ORDEM e o LIMITE são os da lista que chegou — o filtro não reordena nem fatia", () => {
    // "a" aparece em João, Ana e Orçamento — não em "Sem nome", que fica de
    // fora. A saída tem de seguir CONVERSAS (João antes de Ana, que não é
    // ordem alfabética), sem a conversa atual, e não pode ganhar nem perder
    // destino: quem corta a lista é a inbox, não esta função.
    expect(ids("a")).toEqual(["c-joao", "c-ana", "c-orcamento"]);
  });
});
