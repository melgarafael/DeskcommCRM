/**
 * O NASCIMENTO (issue #1546): a fila de proposta passa a aceitar `birthdate`.
 *
 * São DUAS as fronteiras que este arquivo confere, porque as duas já
 * divergiram no histórico do repo e a divergência é o defeito silencioso:
 *
 *  1. A do CÓDIGO — `CAMPOS_PROPONIVEIS` e `valorAceitavel`, que é o que o
 *     agente consegue pedir. Data de nascimento é o dado que a clínica da issue
 *     precisa para mandar parabenizar sem digitação manual.
 *  2. A do BANCO — o CHECK de `contact_field_proposals.campo`, lido da cadeia
 *     de migrations E do `baseline.sql` (o que o kit self-host aplica; os dois
 *     são o mesmo vocabulário visto de lados diferentes, e o repo já pagou por
 *     dividi-los: PR #963, medido em `check-do-baseline-nao-diverge-da-cadeia`).
 *
 * Aqui não se testa Postgres — `tests/invariants/proposta-de-dado-do-contato.test.ts`
 * roda a função contra um banco de verdade quando há Docker. O que se guarda
 * aqui é a propriedade estática que qualquer clone tem na árvore: o que o
 * código deixa a IA propor é exatamente o que o banco deixa entrar.
 *
 * O cliente fake de Supabase existe por outro motivo: as RECUSAS dependem de
 * estado (o contato existe? o valor já está gravado?), e sem um dublê elas só
 * seriam exercitáveis contra o banco — o que deixaria este arquivo mudo na
 * máquina de quem roda `pnpm test:unit` sem Docker, que é a maioria.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { CAMPOS_PROPONIVEIS, proporDadoDoContato, valorAceitavel } from "./proposta-de-dado";

// --------------------------------------------------------------------------
// A fronteira do BANCO, lida da árvore
// --------------------------------------------------------------------------

const DIR_MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

/**
 * Os literais do ÚLTIMO `check` que nomeia a constraint num texto.
 *
 * Posição é a regra, não contagem: tanto a cadeia quanto o baseline podem
 * reconstruir a mesma constraint mais de uma vez, e quem fica de pé é o último
 * bloco — o mesmo critério de `check-do-baseline-nao-diverge-da-cadeia`.
 *
 * Só o bloco conta, não qualquer menção: o comentário que aponta para a
 * constraint é tão nomeado quanto o SQL e não traz literais nenhum. Por isso a
 * janela é ancorada no `check (` seguinte, e não na primeira ocorrência do nome.
 */
function vocabularioFinal(texto: string, constraint: string): string[] {
  const blocos = [
    ...texto.matchAll(
      new RegExp(`${constraint}\\s+check\\s*\\(([\\s\\S]{0,400}?)\\)\\s*;`, "gi"),
    ),
  ];
  const ultimo = blocos.at(-1)?.[1] ?? "";
  const literais = [...ultimo.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!);
  return [...new Set(literais)];
}

const CONSTR = "contact_field_proposals_campo_check";

function textoDaCadeia(): string {
  const arquivos = readdirSync(DIR_MIGRATIONS)
    .filter((a) => a.endsWith(".sql"))
    .sort(); // prefixo é timestamp de largura fixa: ordem lexicográfica = ordem de aplicação
  return arquivos.map((a) => readFileSync(join(DIR_MIGRATIONS, a), "utf8")).join("\n");
}

describe("a lista do código e a do banco são a MESMA fronteira", () => {
  it("a cadeia de migrations aceita tudo que o código deixa propor", () => {
    const banco = vocabularioFinal(textoDaCadeia(), CONSTR);
    expect(banco, "o CHECK da cadeia não aceita o que o código propõe — a proposta morreria em 23514").toEqual(
      [...CAMPOS_PROPONIVEIS],
    );
  });

  it("o baseline (o que o kit self-host aplica) aceita tudo que o código deixa propor", () => {
    const banco = vocabularioFinal(readFileSync(BASELINE, "utf8"), CONSTR);
    expect(banco, "o baseline ficou para trás da cadeia: a VPS de quem instala recusaria o nascimento").toEqual(
      [...CAMPOS_PROPONIVEIS],
    );
  });
});

// --------------------------------------------------------------------------
// A fronteira do CÓDIGO
// --------------------------------------------------------------------------

describe("o nascimento é um dado proponível, e tem forma", () => {
  it("entra na lista fechada de campos", () => {
    expect(CAMPOS_PROPONIVEIS).toContain("birthdate");
  });

  it("aceita a MESMA forma que a coluna e o PATCH aceitam: AAAA-MM-DD", () => {
    expect(valorAceitavel("birthdate", "1990-09-14")).toBe(true);
    // Bissexto de verdade: 2024 teve 29 de fevereiro.
    expect(valorAceitavel("birthdate", "2024-02-29")).toBe(true);
  });

  it("recusa o que tem forma de data mas não É data — o cron não acionaria", () => {
    expect(valorAceitavel("birthdate", "1990-02-30")).toBe(false);
    expect(valorAceitavel("birthdate", "2023-02-29")).toBe(false);
    expect(valorAceitavel("birthdate", "1990-13-01")).toBe(false);
  });

  it("recusa a data no formato que a tela NÃO grava e o brasilinho comum", () => {
    expect(valorAceitavel("birthdate", "14/09/1990")).toBe(false);
    expect(valorAceitavel("birthdate", "14-09-1990")).toBe(false);
    expect(valorAceitavel("birthdate", "14 de setembro de 1990")).toBe(false);
  });

  it("recusa o nascimento que ainda vai acontecer", () => {
    expect(valorAceitavel("birthdate", "2999-01-01")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// A proposta NASCE, com o nascimento
// --------------------------------------------------------------------------

type Linha = Record<string, unknown>;

/**
 * O mínimo que `proporDadoDoContato` encosta: le a linha do contato e insere a
 * proposta. Nada além disso é exercitado aqui — o resto (RLS, índice único,
 * anonimização de verdade) é do invariante, que tem banco.
 */
function dbFalso(contato: Linha | null) {
  const inseridas: Linha[] = [];
  const db = {
    from(tabela: string) {
      if (tabela === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: contato, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        insert: (linha: Linha) => {
          inseridas.push(linha);
          return {
            select: () => ({ single: async () => ({ data: { id: "proposta-1" }, error: null }) }),
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, inseridas };
}

const ORG = "9a0b7e00-0000-4000-8000-000000000001";
const CONTATO = "b1a0b7e0-0000-4000-8000-000000000002";

describe("propor nascimento", () => {
  it("cria a linha na fila sem tocar no cadastro", async () => {
    const { db, inseridas } = dbFalso({
      id: CONTATO,
      is_anonymized: false,
      email: null,
      name: null,
      phone_number: null,
      birthdate: null,
    });

    const r = await proporDadoDoContato(db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "birthdate",
      valor: "1990-09-14",
      trecho: "nasci em 14 de setembro de 1990",
    });

    expect(r.criada, JSON.stringify(r)).toBe(true);
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0]).toMatchObject({
      campo: "birthdate",
      valor_proposto: "1990-09-14",
      valor_anterior: null,
      organization_id: ORG,
      contact_id: CONTATO,
    });
  });

  it("o valor IGUAL ao que já está gravado não vira proposta — nada a decidir", async () => {
    // Esta é a asserção que protege o `select`: sem `birthdate` na leitura do
    // contato, `valor_anterior` viraria null, a comparação não casaria e o
    // cliente repetindo a própria data encheria a fila de propostas que
    // confirmam o que já é verdade.
    const { db, inseridas } = dbFalso({
      id: CONTATO,
      is_anonymized: false,
      email: null,
      name: null,
      phone_number: null,
      birthdate: "1990-09-14",
    });

    const r = await proporDadoDoContato(db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "birthdate",
      valor: " 1990-09-14 ",
    });

    expect(r).toEqual({ criada: false, motivo: "valor_igual_ao_atual" });
    expect(inseridas).toHaveLength(0);
  });

  it("a forma errada é recusada ANTES de a linha existir", async () => {
    const { db, inseridas } = dbFalso({ id: CONTATO, is_anonymized: false, birthdate: null });

    const r = await proporDadoDoContato(db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "birthdate",
      valor: "14/09/1990",
    });

    expect(r).toEqual({ criada: false, motivo: "valor_invalido" });
    expect(inseridas).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// #2593 — o telefone informado pelo cliente é aplicado SOZINHO
// --------------------------------------------------------------------------

/**
 * O dublê dos três casos da issue: ficha VAZIA (grava), valor INVÁLIDO (não
 * grava) e ficha JÁ PREENCHIDA (não sobrescreve). Ele precisa enxergar as
 * DUAS escritas possíveis — o UPDATE condicional do telefone e o INSERT da
 * proposta — porque a prova desses casos é justamente qual das duas aconteceu
 * (e, no terceiro, que a primeira NÃO aconteceu).
 */
function dbDeTelefone(
  contato: Linha,
  opcao: { linhasAtualizadas?: number; erroNoUpdate?: { code?: string; message: string } } = {},
) {
  const inseridas: Linha[] = [];
  const atualizacoes: Array<{ patch: Linha; filtros: Record<string, unknown> }> = [];

  const db = {
    from(tabela: string) {
      if (tabela === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: contato, error: null }),
              }),
            }),
          }),
          update: (patch: Linha) => {
            const filtros: Record<string, unknown> = {};
            const cadeia = {
              eq: (coluna: string, valor: unknown) => {
                filtros[coluna] = valor;
                return cadeia;
              },
              is: (coluna: string, valor: unknown) => {
                filtros[`${coluna} IS`] = valor;
                return cadeia;
              },
              select: async () => {
                atualizacoes.push({ patch, filtros });
                if (opcao.erroNoUpdate) return { data: null, error: opcao.erroNoUpdate };
                const travou = filtros["phone_number IS"] === null;
                const linhas = travou ? (opcao.linhasAtualizadas ?? 1) : 0;
                return { data: linhas > 0 ? [{ id: contato.id }] : [], error: null };
              },
            };
            return cadeia;
          },
        };
      }
      return {
        insert: (linha: Linha) => {
          inseridas.push(linha);
          return {
            select: () => ({ single: async () => ({ data: { id: "proposta-1" }, error: null }) }),
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, inseridas, atualizacoes };
}

const FICHA_VAZIA: Linha = {
  id: CONTATO,
  is_anonymized: false,
  email: null,
  name: null,
  phone_number: null,
  birthdate: null,
  // Uma finalidade que o patch NÃO pode apagar: o `consent` é merge por
  // finalidade, e gravar `transactional` cego mataria o marketing de quem já
  // tinha dado.
  consent: { marketing: { granted: true, granted_at: "2026-01-01T00:00:00.000Z" } },
};

describe("#2593: o telefone informado pelo cliente", () => {
  it("caso 1 — ficha SEM telefone: grava sozinho em E.164, sem nascer proposta", async () => {
    const { db, inseridas, atualizacoes } = dbDeTelefone({ ...FICHA_VAZIA });

    const r = await proporDadoDoContato(db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "phone_number",
      valor: "(11) 99999-8888",
      trecho: "meu número é (11) 99999-8888",
    });

    // O desfecho é ESCRITA, não fila — é o que a issue pede.
    expect(r).toEqual({ criada: false, motivo: "aplicado_automaticamente", telefone: "+5511999998888" });
    expect(inseridas, "nada entra na fila de propostas quando o telefone já foi gravado").toHaveLength(0);

    expect(atualizacoes).toHaveLength(1);
    const { patch, filtros } = atualizacoes[0]!;
    expect(patch.phone_number).toBe("+5511999998888");
    // A TRAVA: sem `phone_number IS null` no UPDATE, este código seria capaz de
    // sobrescrever um número que entrou entre a leitura e a escrita.
    expect(filtros).toMatchObject({ organization_id: ORG, id: CONTATO, "phone_number IS": null });
    // A base legal gravada no mesmo ato, em merge — `marketing` sobrevive.
    expect(patch.consent).toMatchObject({
      marketing: { granted: true, granted_at: "2026-01-01T00:00:00.000Z" },
      transactional: {
        granted: true,
        granted_at: expect.any(String),
        source: expect.stringContaining("aplicado automaticamente"),
      },
    });
  });

  it("caso 2 — valor que não vira E.164: nada é gravado no cadastro", async () => {
    // Curto demais: recusado pela régua da própria proposta, nem chega à escrita.
    const curto = dbDeTelefone({ ...FICHA_VAZIA });
    const r1 = await proporDadoDoContato(curto.db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "phone_number",
      valor: "123",
    });
    expect(r1).toEqual({ criada: false, motivo: "valor_invalido" });
    expect(curto.atualizacoes, "valor inválido não pode encostar em contacts").toHaveLength(0);
    expect(curto.inseridas).toHaveLength(0);

    // 8 dígitos passam na régua LARGA da proposta (`valorAceitavel`), mas sem
    // DDI não viram E.164 — a regra da casa só dá `+55` para 10/11 dígitos.
    // Este é o caso em que a validação de E.164 é quem segura a escrita.
    const semDdi = dbDeTelefone({ ...FICHA_VAZIA });
    const r2 = await proporDadoDoContato(semDdi.db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "phone_number",
      valor: "12345678",
    });
    expect(r2.criada, JSON.stringify(r2)).toBe(true);
    expect(semDdi.atualizacoes, "sem DDI não há gravação automática").toHaveLength(0);
    expect(semDdi.inseridas).toHaveLength(1);
  });

  it("caso 3 — ficha JÁ COM telefone: o número existente não é sobrescrito", async () => {
    const { db, inseridas, atualizacoes } = dbDeTelefone({
      ...FICHA_VAZIA,
      phone_number: "+551133334444",
    });

    const r = await proporDadoDoContato(db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "phone_number",
      valor: "(11) 99999-8888",
      trecho: "agora é outro número",
    });

    // Trocar telefone continua sendo decisão humana: nasce proposta, com o
    // `valor_anterior` de quem decidiu ver os dois lados.
    expect(r.criada, JSON.stringify(r)).toBe(true);
    expect(atualizacoes, "nenhum UPDATE sai daqui — sobrescrever é o defeito").toHaveLength(0);
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0]).toMatchObject({
      campo: "phone_number",
      valor_anterior: "+551133334444",
      organization_id: ORG,
      contact_id: CONTATO,
    });
  });

  it("o UPDATE que não casa linha vira PROPOSTA — a informação não se perde e nada é sobrescrito", async () => {
    // Corrida: alguém preencheu o número entre a leitura e a escrita (0 linhas
    // casadas). A trava do `is("phone_number", null)` fez o banco recusar…
    const corrida = dbDeTelefone({ ...FICHA_VAZIA }, { linhasAtualizadas: 0 });
    const r1 = await proporDadoDoContato(corrida.db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "phone_number",
      valor: "(11) 99999-8888",
    });
    expect(r1.criada, JSON.stringify(r1)).toBe(true);
    expect(corrida.inseridas, "sem linha gravada, o número continua como proposta").toHaveLength(1);

    // …e o mesmo para telefone que já é de OUTRO contato vivo desta
    // organização (índice parcial `uniq_contacts_org_phone` → 23505): a
    // deduplicação é da casa, e resolver isso é decisão humana (merge), não
    // uma escrita automática em cima de dois cadastros.
    const duplicado = dbDeTelefone(
      { ...FICHA_VAZIA },
      { erroNoUpdate: { code: "23505", message: "duplicate key value violates unique constraint" } },
    );
    const r2 = await proporDadoDoContato(duplicado.db, {
      organizationId: ORG,
      contactId: CONTATO,
      campo: "phone_number",
      valor: "(11) 99999-8888",
    });
    expect(r2.criada, JSON.stringify(r2)).toBe(true);
    expect(duplicado.inseridas).toHaveLength(1);
  });
});
