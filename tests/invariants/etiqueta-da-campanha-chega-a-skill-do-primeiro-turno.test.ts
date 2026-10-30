/**
 * A ETIQUETA que a campanha da prospecção põe no contato chega à SKILL do primeiro turno
 * (spec 27, fatia 1 — PR #3468).
 *
 * ─── O que este arquivo mede, e por que o unitário não bastava ─────────────
 *
 * As duas metades já têm teste com dublê: `prospeccao-etiquetas-do-contato.test.ts` confere
 * os argumentos da junção, e `etiquetas-do-matcher.test.ts` confere o TEXTO da consulta e
 * devolve linhas fabricadas. A EMENDA fica de fora: um JOIN errado na consulta (por exemplo
 * `l.contact_id = cv.id`) passa nos dois. Aqui a emenda roda contra um Postgres de verdade,
 * com as mesmas peças do primeiro turno:
 *
 *     fn_contato_adicionar_etiquetas   (o que `marcarEtiquetasDaCampanha` chama)
 *       --> contacts.tags
 *       --> etiquetasParaOMatcher      (a consulta de `inbound-turn.ts`)
 *       --> matchSkills                (o casamento por `any_tags`)
 *
 * O sinal do turno é "Olá": é o caso da prospecção, em que o cliente responde só isso e a
 * única coisa que pode puxar a skill é a etiqueta.
 *
 * SABOTAGEM que este arquivo sabe pegar: troque o JOIN do contato em `etiquetas-do-matcher.ts`
 * (`c.id = cv.contact_id`) por outro, ou volte a leitura para só a conversa, e o primeiro caso
 * fica VERMELHO; tire o `l.status = 'open'` do lateral e o terceiro fica vermelho.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { etiquetasParaOMatcher } from "@/lib/agent-engine/agent/etiquetas-do-matcher";
import { matchSkills, type LoadedSkill } from "@/lib/agent-engine/agent/skills";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
afterAll(() => pool.end());

const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
const SESSAO = randomUUID();
const FUNIL = randomUUID();
const ETAPA = randomUUID();

/** Uma lista de avisos por chamada: se a consulta falhar, o código devolve [] e só avisa. */
function logQueAnota() {
  const avisos: string[] = [];
  return {
    avisos,
    log: {
      info: () => {},
      warn: (msg: string) => {
        avisos.push(msg);
      },
      error: (msg: string) => {
        avisos.push(msg);
      },
    },
  };
}

const skillDaEstetica: LoadedSkill = {
  versionId: randomUUID(),
  name: "abordagem-estetica",
  description: "abordagem para clínicas de estética",
  body: "corpo",
  matcher: { any_keywords: ["botox"], any_tags: ["estetica"] },
  manifest: [],
};

async function contato(tags: string[] = []): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into contacts(id, organization_id, name, tags) values ($1, $2, 'Clínica Teste', $3)`,
    [id, ORG, tags],
  );
  return id;
}

async function conversa(contactId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into conversations(id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [id, ORG, contactId, SESSAO],
  );
  return id;
}

async function negocio(
  contactId: string,
  status: "open" | "won" | "lost",
  tags: string[],
  criadoEm: string,
): Promise<void> {
  await pool.query(
    `insert into crm_leads(id, organization_id, pipeline_id, stage_id, title, contact_id, status, tags,
                           created_at, closed_at, lost_reason)
     values ($1, $2, $3, $4, 'Negócio', $5, $6::text, $7, $8,
             case when $6::text = 'open' then null else $8::timestamptz end,
             case when $6::text = 'lost' then 'other' else null end)`,
    [randomUUID(), ORG, FUNIL, ETAPA, contactId, status, tags, criadoEm],
  );
}

/** O que `marcarEtiquetasDaCampanha` faz: a MESMA função do banco, com os mesmos três argumentos. */
async function campanhaMarca(contactId: string, etiquetas: string[]) {
  const { rows } = await pool.query(
    `select public.fn_contato_adicionar_etiquetas($1, $2, $3) as r`,
    [ORG, contactId, etiquetas],
  );
  return rows[0].r as { tags: string[]; adicionadas: string[] };
}

async function lerEtiquetas(org: string, conversaId: string) {
  const { avisos, log } = logQueAnota();
  const tags = await etiquetasParaOMatcher(
    pool,
    org,
    conversaId,
    [skillDaEstetica],
    undefined,
    log,
  );
  return { tags, avisos };
}

beforeAll(async () => {
  for (const [id, nome] of [
    [ORG, "etiqueta-da-campanha-a"],
    [OUTRA_ORG, "etiqueta-da-campanha-b"],
  ]) {
    await pool.query(
      `insert into organizations(id, slug, legal_name, display_name) values ($1::uuid, $2::text, $2::text, $2::text)`,
      [id, nome],
    );
  }
  await pool.query(
    `insert into channel_sessions(id, organization_id, provider, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'waha', 'etiqueta-da-campanha', 'WORKING', '\\x00'::bytea)`,
    [SESSAO, ORG],
  );
  await pool.query(
    `insert into crm_pipelines(id, organization_id, name, slug) values ($1::uuid, $2, 'Funil', $1::text)`,
    [FUNIL, ORG],
  );
  await pool.query(
    `insert into crm_stages(id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Entrada', 'entrada', 1)`,
    [ETAPA, ORG, FUNIL],
  );
});

describe("a etiqueta da campanha chega à skill do primeiro turno", () => {
  it("o contato marcado pela campanha puxa a skill com o cliente dizendo só 'Olá'", async () => {
    const id = await contato();
    const conv = await conversa(id);

    // Controle: antes da campanha marcar, a skill NÃO entra (sem etiqueta e sem palavra-chave).
    const antes = await lerEtiquetas(ORG, conv);
    expect(antes.avisos).toEqual([]);
    expect(matchSkills([skillDaEstetica], "Olá", antes.tags).matched).toHaveLength(0);

    const marcou = await campanhaMarca(id, ["estetica"]);
    expect(marcou.adicionadas).toEqual(["estetica"]);

    const depois = await lerEtiquetas(ORG, conv);
    expect(depois.avisos).toEqual([]);
    expect(depois.tags).toContain("estetica");
    const resultado = matchSkills([skillDaEstetica], "Olá", depois.tags);
    expect(resultado.matched.map((s) => s.name)).toEqual(["abordagem-estetica"]);
    expect(resultado.motivos.get(resultado.matched[0]!)).toBe("etiqueta");
  });

  it("a etiqueta que não é da skill não a puxa", async () => {
    const id = await contato();
    const conv = await conversa(id);
    await campanhaMarca(id, ["advocacia"]);

    const { tags, avisos } = await lerEtiquetas(ORG, conv);
    expect(avisos).toEqual([]);
    expect(tags).toContain("advocacia");
    expect(matchSkills([skillDaEstetica], "Olá", tags).matched).toHaveLength(0);
  });

  it("tirar a etiqueta da ficha tira a skill no turno seguinte (nada fica em cache)", async () => {
    const id = await contato();
    const conv = await conversa(id);
    await campanhaMarca(id, ["estetica"]);
    expect(
      matchSkills([skillDaEstetica], "Olá", (await lerEtiquetas(ORG, conv)).tags).matched,
    ).toHaveLength(1);

    await pool.query(`update contacts set tags = '{}' where id = $1`, [id]);

    expect(
      matchSkills([skillDaEstetica], "Olá", (await lerEtiquetas(ORG, conv)).tags).matched,
    ).toHaveLength(0);
  });

  it("a etiqueta do negócio ABERTO entra; a do negócio fechado mais recente não", async () => {
    const id = await contato();
    const conv = await conversa(id);
    await negocio(id, "open", ["do-aberto"], "2030-01-01T10:00:00Z");
    await negocio(id, "lost", ["do-fechado"], "2030-02-01T10:00:00Z");

    const { tags, avisos } = await lerEtiquetas(ORG, conv);
    expect(avisos).toEqual([]);
    expect(tags).toContain("do-aberto");
    expect(tags).not.toContain("do-fechado");
  });

  it("sem negócio aberto, vale a etiqueta do mais recente", async () => {
    const id = await contato();
    const conv = await conversa(id);
    await negocio(id, "lost", ["antigo"], "2030-01-01T10:00:00Z");
    await negocio(id, "won", ["recente"], "2030-02-01T10:00:00Z");

    const { tags, avisos } = await lerEtiquetas(ORG, conv);
    expect(avisos).toEqual([]);
    expect(tags).toContain("recente");
    expect(tags).not.toContain("antigo");
  });

  it("a conversa de uma organização não é lida com o id de outra", async () => {
    const id = await contato(["estetica"]);
    const conv = await conversa(id);

    const { tags, avisos } = await lerEtiquetas(OUTRA_ORG, conv);
    expect(avisos).toEqual([]);
    expect(tags).toEqual([]);
  });
});
