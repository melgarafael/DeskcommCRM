/**
 * ATUALIZAR O CRM NÃO DESLIGA O LEMBRETE QUE O OPERADOR LIGOU — provado
 * re-aplicando o `baseline.sql` INTEIRO, que é o que o `update.sh` faz.
 *
 * ## O defeito (PR #847)
 *
 * A 0194 pôs `calendar_event_types.reminder_enabled` em `default false` e, no
 * mesmo bloco, rodava `update … set reminder_enabled = false where … is true`
 * sem guarda. O `update.sh` re-aplica o baseline a cada atualização, então
 * toda atualização desligava o lembrete de todo tipo em que alguém o tinha
 * ligado — sem erro, sem log. A 0255 pôs a correção de histórico atrás do
 * `column_default`: ela só roda enquanto o default ainda não é `false`, que é o
 * único momento em que `true` não pode ter vindo de uma escolha.
 *
 * ## Por que o baseline inteiro, e não o bloco recortado
 *
 * O teste que veio com o PR (`tests/unit/atualizar-nao-desliga-o-lembrete.test.ts`)
 * lê o texto do bloco e confere a ordem "lê o default → grava o default" DENTRO
 * dele. Ele fica verde se um bloco ANTERIOR do arquivo gravar `set default
 * false`: quando a guarda do nosso bloco lê o catálogo, o default já é `false`,
 * a condição é sempre falsa e um clone de antes da 0194 nunca recebe a correção.
 * Recortar só o bloco e executá-lo aqui teria o MESMO ponto cego — o bloco
 * anterior não rodaria. Por isso a unidade de execução é o arquivo inteiro, na
 * ordem do arquivo, como na máquina do cliente.
 *
 * ## Os dois sentidos
 *
 *   (a) instalação que já atualizou (default `false`), operador ligou o
 *       lembrete → re-aplicar → continua `true`. Pega a volta do `update` solto.
 *   (b) clone de antes da 0194 (default ainda `true`, histórico `true` que
 *       ninguém escolheu) → re-aplicar → vira `false`. Pega a guarda que nunca
 *       dispara — inclusive por um `set default false` plantado antes do bloco.
 *
 * Cada caso confere o próprio ponto de partida antes de re-aplicar: sem isso, um
 * banco que já chegasse no estado final deixaria o caso verde por vacuidade.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

const ORG = "a8470000-0000-4000-8000-000000000847";
const TIPO_LIGADO_PELO_OPERADOR = "a8470000-0000-4000-8000-0000000000a1";
const TIPO_DO_HISTORICO = "a8470000-0000-4000-8000-0000000000b1";

/** Re-aplicar o baseline leva dezenas de segundos sob carga — o default de 30s não cabe. */
const TEMPO_DE_UM_UPDATE = 300_000;

/**
 * Uma passada do `update.sh`: o arquivo inteiro, numa sessão, com
 * `ON_ERROR_STOP=1`. O `scripts/test-db.sh` já prova que a re-aplicação não
 * erra; aqui a flag garante que um erro no meio não deixe o caso medindo um
 * arquivo aplicado pela metade.
 */
function reaplicarOBaseline(): void {
  const psqlLocal = process.env.TEST_DB_PSQL;
  const container = process.env.TEST_DB_CONTAINER;
  const argsPsql = ["-v", "ON_ERROR_STOP=1", "-q", "-f", "-"];
  const [bin, args] = psqlLocal
    ? [psqlLocal, [process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres", ...argsPsql]]
    : ["docker", ["exec", "-i", container as string, "psql", "-U", "postgres", "-d", "postgres", ...argsPsql]];

  const r = spawnSync(bin, args, {
    input: readFileSync(BASELINE),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(r.error, "não consegui executar o psql").toBeUndefined();
  expect(r.status, `re-aplicar o baseline falhou:\n${r.stderr.slice(-2000)}`).toBe(0);
}

function defaultDaColuna(): string {
  return sql(`
    select column_default from information_schema.columns
     where table_schema = 'public'
       and table_name = 'calendar_event_types'
       and column_name = 'reminder_enabled';
  `);
}

function lembreteDo(tipo: string): string {
  return sql(`select reminder_enabled from public.calendar_event_types where id = '${tipo}';`);
}

describe("o lembrete sobrevive a um update.sh", () => {
  beforeAll(() => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'inv-847-lembrete', 'Lembrete LTDA', 'Lembrete', '{}'::jsonb)
      on conflict (id) do nothing;
    `);
  });

  it(
    "(a) instalação que já atualizou: o lembrete que o operador ligou continua ligado",
    () => {
      // Ponto de partida: o molde já recebeu o baseline duas vezes, então o
      // default é `false` — é a instalação que qualquer cliente tem hoje.
      expect(defaultDaColuna(), "o banco não está no estado de uma instalação atualizada").toBe("false");

      // O operador ligou o lembrete deste tipo.
      sql(`
        insert into public.calendar_event_types (id, organization_id, name, slug, reminder_enabled)
        values ('${TIPO_LIGADO_PELO_OPERADOR}', '${ORG}', 'Consulta', 'consulta-847', true);
      `);
      expect(lembreteDo(TIPO_LIGADO_PELO_OPERADOR)).toBe("t");

      reaplicarOBaseline();

      expect(
        lembreteDo(TIPO_LIGADO_PELO_OPERADOR),
        "a atualização desligou o lembrete que o operador tinha ligado — o cliente deixa de ser avisado do compromisso, sem erro e sem log",
      ).toBe("t");
      expect(defaultDaColuna()).toBe("false");
    },
    TEMPO_DE_UM_UPDATE,
  );

  it(
    "(b) clone de antes da 0194: o histórico que ninguém escolheu é corrigido para desligado",
    () => {
      // Ponto de partida de um clone entre a 0177 (tabela nasce com default
      // `true`) e a 0194: o default ainda é `true` e as linhas antigas herdaram
      // `true` sem ninguém ter escolhido.
      sql(`alter table public.calendar_event_types alter column reminder_enabled set default true;`);
      sql(`
        insert into public.calendar_event_types (id, organization_id, name, slug)
        values ('${TIPO_DO_HISTORICO}', '${ORG}', 'Retorno', 'retorno-847');
      `);
      expect(defaultDaColuna(), "não consegui montar o clone pré-0194").toBe("true");
      expect(lembreteDo(TIPO_DO_HISTORICO)).toBe("t");

      reaplicarOBaseline();

      expect(
        lembreteDo(TIPO_DO_HISTORICO),
        "o clone de antes da 0194 não recebeu a correção do histórico — a guarda leu um default que já tinha sido gravado",
      ).toBe("f");
      expect(defaultDaColuna(), "o default não voltou a nascer desligado").toBe("false");
    },
    TEMPO_DE_UM_UPDATE,
  );
});
