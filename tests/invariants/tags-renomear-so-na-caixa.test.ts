import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GOV_CONTACT_1,
  GOV_CONTACT_2,
  GOV_CONV_CLAIM,
  GOV_CONV_UNASSIGNED,
  GOV_LEAD,
  GOV_MANAGER,
  GOV_ORG,
  seedGov,
} from "./gov-helpers";

/**
 * RENOMEAR UMA ETIQUETA MUDANDO SÓ A CAIXA ("prospecção" -> "Prospecção") NÃO
 * PODE DEIXAR DUAS GRAFIAS NAS COLUNAS QUE O PRODUTO GUARDA EM MINÚSCULA
 * (issue #3507).
 *
 * `contacts.tags` e `conversations.tags` são minúscula por contrato — a régua
 * existe e mora em dois lugares: `normalizarTag`
 * (`lib/contacts/tag-normalizada.ts`: `trim().toLowerCase().slice(0,40)`, issue
 * #1224, migrations 0324/0335) para o contato, e `conversationTagSchema`
 * (`.trim().toLowerCase()`, `lib/schemas/messaging.ts`) para a conversa. O
 * filtro `?tag=` consulta nessa forma (`tags @> '{prospecção}'`). O renomear,
 * porém, gravava `v_destino` COMO FOI DIGITADO — do primeiro clique em diante:
 *
 *  - o contato renomeado some do filtro `?tag=prospecção`;
 *  - a próxima etiqueta aplicada pelo Inbox/ficha entra em minúscula, e a
 *    organização passa a ter as DUAS grafias nos arrays;
 *  - `fn_tags_de_conversa_em_uso` (`select distinct t`) devolve as duas, e o
 *    filtro de conversas do Inbox mostra "Prospecção" e "prospecção";
 *  - a tela de Tags agrupa por `lower()` e lista UMA linha com a contagem
 *    somada — o sistema "reconhece como uma", e o resto da tela mostra duas.
 *
 * O vocabulário (`settings.tags`) e `crm_leads.tags` aceitam caixa mista e
 * seguem com o nome DIGITADO — é o nome de exibição, não um valor de coluna
 * normalizada. Cada caso abaixo é um deles:
 *
 *  1. **Só a caixa** — o caso da issue. É o que a normalização do destino
 *     conserta; sem ela, os contatos recebem "Prospecção" e o filtro devolve 0.
 *  2. **Destino realmente diferente, em minúscula** — CONTROLE POSITIVO do
 *     caminho: a troca continua acontecendo nas três tabelas. Passa com e sem o
 *     conserto, e é o que prova que o arquivo não está medindo um renome mudo.
 *  3. **Destino realmente diferente COM maiúscula** ("Qualificado") — o mesmo
 *     defeito da issue com outra roupa: contato e conversa têm de ficar em
 *     minúscula, o negócio tem de guardar "Qualificado".
 *  4. **Destino que já existe** — renomear para um nome que já está no
 *     vocabulário continua sendo o que é hoje: junta as entradas, guarda a cor
 *     e responde `juntou: true`. Esta migration não inventa junção de etiquetas.
 *  5. **Fora do vocabulário** — a tela de Tags mostra a grafia digitada, e não
 *     a minúscula que o contato guarda (`fn_vocabulario_de_tags_pagina`).
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

type Retorno = { alterou: boolean; juntou: boolean; contatos: number; conversas: number };

/** As etiquetas COMO ESTÃO GRAVADAS — não como a leitura as normaliza. */
async function tagsDe(
  tabela: "contacts" | "crm_leads" | "conversations",
  id: string,
): Promise<string[]> {
  const r = await pool.query(`select tags from public.${tabela} where id = $1`, [id]);
  return (r.rows[0]?.tags ?? []) as string[];
}

/** O vocabulário curado como está gravado — nome de exibição, com a caixa. */
async function vocabulario(): Promise<{ tag: string; cor?: string }[]> {
  const r = await pool.query("select settings -> 'tags' as tags from public.organizations where id = $1", [
    GOV_ORG,
  ]);
  return (r.rows[0]?.tags ?? []) as { tag: string; cor?: string }[];
}

async function semear() {
  await pool.query(
    "update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{tags}', $2::jsonb) where id = $1",
    [GOV_ORG, JSON.stringify([{ tag: "prospecção", cor: "#ab4aba" }])],
  );
  await pool.query("update public.contacts set tags = array['prospecção','vip'] where id = $1", [GOV_CONTACT_1]);
  await pool.query("update public.contacts set tags = array['prospecção'] where id = $1", [GOV_CONTACT_2]);
  await pool.query("update public.conversations set tags = array['prospecção'] where id = $1", [GOV_CONV_UNASSIGNED]);
  await pool.query("update public.conversations set tags = array['prospecção','urgente'] where id = $1", [GOV_CONV_CLAIM]);
  await pool.query("update public.crm_leads set tags = array['prospecção'] where id = $1", [GOV_LEAD]);
}

/** O filtro de contatos (`?tag=prospecção` -> `tags @> '{prospecção}'`). */
async function contatosNoFiltro(tag: string): Promise<number> {
  const r = await pool.query(
    "select count(*)::int as n from public.contacts where organization_id = $1 and tags @> array[$2]::text[]",
    [GOV_ORG, tag],
  );
  return r.rows[0].n as number;
}

/** As grafias que o seletor de conversa do Inbox recebe (RPC da tela). */
async function grafiasEmUso(chave: string): Promise<string[]> {
  const r = await pool.query(
    "select tag from public.fn_tags_de_conversa_em_uso($1) where lower(tag) = $2",
    [GOV_ORG, chave],
  );
  return r.rows.map((l: { tag: string }) => l.tag as string);
}

describe("renomear só na caixa: prospecção -> Prospecção (issue #3507)", () => {
  it("contato e conversa continuam em minúscula, o filtro acha os dois contatos e só há UMA grafia em uso", async () => {
    await semear();

    const r = await operar(GOV_ORG, "renomear", "prospecção", "Prospecção", null);
    expect((r.rows[0].r as Retorno).alterou).toBe(true);

    // (a) As DUAS colunas minúsculas por contrato não ganham a caixa digitada.
    expect(await tagsDe("contacts", GOV_CONTACT_1)).toEqual(["prospecção", "vip"]);
    expect(await tagsDe("contacts", GOV_CONTACT_2)).toEqual(["prospecção"]);
    expect(await tagsDe("conversations", GOV_CONV_CLAIM)).toEqual(["prospecção", "urgente"]);
    expect(await tagsDe("conversations", GOV_CONV_UNASSIGNED)).toEqual(["prospecção"]);

    // (b) O filtro `?tag=prospecção` continua achando os dois contatos.
    expect(await contatosNoFiltro("prospecção")).toBe(2);

    // (c) A lista de etiquetas em uso devolve UMA grafia, não duas.
    expect(await grafiasEmUso("prospecção")).toEqual(["prospecção"]);

    // (d) O NOME DE EXIBIÇÃO guarda o que foi digitado, com a cor de antes.
    expect(await vocabulario()).toEqual([{ tag: "Prospecção", cor: "#ab4aba" }]);

    // (e) O negócio aceita caixa mista: recebe o nome como foi digitado.
    expect(await tagsDe("crm_leads", GOV_LEAD)).toEqual(["Prospecção"]);

    // (f) A tela de Tags (que agrupa por `lower()`) mostra UMA linha, e a
    //     contagem é a inteira: 2 contatos e 2 conversas, não metade em cada
    //     grafia.
    const pagina = await pool.query("select public.fn_vocabulario_de_tags_pagina($1,'',0,50) as r", [GOV_ORG]);
    const linhas = (
      pagina.rows[0].r as { items: { tag: string; uso_em_contatos: number; uso_em_conversas: number }[] }
    ).items.filter((l) => l.tag.toLowerCase() === "prospecção");
    expect(linhas).toHaveLength(1);
    // Uma linha só, e a contagem é a soma: com a caixa vazando para a coluna,
    // os contatos ficariam fora do agrupamento por `lower()` de uma das
    // grafias e a tela mostraria metade em cada uma.
    const [linha] = linhas;
    expect(linha?.uso_em_contatos).toBe(2);
    expect(linha?.uso_em_conversas).toBe(2);
    expect(linha?.tag).toBe("Prospecção");
  });

  it("CONTROLE POSITIVO: destino realmente diferente e em minúscula troca nas três tabelas", async () => {
    // Sem este caso, um conserto que simplesmente NÃO trocasse nada passaria no
    // caso da issue. Aqui o destino não muda de caixa: passa com e sem a
    // normalização — é o que separa "não escreveu a caixa" de "não escreveu".
    await semear();

    await operar(GOV_ORG, "renomear", "prospecção", "qualificado", null);

    expect(await tagsDe("contacts", GOV_CONTACT_1)).toEqual(["qualificado", "vip"]);
    expect(await tagsDe("conversations", GOV_CONV_CLAIM)).toEqual(["qualificado", "urgente"]);
    expect(await tagsDe("crm_leads", GOV_LEAD)).toEqual(["qualificado"]);
    expect(await contatosNoFiltro("qualificado")).toBe(2);
    expect(await vocabulario()).toEqual([{ tag: "qualificado", cor: "#ab4aba" }]);
  });

  it("o MESMO defeito com outro nome: destino 'Qualificado' grava minúscula em contato e conversa, e a caixa no negócio", async () => {
    await semear();

    await operar(GOV_ORG, "renomear", "prospecção", "Qualificado", null);

    expect(await tagsDe("contacts", GOV_CONTACT_1)).toEqual(["qualificado", "vip"]);
    expect(await tagsDe("conversations", GOV_CONV_CLAIM)).toEqual(["qualificado", "urgente"]);
    expect(await contatosNoFiltro("qualificado")).toBe(2);
    expect(await tagsDe("crm_leads", GOV_LEAD)).toEqual(["Qualificado"]);
    expect(await vocabulario()).toEqual([{ tag: "Qualificado", cor: "#ab4aba" }]);
  });

  it("fora do vocabulário, a tela de Tags mostra a grafia DIGITADA, não a minúscula do contato", async () => {
    // Etiqueta em uso no contato e no negócio, sem entrada no vocabulário: o
    // nome exibido vem do agrupamento por `lower()`. Depois de renomear só a
    // caixa, o contato guarda a minúscula (contrato) e o negócio a forma
    // digitada; a tela tem de mostrar a digitada, senão o renome "não pegou".
    await semear();
    await pool.query(
      "update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{tags}', '[]'::jsonb) where id = $1",
      [GOV_ORG],
    );
    await pool.query("update public.contacts set tags = array['obra-norte'] where id = $1", [GOV_CONTACT_1]);
    await pool.query("update public.crm_leads set tags = array['obra-norte'] where id = $1", [GOV_LEAD]);

    const r = await operar(GOV_ORG, "renomear", "obra-norte", "OBRA-NORTE", null);
    expect((r.rows[0].r as Retorno).alterou).toBe(true);
    expect(await tagsDe("contacts", GOV_CONTACT_1)).toEqual(["obra-norte"]);
    expect(await tagsDe("crm_leads", GOV_LEAD)).toEqual(["OBRA-NORTE"]);

    const pagina = await pool.query("select public.fn_vocabulario_de_tags_pagina($1,'obra-norte',0,50) as r", [GOV_ORG]);
    const linhas = (
      pagina.rows[0].r as { items: { tag: string; no_vocabulario: boolean; uso_em_contatos: number }[] }
    ).items;
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.no_vocabulario).toBe(false);
    expect(linhas[0]?.uso_em_contatos).toBe(1);
    expect(linhas[0]?.tag).toBe("OBRA-NORTE");
  });

  it("renomear para um nome que já existe continua juntando as entradas do vocabulário e avisando (`juntou`)", async () => {
    // A junção de VOCABULÁRIO é comportamento da 0677 e esta migration não a
    // toca. O contato que tinha as duas etiquetas fica com uma só, e é uma
    // grafia só: `prospecção` e `vip` não convivem num array.
    // A ordem importa: `semear` reescreve `settings.tags` (o vocabulário), então
    // o vocabulário com as DUAS entradas entra DEPOIS dele.
    await semear();
    await pool.query(
      "update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{tags}', $2::jsonb) where id = $1",
      [GOV_ORG, JSON.stringify([{ tag: "prospecção", cor: "#ab4aba" }, { tag: "vip" }])],
    );

    const r = await operar(GOV_ORG, "renomear", "prospecção", "vip", null);
    const retorno = r.rows[0].r as Retorno;

    expect(retorno.juntou).toBe(true);
    expect(await vocabulario()).toEqual([{ tag: "vip", cor: "#ab4aba" }]);
    expect(await tagsDe("contacts", GOV_CONTACT_1)).toEqual(["vip"]);
    expect(await tagsDe("conversations", GOV_CONV_CLAIM)).toEqual(["vip", "urgente"]);
  });
});
