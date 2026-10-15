import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_MANAGER, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * RENOMEAR PARA UM NOME QUE JÁ EXISTE JUNTA AS DUAS — E A JUNÇÃO NÃO PODE
 * PERDER A COR NEM SE PASSAR POR RENOME SIMPLES (issue #2801).
 *
 * O defeito, medido em Postgres na triagem do #2784 e confirmado na main:
 *
 *   vocabulário: [{ tag: "b" }, { tag: "a", cor: "#ab4aba" }]   ("b" sem cor, ANTES de "a")
 *   operar(GOV_ORG, "renomear", "a", "b", null)
 *   esperado: [{ tag: "b", cor: "#ab4aba" }] · medido: [{ tag: "b" }]
 *
 * O dedupe do ramo renomear/juntar era `order by lower(x.chave), x.ord`: a
 * primeira entrada pela POSIÇÃO ficava, com ou sem metadado — e a cor que o
 * operador escolheu sumia, enquanto a operação respondia `alterou: true`
 * idêntica a um renome simples.
 *
 * O que este arquivo cobre, e por que CADA caso é o que é:
 *
 *  1. **Os dois sentidos do metadado.** Fonte com cor e destino sem (é o caso
 *     medido), nas DUAS ordens possíveis na lista — se o desempate fosse pela
 *     ordem, o resultado mudaria conforme quem vinha primeiro, e um conserto
 *     pela metade só consertaria um dos sentidos.
 *  2. **As duas com cor: QUAL delas fica.** Cor contra cor tem de perder uma.
 *     A regra documentada na PR: o metadado decide contra AUSÊNCIA de
 *     metadado; em empate de metadado com metadado volta a valer a ordem no
 *     vocabulário, isto é, fica quem já ocupava a posição de destino.
 *  3. **`descricao` é metadado também.** O desempate é o mesmo da função de
 *     leitura, que trata `cor` e `descricao` como um só predicado; cobrir só a
 *     cor deixaria a descrição caindo pelo mesmo buraco.
 *  4. **`juntou` no retorno.** O banco é quem sabe se o destino já existia — a
 *     tela só tem a lista que ela mesma leu, e o caso interessante é o que já
 *     vinha como DUAS linhas. Sem o marcador, a resposta era indistinguível de
 *     um renome simples e a tela não tinha o que dizer.
 *  5. **Renome que NÃO junta continua `juntou: false`.** Marcador que é sempre
 *     `true` é marcador morto: quem lê para de acreditar nele.
 *  6. **O ramo `definir_cor` (0336) continua preferindo metadado.** A 0336 já
 *     desempatava pela presença de metadado; este arquivo mede que a mudança no
 *     ramo renomear não tocou naquela. Mesmo harness do arquivo irmão
 *     (`tests/invariants/tags-cor-de-etiqueta.test.ts`) — que NÃO é editado,
 *     pela regra do repo: o caso da issue vira arquivo próprio.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

beforeAll(() => {
  seedGov();
});

afterAll(() => pool.end());

async function actor(user: string | null, sql: string, args: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(user ? "set local role authenticated" : "set local role anon");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user, role: user ? "authenticated" : "anon", aal: "aal2" }),
    ]);
    const r = await client.query(sql, args);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

function operar(org: string, acao: string, tag: string, destino: string | null, cor: string | null) {
  return actor(
    GOV_MANAGER,
    "select public.fn_vocabulario_de_tags_operar($1,$2,$3,$4,$5) as r",
    [org, acao, tag, destino, cor],
  );
}

type Retorno = {
  acao: string;
  alterou: boolean;
  juntou?: boolean;
  destino: string | null;
  regras: number;
};

/** O vocabulário curado como está GRAVADO — não a leitura, que tem a sua regra. */
async function vocabulario(org: string): Promise<{ tag: string; cor?: string; descricao?: string }[]> {
  const r = await pool.query("select settings -> 'tags' as tags from public.organizations where id = $1", [org]);
  return (r.rows[0]?.tags ?? []) as { tag: string; cor?: string; descricao?: string }[];
}

/** Grava o vocabulário à mão, no formato que a 0264/0336 já lê (string ou objeto). */
async function semearVocabulario(org: string, entradas: unknown[]) {
  await pool.query(
    "update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{tags}', $2::jsonb) where id = $1",
    [org, JSON.stringify(entradas)],
  );
}

describe("renomear que junta guarda a cor e avisa (issue #2801)", () => {
  it("fonte com cor, destino sem — a cor da fonte sobrevive, e a resposta AVISA que juntou", async () => {
    // O caso medido na issue, com "b" (sem cor) ANTES de "a" na lista: é a
    // ordem que fazia o dedupe escolher a entrada vazia.
    await semearVocabulario(GOV_ORG, [{ tag: "b" }, { tag: "a", cor: "#ab4aba" }]);

    const r = await operar(GOV_ORG, "renomear", "a", "b", null);
    const retorno = r.rows[0].r as Retorno;

    // Duas coisas distintas, e as duas importam: a COR fica, e a operação DIZ
    // que juntou. Só a primeira seria meia correção — a tela continuaria
    // respondendo "Etiqueta atualizada" como se nada tivesse virado uma só.
    expect(await vocabulario(GOV_ORG)).toEqual([{ tag: "b", cor: "#ab4aba" }]);
    expect(retorno.juntou).toBe(true);
    expect(retorno.alterou).toBe(true);
  });

  it("o mesmo, com a fonte ANTES da destino na lista — o resultado não depende da posição", async () => {
    // Se o desempate fosse pela ordem, este caso passaria e o anterior falharia
    // (ou vice-versa). Cobrir os DOIS sentidos é o que separa o conserto do
    // acerto de um caso.
    await semearVocabulario(GOV_ORG, [{ tag: "a", cor: "#ab4aba" }, { tag: "b" }]);

    const r = await operar(GOV_ORG, "renomear", "a", "b", null);
    expect(await vocabulario(GOV_ORG)).toEqual([{ tag: "b", cor: "#ab4aba" }]);
    expect((r.rows[0].r as Retorno).juntou).toBe(true);
  });

  it("as DUAS com cor: fica a que já ocupava a posição de destino (documentado na PR)", async () => {
    // Cor contra cor tem de perder uma. A regra: metadado decide contra
    // AUSÊNCIA de metadado; em empate, volta a valer a ordem no vocabulário —
    // e quem já estava na posição de destino é quem tem nome, posição e cor
    // preservados. O que NÃO pode acontecer é a escolha virar aleatória.
    await semearVocabulario(GOV_ORG, [
      { tag: "b", cor: "#111111" },
      { tag: "a", cor: "#ab4aba" },
    ]);

    const r = await operar(GOV_ORG, "renomear", "a", "b", null);
    expect(await vocabulario(GOV_ORG)).toEqual([{ tag: "b", cor: "#111111" }]);
    expect((r.rows[0].r as Retorno).juntou).toBe(true);
  });

  it("`descricao` é metadado: sobrevive junto da cor, pelo mesmo desempate", async () => {
    // A função de leitura trata `cor` e `descricao` num único predicado. Se o
    // desempate da escrita olhasse só a cor, uma etiqueta que só tinha
    // descrição cairia pelo mesmo buraco da cor.
    await semearVocabulario(GOV_ORG, [{ tag: "b" }, { tag: "a", descricao: "cliente recorrente" }]);

    const r = await operar(GOV_ORG, "renomear", "a", "b", null);
    expect(await vocabulario(GOV_ORG)).toEqual([{ tag: "b", descricao: "cliente recorrente" }]);
    expect((r.rows[0].r as Retorno).juntou).toBe(true);
  });

  it("`juntar` para um destino que existe também junta e avisa; a cor do destino é a que fica", async () => {
    // Mesmo ramo, outra ação. A tela de `juntar` já dizia que ia juntar; o que
    // faltava era a RESPOSTA distinguir o caso em que o destino já era uma
    // entrada do vocabulário — é ele quem define qual cor sobrevive.
    await semearVocabulario(GOV_ORG, [{ tag: "a" }, { tag: "b", cor: "#111111" }]);

    const r = await operar(GOV_ORG, "juntar", "a", "b", null);
    const retorno = r.rows[0].r as Retorno;
    expect(await vocabulario(GOV_ORG)).toEqual([{ tag: "b", cor: "#111111" }]);
    expect(retorno.juntou).toBe(true);
    expect(retorno.alterou).toBe(true);
  });

  it("renomear que NÃO junta continua `juntou: false` e preserva a cor", async () => {
    // Marcador que é sempre `true` é marcador morto: quem lê para de acreditar
    // nele. Renome para nome que não existia continua sendo renome.
    await semearVocabulario(GOV_ORG, [{ tag: "a", cor: "#ab4aba" }]);

    const r = await operar(GOV_ORG, "renomear", "a", "Promoção", null);
    const retorno = r.rows[0].r as Retorno;
    expect(await vocabulario(GOV_ORG)).toEqual([{ tag: "Promoção", cor: "#ab4aba" }]);
    expect(retorno.juntou).toBe(false);
    expect(retorno.alterou).toBe(true);
  });

  it("excluir não é junção: `juntou: false` mesmo a duas entradas com o mesmo nome", async () => {
    // O marcador é do ramo renomear/juntar. Excluir tira a entrada; dizer que
    // juntou seria mentir sobre a própria ação.
    await semearVocabulario(GOV_ORG, [{ tag: "a", cor: "#ab4aba" }, { tag: "A" }]);

    const r = await operar(GOV_ORG, "excluir", "a", null, null);
    expect((r.rows[0].r as Retorno).juntou).toBe(false);
    expect(await vocabulario(GOV_ORG)).toEqual([]);
  });

  it("o ramo `definir_cor` (0336) segue preferindo metadado — a mudança não o tocou", async () => {
    // A 0336 já desempatava por `cor/descrição is not null desc`. Este caso mede
    // que a correção no ramo renomear não mudou o outro: duas entradas da MESMA
    // etiqueta (uma string, outra objeto com cor) viram UMA, com a cor nova.
    await semearVocabulario(GOV_ORG, ["vip", { tag: "vip", cor: "#0091ff" }]);

    const r = await operar(GOV_ORG, "definir_cor", "vip", null, "#e54d2e");
    expect((r.rows[0].r as Retorno).alterou).toBe(true);
    expect(await vocabulario(GOV_ORG)).toEqual([{ tag: "vip", cor: "#e54d2e" }]);
  });
});
