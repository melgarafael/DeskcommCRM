/**
 * A MENÇÃO DA NOTA INTERNA IGNORA ACENTO (#4071) — uma regra, nos dois sentidos.
 *
 * ─── O defeito, medido na tela ──────────────────────────────────────────────
 *
 * Na nota interna, `@andreia` não achava a colega **Andréia**: o filtro de
 * `opcoesDeMencao` comparava `opcao.rotulo.toLowerCase().includes(q)`, e
 * `'andréia'.includes('andreia')` é falso — acento é OUTRA letra para
 * `String.includes`. Numa equipe com Andréia, Letícia e João a menção falhava
 * justo com quem tem acento no nome, e quem digita é o atendente, rápido.
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * 1. os dois sentidos: sem acento acha com acento, e com acento acha sem;
 * 2. caixa: `ANDREIA`, `Andreia` e `andreia` caem no mesmo lugar;
 * 3. o RÓTULO EXIBIDO continua exatamente como está cadastrado — a correção é
 *    na COMPARAÇÃO, nunca no texto que a pessoa lê (e é esse texto que vai
 *    gravado no corpo da nota, ver o comentário de `opcoesDeMencao`);
 * 4. o vazio devolve a lista inteira, na ordem, e o que não casa devolve nada;
 * 5. membro sem nome continua não sendo achável por pedaço de id (regra que já
 *    existia e que uma normalização larga demais poderia afrouxar).
 *
 * A regra é a do repo, não uma nova: `termoSemAcento` (`lib/inbox/termo-de-busca.ts`),
 * a mesma que o banco espelha em `f_unaccent` e que a busca do Inbox usa. Um
 * `normalize("NFD")` solto aqui viraria a quarta cópia da mesma conta.
 */
import { describe, expect, it } from "vitest";

import { opcoesDeMencao, type MembroDeMencao } from "@/components/inbox/composer/MentionMenu";

/** O `t` de mentira: a régua do rótulo só troca o literal de "sem nome". */
const t = (texto: string) => texto;

const EQUIPE: MembroDeMencao[] = [
  { user_id: "u-andreia", full_name: "Andréia Souza" },
  { user_id: "u-joao", full_name: "Joao Pereira" },
  { user_id: "u-leticia", full_name: "Letícia Lima" },
  { user_id: "u-sem-nome", full_name: null },
];

const ids = (query: string) => opcoesDeMencao(EQUIPE, query, t).map((o) => o.membro.user_id);

describe("#4071 — a menção casa sem acento, dos dois lados", () => {
  it("⭐ 'andreia' acha 'Andréia Souza' — e o rótulo sai COM acento", () => {
    const achados = opcoesDeMencao(EQUIPE, "andreia", t);

    expect(achados.map((o) => o.membro.user_id)).toEqual(["u-andreia"]);
    // O texto exibido (e gravado na nota) é o do cadastro: a normalização é da
    // comparação. Sem esta linha, "consertar" apagando o acento do rótulo
    // passaria nos casos de busca e estragaria a nota de todo mundo.
    expect(achados[0]!.rotulo).toBe("Andréia Souza");
  });

  it("⭐ 'Andréia' acha o membro cadastrado SEM acento ('Joao')", () => {
    const achados = opcoesDeMencao(EQUIPE, "joão", t);

    expect(achados.map((o) => o.membro.user_id)).toEqual(["u-joao"]);
    expect(achados[0]!.rotulo).toBe("Joao Pereira");
  });

  it("caixa e acento somados: 'ANDREIA' e 'ANDREIA' acham o mesmo membro", () => {
    expect(ids("ANDREIA")).toEqual(["u-andreia"]);
    expect(ids("Andreia")).toEqual(["u-andreia"]);
    expect(ids("ANDREIA")).toEqual(ids("andreia"));
  });

  it("a mesma lista responde igual às quatro grafias do mesmo nome", () => {
    const grafias = ["andreia", "Andréia", "ANDREIA", "ANDRÉIA"];
    for (const grafia of grafias) {
      expect(ids(grafia), `"${grafia}" não achou a Andréia`).toEqual(["u-andreia"]);
    }
  });

  it("acento em qualquer posição do nome: 'leticia' acha 'Letícia'", () => {
    expect(ids("leticia")).toEqual(["u-leticia"]);
  });

  it("consulta VAZIA devolve a equipe inteira, na ordem de chegada", () => {
    // O menu abre com a lista toda; um filtro acidental (ou uma normalização
    // que devolvesse `undefined`) deixaria a lista vazia na cara do atendente.
    expect(ids("")).toEqual(["u-andreia", "u-joao", "u-leticia", "u-sem-nome"]);
    expect(ids("   ")).toEqual(["u-andreia", "u-joao", "u-leticia", "u-sem-nome"]);
  });

  it("termo que não casa continua devolvendo VAZIO — não virou 'mostra tudo'", () => {
    expect(ids("zzz")).toEqual([]);
    expect(ids("andreiazzz")).toEqual([]);
  });

  it("a ORDEM é a da lista que chegou, não a do acerto", () => {
    // "ia" casa Andréia E Letícia (e só elas): a saída segue a ordem de EQUIPE,
    // e não a ordem em que o filtro encontrou cada uma.
    expect(ids("ia")).toEqual(["u-andreia", "u-leticia"]);
  });

  it("membro sem nome continua não sendo achado por pedaço de id", () => {
    // Regra declarada no comentário da função: o rótulo é o que se busca, e o
    // uuid não é nome de ninguém. Uma normalização larga demais não pode abrir
    // essa porta.
    expect(ids("u-sem-nome")).toEqual([]);
    expect(ids("sem-nome")).toEqual([]);
    // Ele aparece na lista sem filtro, e é isso que a tela mostra.
    expect(ids("").at(-1)).toBe("u-sem-nome");
  });
});
