/**
 * A AUTO-CURA DA 0392 NÃO APAGA A DUPLICATA QUE JÁ É REFERÊNCIA.
 *
 * `atualizacao-nao-reduplica-demanda.test.ts` prova que o `update.sh` para de
 * duplicar e que a duplicata intocada sai. Este arquivo prova o outro limite da
 * cura (arquivo novo porque `tests/invariants/**` é congelado para edição).
 *
 * ## O defeito que ele barra (achado na revisão do PR #1516)
 *
 * A cura julgava "intocada" só pelas colunas da própria demanda. O passo 2 do
 * backfill da 0222 escolhe a vigente pelo maior `aberta_em`; a duplicata tem
 * `cv.created_at` e a 'inbound' tem o `sent_at` do WAHA (segundos, anterior ao
 * insert da conversa) — então a duplicata costuma virar `current_demanda_id`, e
 * o passo 4 carimba `messages.demanda_id` com ela. Apagá-la zera essas
 * referências (`on delete set null`): a próxima entrada abre outra demanda, e o
 * acompanhamento com fronteira nela é cancelado como vencido
 * (`fn_meet_boundary_current`).
 *
 * ## Qual caso guarda o quê
 *
 *   controle: a duplicata SEM referência ainda sai — o bloco extraído cura de
 *     fato (e o `if` que protege o install deixa o `delete` rodar). Sem ele, os
 *     casos seguintes ficariam verdes com a cura inteira desligada.
 *   vigente / mensagem / checkpoint: cada um planta UMA referência, para que
 *     cada `not exists` da cura tenha o seu caso vermelho quando some.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

const MARCADOR_INICIO = "-- ---- Índice de Atrito + DEMANDAS";
/** Todo rótulo de bloco do apêndice tem esta forma; o próximo encerra o nosso. */
const MARCADOR_PROXIMO = "\n-- ---- ";

/** O bloco do apêndice que o `update.sh` re-aplica, lido do arquivo de verdade. */
function blocoDoApendice(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(MARCADOR_INICIO);
  if (inicio < 0) {
    throw new Error(`marcador ${MARCADOR_INICIO} não encontrado em supabase/baseline.sql`);
  }
  const fim = baseline.indexOf(MARCADOR_PROXIMO, inicio + MARCADOR_INICIO.length);
  const bloco = fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim);
  if (!/delete from public\.demandas d/.test(bloco)) {
    throw new Error("bloco extraído não contém a auto-cura (extração quebrada)");
  }
  return bloco;
}

// Namespace pela migration (0392); `dddd` para não colidir com o arquivo irmão.
const CASOS = [
  { caso: "controle", ct: "0392dddd-0000-4000-8000-000000000001", cv: "0392dddd-1111-4000-8000-000000000001", dup: "0392dddd-2222-4000-8000-000000000001" },
  { caso: "vigente", ct: "0392dddd-0000-4000-8000-000000000002", cv: "0392dddd-1111-4000-8000-000000000002", dup: "0392dddd-2222-4000-8000-000000000002" },
  { caso: "mensagem", ct: "0392dddd-0000-4000-8000-000000000003", cv: "0392dddd-1111-4000-8000-000000000003", dup: "0392dddd-2222-4000-8000-000000000003" },
  { caso: "checkpoint", ct: "0392dddd-0000-4000-8000-000000000004", cv: "0392dddd-1111-4000-8000-000000000004", dup: "0392dddd-2222-4000-8000-000000000004" },
] as const;
const [CONTROLE, VIGENTE, MENSAGEM, CHECKPOINT] = CASOS;
const REFERENCIADAS = [VIGENTE, MENSAGEM, CHECKPOINT];

/** Re-aplica o bloco numa transação revertida e devolve quantas demandas o contato tem depois. */
function demandasDepoisDeReaplicar(contato: string): number {
  const saida = sql(`
    begin;
    ${blocoDoApendice()}
    select count(*) from public.demandas where contact_id = '${contato}';
    rollback;
  `);
  const numeros = saida
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l));
  const ultimo = numeros[numeros.length - 1];
  if (ultimo === undefined) throw new Error(`nenhuma contagem na saída do psql: ${saida}`);
  return Number(ultimo);
}

function contar(consulta: string): number {
  return Number(lastLine(sql(consulta)));
}

beforeAll(() => {
  seedGov();
  const contatos = CASOS.map((c) => `'${c.ct}'`).join(", ");
  const conversas = CASOS.map((c) => `'${c.cv}'`).join(", ");
  sql(`
    delete from public.lead_checkpoints where contact_id in (${contatos});
    delete from public.demanda_conversas where conversation_id in (${conversas});
    delete from public.demandas where contact_id in (${contatos});
    delete from public.messages where conversation_id in (${conversas});
    delete from public.conversations where id in (${conversas});
    delete from public.contacts where id in (${contatos});
  `);
  // A 'inbound' vem do trigger da entrada, pelo caminho de produção; a
  // duplicata nasce DEPOIS, como o `update.sh` antigo a criava.
  for (const c of CASOS) {
    sql(`
      insert into public.contacts (id, organization_id, display_name)
        values ('${c.ct}', '${GOV_ORG}', 'Cura poupa referenciada - ${c.caso}');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${c.cv}', '${GOV_ORG}', '${c.ct}', '${GOV_SESSION}', 'open');
      insert into public.messages
        (organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, sent_via, body, sent_at)
      values ('${GOV_ORG}', '${c.cv}', '${GOV_SESSION}', '${c.ct}',
              'text', 'inbound', 'received', 'ai', 'oi', now());
      insert into public.demandas
        (id, organization_id, contact_id, aberta_em, origem, estado, dono_kind)
      select '${c.dup}', '${GOV_ORG}', '${c.ct}', cv.created_at, 'derivada', 'aberta', 'ia'
        from public.conversations cv where cv.id = '${c.cv}';
      insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
        values ('${GOV_ORG}', '${c.dup}', '${c.cv}');
    `);
  }
  // O que o passo 2 e o passo 4 da 0222 fazem quando a duplicata vence, e o
  // checkpoint do turno que o agente grava com a demanda vigente.
  sql(`
    update public.conversations set current_demanda_id = '${VIGENTE.dup}' where id = '${VIGENTE.cv}';
    update public.messages set demanda_id = '${MENSAGEM.dup}' where conversation_id = '${MENSAGEM.cv}';
    insert into public.lead_checkpoints (organization_id, contact_id, conversation_id, demanda_id)
      values ('${GOV_ORG}', '${CHECKPOINT.ct}', '${CHECKPOINT.cv}', '${CHECKPOINT.dup}');
  `);
});

describe("a auto-cura da 0392 poupa a duplicata que já é referência", () => {
  it("precondição: cada contato tem a 'inbound' do trigger e a duplicata", () => {
    for (const c of CASOS) {
      expect(contar(`select count(*) from public.demandas where contact_id = '${c.ct}';`)).toBe(2);
    }
    // Nenhuma referência à duplicata do controle: é ele que prova que a cura roda.
    expect(
      contar(`
        select (select count(*) from public.conversations where current_demanda_id = '${CONTROLE.dup}')
             + (select count(*) from public.messages where demanda_id = '${CONTROLE.dup}');
      `),
    ).toBe(0);
  });

  it("controle: a duplicata que ninguém referencia sai", () => {
    expect(demandasDepoisDeReaplicar(CONTROLE.ct)).toBe(1);
  });

  it.each(REFERENCIADAS)("a duplicata referenciada fica ($caso)", ({ ct, dup }) => {
    // A referência plantada está lá — sem ela o caso fica verde por vácuo.
    expect(
      contar(`
        select (select count(*) from public.conversations where current_demanda_id = '${dup}')
             + (select count(*) from public.messages where demanda_id = '${dup}')
             + (select count(*) from public.lead_checkpoints where demanda_id = '${dup}');
      `),
    ).toBeGreaterThan(0);
    // Apagada, a referência viraria NULL por `on delete set null`.
    expect(demandasDepoisDeReaplicar(ct)).toBe(2);
  });
});
