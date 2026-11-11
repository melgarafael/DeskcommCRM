import { beforeAll, describe, expect, it } from "vitest";

import {
  normalizarTermoDeBusca,
  termoSeguroParaOr,
  termoSemAcento,
} from "@/lib/inbox/termo-de-busca";

import { lastLine, sql } from "./gov-helpers";

/**
 * A BUSCA DE CONTATOS IGNORA ACENTO NO BANCO DE VERDADE (#3918, fatia 2).
 *
 * ─── O que este arquivo prova, e o que o teste de unidade não prova ──────────
 * `tests/unit/busca-de-contatos-sem-acento.test.ts` prova a FORMA do filtro que
 * o handler monta (a coluna, o termo limpo, a gramática do `or=`). Ele não prova
 * que o Postgres CASA, porque um dublê de Supabase não tem `unaccent`, nem
 * coluna gerada, nem índice. Aqui a asserção é a da issue: "Andreia" acha
 * "Andréia" — uma afirmação sobre o banco.
 *
 * As três portas da busca de contato (tela de Contatos, seletor e a ferramenta
 * do agente) usam a MESMA coluna gerada:
 *
 *   busca_sem_acento            = display_name + name + address_book_name (9098)
 *   busca_sem_acento_sem_agenda = display_name + name                   (9325)
 *
 * A segunda existe porque o nome da agenda do celular é rótulo interno da equipe
 * (#2439): a busca do agente DURANTE a conversa não pode casar nele.
 *
 * ─── O `%` e o `_` ───────────────────────────────────────────────────────────
 * `termoSeguroParaOr` os escapa, e o `LIKE` do Postgres os lê como literais.
 * Sem isso, `%` devolveria a organização inteira — e "a lista toda" se parece
 * com "a busca funcionou".
 */

const ORG_A = "39180000-0000-4000-8000-000000000101";
const ORG_B = "39180000-0000-4000-8000-000000000102";

type Contato = {
  id: string;
  org: string;
  display: string | null;
  nome: string | null;
  agenda: string | null;
};

const C = (
  sufixo: number,
  org: string,
  display: string | null,
  nome: string | null = null,
  agenda: string | null = null,
): Contato => ({
  id: `3918aaaa-4444-4000-8000-0000000000${String(sufixo).padStart(2, "0")}`,
  org,
  display,
  nome,
  agenda,
});

const CONTATOS: Contato[] = [
  C(1, ORG_A, "Andréia Souza"),
  C(2, ORG_A, null, "Letícia Lima"),
  C(3, ORG_A, "João Pereira"),
  C(4, ORG_A, "Conceição Alves"),
  C(5, ORG_A, "Júlia Ramos"),
  C(6, ORG_A, "Ana-Maria Silva"),
  C(7, ORG_A, "D'Avila Costa"),
  // Controle do `%` literal: sem o escape, buscar `%` devolveria a org inteira.
  C(8, ORG_A, "Maria 100% Certeza"),
  // Só o nome da agenda: alcançável pela coluna completa, INALCANÇÁVEL pela
  // coluna do agente (sem agenda).
  C(9, ORG_A, null, null, "Joaquim da Agenda"),
  // Outra organização — não pode aparecer na busca da ORG_A.
  C(10, ORG_B, "Andréia de Outra Org"),
  // Acento fora da tabela PT da régua antiga (#1835): `ñ` e `ü` não viravam
  // classe de grafia, então "Pena" não achava "Peña" e "Muller" não achava
  // "Müller" no `imatch`. A coluna do banco resolve por NFD, sem tabela.
  C(11, ORG_A, "Peña & Müller"),
];

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * O padrão como o handler o monta, traduzido do `or=` para SQL:
 * normaliza como a pessoa digita, escapa a gramática e o curinga, tira o acento,
 * e o `*` do PostgREST vira `%` do LIKE.
 */
function padraoDoHandler(termo: string): string {
  const s = termoSemAcento(termoSeguroParaOr(normalizarTermoDeBusca(termo)));
  return `%${s.replace(/\*/g, "%")}%`;
}

/** Ids da organização que casam o termo, na coluna indicada. */
function achar(
  termo: string,
  coluna: "busca_sem_acento" | "busca_sem_acento_sem_agenda" = "busca_sem_acento",
  org = ORG_A,
): string[] {
  const out = sql(`
    select 'C:' || id
      from public.contacts
     where organization_id = ${lit(org)}
       and is_anonymized = false
       and ${coluna} like ${lit(padraoDoHandler(termo))}
     order by id;
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("C:"))
    .map((l) => l.slice(2));
}

const id = (n: number) => CONTATOS[n - 1]!.id;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values (${lit(ORG_A)}, 'busca-contatos-3918-a', 'Contatos A', 'Contatos A'),
             (${lit(ORG_B)}, 'busca-contatos-3918-b', 'Contatos B', 'Contatos B')
      on conflict (id) do nothing;
  `);
  for (const c of CONTATOS) {
    sql(`
      insert into public.contacts (id, organization_id, display_name, name, address_book_name)
        values (${lit(c.id)}, ${lit(c.org)},
                ${c.display === null ? "null" : lit(c.display)},
                ${c.nome === null ? "null" : lit(c.nome)},
                ${c.agenda === null ? "null" : lit(c.agenda)})
        on conflict (id) do update
          set display_name = excluded.display_name,
              name = excluded.name,
              address_book_name = excluded.address_book_name,
              is_anonymized = false;
    `);
  }
});

describe("busca de contatos sem acento — o banco", () => {
  it("as duas colunas existem e são GERADAS", () => {
    const estado = sql(`
      select column_name || ':' || is_generated
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'contacts'
         and column_name in ('busca_sem_acento', 'busca_sem_acento_sem_agenda')
       order by column_name;
    `);
    expect(estado.split("\n")).toEqual([
      "busca_sem_acento:ALWAYS",
      "busca_sem_acento_sem_agenda:ALWAYS",
    ]);
  });

  it("a coluna do agente não carrega o nome da agenda; a da lista carrega", () => {
    // O elo que a 9325 acrescenta: `busca_sem_acento` inclui a agenda (#2439),
    // e é por isso que ela NÃO pode ser a coluna do turno. Se a segunda coluna
    // passasse a incluir a agenda, este caso reprova — e o vazamento volta.
    expect(achar("joaquim")).toEqual([id(9)]);
    expect(achar("joaquim", "busca_sem_acento_sem_agenda")).toEqual([]);
    // O nome próprio continua alcançável nas duas.
    expect(achar("andreia", "busca_sem_acento_sem_agenda")).toEqual([id(1)]);
  });

  it("os pares do relato casam nos DOIS sentidos", () => {
    expect(achar("Andreia")).toEqual([id(1)]);
    expect(achar("Andréia")).toEqual([id(1)]);

    expect(achar("Leticia")).toEqual([id(2)]);
    expect(achar("Letícia")).toEqual([id(2)]);

    expect(achar("Joao")).toEqual([id(3)]);
    expect(achar("João")).toEqual([id(3)]);

    expect(achar("Conceicao")).toEqual([id(4)]);
    expect(achar("Conceição")).toEqual([id(4)]);

    expect(achar("Julia")).toEqual([id(5)]);
    expect(achar("Júlia")).toEqual([id(5)]);
  });

  it("caixa continua indiferente", () => {
    expect(achar("ANDREIA")).toEqual([id(1)]);
    expect(achar("aNdRéIa")).toEqual([id(1)]);
  });

  it("acento fora do português casa — 'Pena' acha 'Peña', 'Muller' acha 'Müller'", () => {
    // Era o limite da régua em regex da #1835: `ñ` e `ü` não estavam na tabela
    // de grafias, então esses nomes só apareciam com o acento digitado igual.
    expect(achar("Pena")).toEqual([id(11)]);
    expect(achar("Muller")).toEqual([id(11)]);
  });

  it("hífen e apóstrofo funcionam", () => {
    expect(achar("Ana-Maria")).toEqual([id(6)]);
    expect(achar("ana maria")).toEqual([id(6)]);
    expect(achar("D'Avila")).toEqual([id(7)]);
  });

  it("não vira 'acha tudo': termo sem relação continua vazio", () => {
    expect(achar("Zebedeu")).toEqual([]);
    expect(achar("Andreia Josefina")).toEqual([]);
  });

  it("a organização continua presa — o mesmo termo não alcança outro tenant", () => {
    expect(achar("Andreia", "busca_sem_acento", ORG_A)).toEqual([id(1)]);
    expect(achar("Andreia", "busca_sem_acento", ORG_B)).toEqual([id(10)]);
  });

  it("o `%` e o `_` digitados são literais, não curinga", () => {
    expect(achar("%"), "o `%` virou curinga: a busca passou a casar tudo").toEqual([id(8)]);
    expect(achar("_")).toEqual([]);
    expect(achar("maria 100%")).toEqual([id(8)]);
  });

  it("o índice de trigrama serve a consulta da coluna completa", () => {
    // `enable_seqscan = off` dentro de transação: existir não basta, o plano
    // tem de alcançar o índice (mesma técnica do invariante do inbox).
    const plano = sql(`
      begin;
      set local enable_seqscan = off;
      explain (costs off) select id from public.contacts where busca_sem_acento like '%andreia%';
      rollback;
    `);
    expect(plano, "o índice existe mas o plano não o alcança").toContain(
      "idx_contacts_busca_sem_acento_trgm",
    );
  });

  it("a coluna do agente NÃO tem índice — e o custo disso está declarado", () => {
    // A consulta que a usa vem sempre presa a um `id` (o contato do turno),
    // então o Postgres avalia UMA linha; um GIN de trigrama aí custaria escrita
    // em todo insert/update de contato sem servir leitura nenhuma. Se alguém
    // acrescentar índice, este caso obriga a atualizar a justificativa no PR.
    const indices = sql(`
      select count(*) from pg_indexes
       where schemaname = 'public'
         and tablename = 'contacts'
         and indexdef like '%busca_sem_acento_sem_agenda%';
    `);
    expect(lastLine(indices)).toBe("0");
  });
});
