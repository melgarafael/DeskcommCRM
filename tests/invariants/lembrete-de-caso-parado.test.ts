/**
 * LEMBRETE DE CASO PARADO: UM RELÓGIO POR ESPERA E A CADÊNCIA DA ORGANIZAÇÃO
 * (migration 0766; ideia de @Atlasads no PR #2584).
 *
 * O `route.test.ts` do `case-stale-watcher` mede o que a rota faz com cada caso
 * vencido. Quem decide QUAL caso venceu é o banco — o gatilho
 * `trg_caso_marca_inicio_da_espera` e a função `fn_casos_parados_para_lembrar`
 * —, e isso só se prova no Postgres real (o efêmero do `scripts/test-db.sh`,
 * com o `baseline.sql` aplicado em install e update):
 *
 *   1. caso que nasce esperando a equipe começa a contar agora, com zero avisos;
 *   2. o aviso N vence em `espera_desde + N × intervalo` (e não antes);
 *   3. o teto, o liga/desliga e o intervalo são os da ORGANIZAÇÃO;
 *   4. o defeito do #2584: um caso já cobrado até o teto que vai ao cliente e
 *      VOLTA ganha relógio e teto novos — e `followup_attempts`, o total da vida
 *      do caso que o Índice de Atrito lê, não zera;
 *   5. a cobrança (que muda só os contadores) não move o relógio;
 *   6. o backfill da atualização começa em `now()` e herda os avisos já dados;
 *   7. a faixa da cadência é segurada pelo banco;
 *   8. a função não é alcançável pela anon key nem por quem está logado.
 *
 *   pnpm test:db tests/invariants/lembrete-de-caso-parado.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "0766aa00-0000-4000-8000-000000000001";
const ORG_CURTA = "0766aa00-0000-4000-8000-000000000002";
const ORG_DESLIGADA = "0766aa00-0000-4000-8000-000000000003";
const ORGS = [ORG, ORG_CURTA, ORG_DESLIGADA];

const SESSAO = "0766aa00-1111-4000-8000-00000000000";
const CONTATO = "0766aa00-2222-4000-8000-00000000000";
const CONVERSA = "0766aa00-3333-4000-8000-00000000000";

const CASO_NOVO = "0766aa00-4444-4000-8000-000000000001";
const CASO_25H = "0766aa00-4444-4000-8000-000000000002";
const CASO_1_AVISO_30H = "0766aa00-4444-4000-8000-000000000003";
const CASO_1_AVISO_49H = "0766aa00-4444-4000-8000-000000000004";
const CASO_NO_TETO = "0766aa00-4444-4000-8000-000000000005";
const CASO_ORG_CURTA = "0766aa00-4444-4000-8000-000000000006";
const CASO_ORG_DESLIGADA = "0766aa00-4444-4000-8000-000000000007";
const CASO_QUE_VOLTA = "0766aa00-4444-4000-8000-000000000008";
const CASO_DO_BACKFILL = "0766aa00-4444-4000-8000-000000000009";

const MIGRATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261024085228_0766_lembretes_de_caso_parado.sql",
);

/** Última linha do psql (`-tA`). */
function ultima(saida: string): string {
  return saida.split("\n").at(-1)?.trim() ?? "";
}

/** Os casos DESTE arquivo que a função devolve agora, em ordem. */
function vencidos(): string[] {
  const saida = sql(`
    select id from public.fn_casos_parados_para_lembrar(1000)
     where organization_id in (${ORGS.map((o) => `'${o}'`).join(",")})
     order by id;`);
  return saida ? saida.split("\n").map((l) => l.trim()) : [];
}

function coluna(caso: string, expr: string): string {
  return ultima(sql(`select (${expr})::text from public.agent_cases where id = '${caso}';`));
}

/** Põe o relógio da espera no passado sem tocar no status (o gatilho não dispara). */
function esperaHa(caso: string, horas: number, cobrancas: number): void {
  sql(`update public.agent_cases
          set espera_desde = now() - interval '${horas} hours', cobrancas_na_espera = ${cobrancas}
        where id = '${caso}';`);
}

beforeAll(() => {
  const n = [1, 2, 3];
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-0766-a', 'Invariante 0766 A', 'Invariante 0766 A'),
      ('${ORG_CURTA}', 'inv-0766-b', 'Invariante 0766 B', 'Invariante 0766 B'),
      ('${ORG_DESLIGADA}', 'inv-0766-c', 'Invariante 0766 C', 'Invariante 0766 C')
      on conflict do nothing;
    update public.organizations set lembrete_caso_intervalo_horas = 2, lembrete_caso_teto = 1 where id = '${ORG_CURTA}';
    update public.organizations set lembrete_caso_ligado = false where id = '${ORG_DESLIGADA}';

    ${n
      .map(
        (i) => `
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}${i}', '${ORGS[i - 1]}', 'inv-0766-${i}', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}${i}', '${ORGS[i - 1]}', 'Invariante 0766 Contato ${i}') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}${i}', '${ORGS[i - 1]}', '${CONTATO}${i}', '${SESSAO}${i}', 'open') on conflict do nothing;`,
      )
      .join("\n")}

    insert into public.agent_cases (id, organization_id, conversation_id, status, source, title, summary, blocker) values
      ('${CASO_NOVO}',          '${ORG}',           '${CONVERSA}1', 'awaiting_human', 'agent', 'novo', 'r', 'b'),
      ('${CASO_25H}',           '${ORG}',           '${CONVERSA}1', 'awaiting_human', 'agent', '25h', 'r', 'b'),
      ('${CASO_1_AVISO_30H}',   '${ORG}',           '${CONVERSA}1', 'awaiting_human', 'agent', '1 aviso 30h', 'r', 'b'),
      ('${CASO_1_AVISO_49H}',   '${ORG}',           '${CONVERSA}1', 'awaiting_human', 'agent', '1 aviso 49h', 'r', 'b'),
      ('${CASO_NO_TETO}',       '${ORG}',           '${CONVERSA}1', 'awaiting_human', 'agent', 'no teto', 'r', 'b'),
      ('${CASO_ORG_CURTA}',     '${ORG_CURTA}',     '${CONVERSA}2', 'awaiting_human', 'agent', 'org curta', 'r', 'b'),
      ('${CASO_ORG_DESLIGADA}', '${ORG_DESLIGADA}', '${CONVERSA}3', 'awaiting_human', 'agent', 'desligada', 'r', 'b'),
      ('${CASO_QUE_VOLTA}',     '${ORG}',           '${CONVERSA}1', 'awaiting_human', 'agent', 'volta', 'r', 'b'),
      ('${CASO_DO_BACKFILL}',   '${ORG}',           '${CONVERSA}1', 'awaiting_human', 'agent', 'backfill', 'r', 'b')
      on conflict do nothing;
  `);
});

describe("0766 — lembrete de caso parado, medido no Postgres real", () => {
  it("1. o caso que nasce esperando a equipe começa a contar agora, com zero avisos", () => {
    expect(coluna(CASO_NOVO, "espera_desde > now() - interval '5 minutes'")).toBe("true");
    expect(coluna(CASO_NOVO, "cobrancas_na_espera")).toBe("0");
    expect(vencidos()).not.toContain(CASO_NOVO);
  });

  it("2. o aviso N vence em espera_desde + N × intervalo, e não antes", () => {
    esperaHa(CASO_25H, 25, 0);
    esperaHa(CASO_1_AVISO_30H, 30, 1);
    esperaHa(CASO_1_AVISO_49H, 49, 1);

    const v = vencidos();
    expect(v).toContain(CASO_25H);
    // O segundo aviso pede 48 h desde o início da espera: 30 h ainda não basta.
    expect(v).not.toContain(CASO_1_AVISO_30H);
    expect(v).toContain(CASO_1_AVISO_49H);
    expect(
      ultima(sql(`select teto from public.fn_casos_parados_para_lembrar(1000) where id = '${CASO_25H}';`)),
    ).toBe("3");
  });

  it("3. teto, liga/desliga e intervalo são os da organização", () => {
    esperaHa(CASO_NO_TETO, 500, 3);
    esperaHa(CASO_ORG_CURTA, 3, 0);
    esperaHa(CASO_ORG_DESLIGADA, 500, 0);

    const v = vencidos();
    expect(v).not.toContain(CASO_NO_TETO);
    // Org com intervalo de 2 h: três horas de espera já venceram o primeiro.
    expect(v).toContain(CASO_ORG_CURTA);
    expect(v).not.toContain(CASO_ORG_DESLIGADA);

    // Teto 1 na org curta: depois do primeiro aviso, nada mais nesta espera.
    esperaHa(CASO_ORG_CURTA, 500, 1);
    expect(vencidos()).not.toContain(CASO_ORG_CURTA);
  });

  it("4. o caso que vai ao cliente e volta ganha relógio e teto novos; o total da vida fica", () => {
    sql(`update public.agent_cases set followup_attempts = 3 where id = '${CASO_QUE_VOLTA}';`);
    esperaHa(CASO_QUE_VOLTA, 200, 3);
    expect(vencidos()).not.toContain(CASO_QUE_VOLTA);

    sql(`update public.agent_cases set status = 'awaiting_lead' where id = '${CASO_QUE_VOLTA}';`);
    sql(`update public.agent_cases set status = 'awaiting_human' where id = '${CASO_QUE_VOLTA}';`);

    expect(coluna(CASO_QUE_VOLTA, "espera_desde > now() - interval '5 minutes'")).toBe("true");
    expect(coluna(CASO_QUE_VOLTA, "cobrancas_na_espera")).toBe("0");
    expect(coluna(CASO_QUE_VOLTA, "followup_attempts")).toBe("3");

    // E a espera nova é cobrada quando vencer, apesar dos três avisos antigos.
    sql(`update public.agent_cases set espera_desde = now() - interval '25 hours' where id = '${CASO_QUE_VOLTA}';`);
    expect(vencidos()).toContain(CASO_QUE_VOLTA);
  });

  it("5. a cobrança muda só os contadores e não move o relógio", () => {
    esperaHa(CASO_25H, 25, 0);
    const antes = coluna(CASO_25H, "espera_desde");
    sql(`update public.agent_cases
            set followup_attempts = followup_attempts + 1, cobrancas_na_espera = 1
          where id = '${CASO_25H}' and status = 'awaiting_human';`);
    expect(coluna(CASO_25H, "espera_desde")).toBe(antes);
    expect(coluna(CASO_25H, "cobrancas_na_espera")).toBe("1");

    // Reescrever o MESMO status também não é "voltar para a equipe".
    sql(`update public.agent_cases set status = 'awaiting_human' where id = '${CASO_25H}';`);
    expect(coluna(CASO_25H, "espera_desde")).toBe(antes);
  });

  it("6. o backfill da atualização começa em now() e herda os avisos já dados", () => {
    // O estado de um clone antes da 0766: sem relógio, com avisos do contador antigo.
    sql(`update public.agent_cases set espera_desde = null, cobrancas_na_espera = 0, followup_attempts = 2
          where id = '${CASO_DO_BACKFILL}';`);
    esperaHa(CASO_25H, 25, 1);
    const relogioDeQuemJaTinha = coluna(CASO_25H, "espera_desde");

    const texto = readFileSync(MIGRATION, "utf8");
    const backfill = texto.match(/update public\.agent_cases\s+set espera_desde = now\(\),[\s\S]*?;/)?.[0];
    expect(backfill, "INSTRUMENTO: o backfill não foi achado na migration").toBeTruthy();
    sql(backfill as string);

    expect(coluna(CASO_DO_BACKFILL, "espera_desde > now() - interval '5 minutes'")).toBe("true");
    expect(coluna(CASO_DO_BACKFILL, "cobrancas_na_espera")).toBe("2");
    expect(vencidos()).not.toContain(CASO_DO_BACKFILL);
    // Re-aplicar (o update.sh re-aplica o baseline) não reinicia quem já tem relógio.
    expect(coluna(CASO_25H, "espera_desde")).toBe(relogioDeQuemJaTinha);
  });

  it("7. a faixa da cadência é segurada pelo banco", () => {
    for (const atribuicao of [
      "lembrete_caso_intervalo_horas = 0",
      "lembrete_caso_intervalo_horas = 169",
      "lembrete_caso_teto = 0",
      "lembrete_caso_teto = 11",
    ]) {
      let motivo = "";
      try {
        sql(`update public.organizations set ${atribuicao} where id = '${ORG}';`);
      } catch (e) {
        motivo = motivoDoErro(e);
      }
      expect(motivo, atribuicao).toMatch(/organizations_lembrete_caso_(intervalo|teto)_check/);
    }
  });

  it("8. a função não é alcançável pela anon key nem por quem está logado", () => {
    const linha = ultima(
      sql(`select string_agg(r || '=' || has_function_privilege(r, 'public.fn_casos_parados_para_lembrar(integer)', 'execute')::text, ',' order by r)
             from unnest(array['anon','authenticated','service_role']) r;`),
    );
    expect(linha).toBe("anon=false,authenticated=false,service_role=true");
  });
});
