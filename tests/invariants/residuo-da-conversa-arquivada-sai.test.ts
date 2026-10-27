/**
 * O RESÍDUO DO BACKFILL ANTIGO SAI — E SÓ ELE (#2992).
 *
 * O R2 do apêndice "Índice de Atrito + DEMANDAS" derivava uma demanda de toda
 * conversa que nunca escalou, inclusive `archived`. O PR #2825 fechou a ORIGEM
 * (`where cv.status <> 'archived'`); a demanda que já tinha sido derivada antes
 * do conserto continua aberta, aparecendo como pendência para sempre.
 *
 * A limpeza da migration 0784 é a única do repositório que APAGA demanda, e este
 * arquivo prova os dois lados dela:
 *
 *   ⭐ o resíduo sai — demanda `derivada`, aberta, intocada, presa a conversa(s)
 *      arquivada(s) e sem ninguém apontando para ela;
 *   ⭐ o que não pode quebrar NÃO é tocado — cada caso abaixo planta UM motivo
 *      legítimo para a demanda existir, e é ele que a limpeza tem de respeitar.
 *
 * Sem os casos de sobrevivência, o `delete` poderia estar largo demais e o teste
 * ficaria verde — é o modo de falha de limpeza em massa que a issue #2992
 * descreve ("sem encerrar indiscriminadamente demandas legítimas").
 *
 * ## Por que o bloco vem da MIGRATION, e não do baseline
 *
 * A migration é a fonte da verdade (o Supabase CLI aplica ela); o cliente
 * self-host recebe só o `baseline.sql`. Rodar o bloco da MIGRATION e exigir que
 * o baseline contenha o mesmo texto prova as duas coisas de uma vez: a limpeza
 * funciona, e os dois artefatos não divergiram.
 *
 * ## Idempotência
 *
 * As duas passadas acontecem na MESMA transação (a segunda re-aplica o mesmo
 * bloco, como o `update.sh` faz a cada atualização). O relatório é indexado por
 * `rodada`, então dá para afirmar que a segunda apaga 0 — e não apenas que "não
 * deu erro".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_LEAD, GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const MIGRATION =
  "supabase/migrations/20261026233000_0784_demanda_derivada_de_conversa_arquivada_sai.sql";

/** O corpo executável da migration: `do $$ … end $$;`. */
function blocoDaLimpeza(): string {
  const texto = readFileSync(join(process.cwd(), MIGRATION), "utf8");
  const inicio = texto.indexOf("do $$");
  const fim = texto.indexOf("end $$;", inicio);
  if (inicio < 0 || fim < 0) {
    throw new Error(`bloco \`do $$ … end $$;\` não encontrado em ${MIGRATION} (extração quebrada)`);
  }
  const bloco = texto.slice(inicio, fim + "end $$;".length);
  if (!/delete from public\.demandas d/.test(bloco)) {
    throw new Error("o bloco extraído não contém o `delete` — extração quebrada");
  }
  return bloco;
}

/** Segundo canal: a demanda que atravessou de canal precisa de duas conversas. */
const SEGUNDO_CANAL = "02992400-0000-4000-8000-000000000001";

type Caso = {
  caso: string;
  ct: string;
  /** Conversas da demanda: a primeira é a que carrega a assinatura do R2. */
  conversas: { id: string; status: string; sessao?: string }[];
  d: string;
  estado?: string;
  desfecho?: string;
  dono?: string;
  lead?: string;
};

/**
 * Um caso por motivo legítimo de existir (ou por resíduo). Cada contato tem as
 * suas próprias conversas porque `uniq_conversations_1to1_per_contact_session`
 * só admite uma 1:1 por (org, contato, canal).
 */
const ARQUIVADA: Caso = {
  caso: "arquivada",
  ct: "02992000-0000-4000-8000-000000000001",
  conversas: [{ id: "02992100-0000-4000-8000-000000000001", status: "archived" }],
  d: "02992300-0000-4000-8000-000000000001",
};
const ATIVA: Caso = {
  caso: "ativa",
  ct: "02992000-0000-4000-8000-000000000002",
  conversas: [{ id: "02992100-0000-4000-8000-000000000002", status: "open" }],
  d: "02992300-0000-4000-8000-000000000002",
};
const FECHADA: Caso = {
  caso: "fechada",
  ct: "02992000-0000-4000-8000-000000000003",
  conversas: [{ id: "02992100-0000-4000-8000-000000000003", status: "archived" }],
  d: "02992300-0000-4000-8000-000000000003",
  estado: "resolvida",
  desfecho: "resolvida",
};
const COM_DONO: Caso = {
  caso: "dono",
  ct: "02992000-0000-4000-8000-000000000004",
  conversas: [{ id: "02992100-0000-4000-8000-000000000004", status: "archived" }],
  d: "02992300-0000-4000-8000-000000000004",
  dono: GOV_AGENT_A,
};
const COM_CARD: Caso = {
  caso: "card",
  ct: "02992000-0000-4000-8000-000000000005",
  conversas: [{ id: "02992100-0000-4000-8000-000000000005", status: "archived" }],
  d: "02992300-0000-4000-8000-000000000005",
  lead: GOV_LEAD,
};
const REFERENCIADA: Caso = {
  caso: "referenciada",
  ct: "02992000-0000-4000-8000-000000000006",
  conversas: [{ id: "02992100-0000-4000-8000-000000000006", status: "archived" }],
  d: "02992300-0000-4000-8000-000000000006",
};
const DOIS_CANAIS: Caso = {
  caso: "dois-canais",
  ct: "02992000-0000-4000-8000-000000000007",
  conversas: [
    { id: "02992100-0000-4000-8000-000000000007", status: "archived" },
    { id: "02992100-0000-4000-8000-000000000077", status: "open", sessao: SEGUNDO_CANAL },
  ],
  d: "02992300-0000-4000-8000-000000000007",
};

const TODOS = [ARQUIVADA, ATIVA, FECHADA, COM_DONO, COM_CARD, REFERENCIADA, DOIS_CANAIS];
const SOBREVIVEM = TODOS.filter((c) => c !== ARQUIVADA);

function planta(c: Caso): string {
  const conversas = c.conversas
    .map(
      (cv) => `
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${cv.id}', '${GOV_ORG}', '${c.ct}', '${cv.sessao ?? GOV_SESSION}', '${cv.status}');`,
    )
    .join("\n");
  const vinculos = c.conversas
    .map(
      (cv) => `
      insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
        values ('${GOV_ORG}', '${c.d}', '${cv.id}');`,
    )
    .join("\n");
  return `
    insert into public.contacts (id, organization_id, display_name)
      values ('${c.ct}', '${GOV_ORG}', 'Resíduo 2992 - ${c.caso}');
    ${conversas}
    -- A assinatura do R2: aberta_em = created_at da conversa derivada.
    insert into public.demandas
      (id, organization_id, contact_id, aberta_em, origem, estado, dono_kind, dono_user_id, lead_id,
       desfecho, fechada_em)
    select '${c.d}', '${GOV_ORG}', '${c.ct}', cv.created_at, 'derivada', '${c.estado ?? "aberta"}',
           '${c.dono ? "humano" : "ia"}',
           ${c.dono ? `'${c.dono}'` : "null"},
           ${c.lead ? `'${c.lead}'` : "null"},
           ${c.desfecho ? `'${c.desfecho}'` : "null"},
           ${c.desfecho ? "now()" : "null"}
      from public.conversations cv where cv.id = '${c.conversas[0]!.id}';
    ${vinculos}
  `;
}

/**
 * Contagem por id (nunca por contato: o trigger da 0138 cria 'inbound' à parte).
 *
 * O psql também imprime as etiquetas de comando (`BEGIN`, `DO`, `ROLLBACK`); só
 * as linhas `rótulo:valor` interessam, e qualquer outra forma é ruído de
 * transação — nunca medida.
 */
function medir(script: string): Record<string, number> {
  const out = sql(script);
  const medidas: Record<string, number> = {};
  for (const linha of out.split("\n")) {
    const texto = linha.trim();
    const m = /^([a-z0-9_-]+):(-?\d+)$/.exec(texto);
    if (!m) continue;
    medidas[m[1]!] = Number(m[2]);
  }
  return medidas;
}

beforeAll(() => {
  seedGov();
  // Canal novo: só o caso "dois-canais" usa, e é ele que separa "arquivada com
  // vínculo vivo" de "arquivada e só arquivada".
  sql(`
    do $cv$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SEGUNDO_CANAL}', '${GOV_ORG}', 'gov-inv-segundo', '\\x00'::bytea);
    exception when unique_violation then null; end $cv$;
  `);
  const contatos = TODOS.map((c) => `'${c.ct}'`).join(", ");
  const conversas = TODOS.flatMap((c) => c.conversas.map((cv) => `'${cv.id}'`)).join(", ");
  const demandas = TODOS.map((c) => `'${c.d}'`).join(", ");
  sql(`
    delete from public.demanda_conversas where conversation_id in (${conversas});
    delete from public.demandas where id in (${demandas});
    delete from public.messages where conversation_id in (${conversas});
    delete from public.conversations where id in (${conversas});
    delete from public.contacts where id in (${contatos});
    ${TODOS.map(planta).join("\n")}
    -- Referência de mensagem: o passo 4 da 0222 carimba a demanda vigente na
    -- mensagem, e apagá-la zeraria esse vínculo (on delete set null).
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, sent_via, body, sent_at)
    values ('${GOV_ORG}', '${REFERENCIADA.conversas[0]!.id}', '${GOV_SESSION}', '${REFERENCIADA.ct}',
            'text', 'inbound', 'received', 'ai', 'oi', now());
    update public.messages set demanda_id = '${REFERENCIADA.d}'
     where conversation_id = '${REFERENCIADA.conversas[0]!.id}';
  `);
});

describe("a limpeza da #2992 apaga o resíduo e poupa a demanda legítima", () => {
  it("precondição: os sete casos existem, abertos como o backfill antigo os deixou", () => {
    const ids = TODOS.map((c) => `'${c.d}'`).join(", ");
    expect(Number(sql(`select count(*) from public.demandas where id in (${ids});`))).toBe(7);
    expect(
      Number(
        sql(`select count(*) from public.demandas
              where id in (${ids}) and origem = 'derivada';`),
      ),
    ).toBe(7);
    // A precondição do caso que SAI: a conversa está mesmo arquivada e o vínculo existe.
    expect(
      Number(
        sql(`select count(*) from public.conversations
              where id = '${ARQUIVADA.conversas[0]!.id}' and status = 'archived';`),
      ),
    ).toBe(1);
  });

  it("o espelho: o baseline carrega o MESMO bloco da migration, byte a byte", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    expect(baseline.includes(blocoDaLimpeza())).toBe(true);
  });

  it("o bloco da migration roda duas vezes: a primeira apaga o resíduo, a segunda nada", () => {
    const porId = (rotulo: string, caso: Caso) =>
      `select '${rotulo}:' || count(*) from public.demandas where id = '${caso.d}';`;
    const rel = (rotulo: string, rodada: number) =>
      `select '${rotulo}:' || coalesce(sum(apagadas), 0) from _limpeza_2992 where rodada = ${rodada};`;

    const m = medir(`
      begin;
      ${blocoDaLimpeza()}
      ${porId("r1_arquivada", ARQUIVADA)}
      ${SOBREVIVEM.map((c) => porId(`r1_${c.caso}`, c)).join("\n")}
      select 'r1_vinculo_apagado:' || count(*) from public.demanda_conversas
       where demanda_id = '${ARQUIVADA.d}';
      select 'r1_rel_linhas:' || count(*) from _limpeza_2992 where rodada = 1;
      select 'r1_rel_orgs:' || count(distinct organization_id) from _limpeza_2992 where rodada = 1;
      ${rel("r1_rel_total", 1)}
      ${blocoDaLimpeza()}
      ${porId("r2_arquivada", ARQUIVADA)}
      ${SOBREVIVEM.map((c) => porId(`r2_${c.caso}`, c)).join("\n")}
      select 'r2_rel_linhas:' || count(*) from _limpeza_2992 where rodada = 2;
      ${rel("r2_rel_total", 2)}
      rollback;
    `);

    // ⭐ o resíduo sai — e o vínculo dele vai junto (cascade), sem sobrar órfão.
    expect(m.r1_arquivada).toBe(0);
    expect(m.r1_vinculo_apagado).toBe(0);

    // ⭐ o que não pode quebrar fica: conversa viva, desfecho, dono humano, card,
    // referência de mensagem e demanda que atravessou para outro canal.
    for (const c of SOBREVIVEM) {
      expect(m[`r1_${c.caso}`], `a demanda do caso "${c.caso}" foi apagada`).toBe(1);
    }

    // O relatório diz o que saiu: uma linha, uma organização, uma demanda.
    expect(m.r1_rel_linhas).toBe(1);
    expect(m.r1_rel_orgs).toBe(1);
    expect(m.r1_rel_total).toBe(1);

    // ⭐ idempotência: a segunda passada não acha nada que case.
    expect(m.r2_rel_linhas).toBe(0);
    expect(m.r2_rel_total).toBe(0);
    expect(m.r2_arquivada).toBe(0);
    for (const c of SOBREVIVEM) expect(m[`r2_${c.caso}`]).toBe(1);
  });

  it("o relatório aponta a organização da demanda apagada (não só o total)", () => {
    const m = medir(`
      begin;
      ${blocoDaLimpeza()}
      select 'org_apagada:' || count(*) from _limpeza_2992
       where rodada = 1 and organization_id = '${GOV_ORG}' and apagadas = 1;
      select 'rel_apagadas_soma_igual_linhas_removidas:' || (
        select count(*) from public.demandas where id = '${ARQUIVADA.d}');
      rollback;
    `);
    expect(m.org_apagada).toBe(1);
    expect(m.rel_apagadas_soma_igual_linhas_removidas).toBe(0);
  });
});
