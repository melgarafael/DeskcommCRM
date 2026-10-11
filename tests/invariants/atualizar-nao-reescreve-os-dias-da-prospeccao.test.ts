/**
 * ATUALIZAR O CRM NÃO REESCREVE OS DIAS DA PROSPECÇÃO QUE O OPERADOR ESCOLHEU —
 * provado re-aplicando o `baseline.sql` INTEIRO, que é o que o `update.sh` faz.
 *
 * ## O defeito (PR #2699, achado na triagem)
 *
 * A 0642 cria `channel_knobs.prospeccao_dias` e congela seg–sáb para quem tinha
 * `allow_sunday = false`. Na primeira versão o backfill era um `update` solto,
 * guardado só por "a linha ainda está no padrão" (`{0..6}`). Só que `{0..6}` é
 * também o que o operador grava quando marca todos os dias — então cada
 * atualização reescrevia a escolha dele de volta para seg–sáb. E quem só
 * desligava o domingo da RESPOSTA perdia o domingo da prospecção na
 * atualização seguinte: o `update.sh` re-amarrava as duas decisões que o PR
 * desamarrou. O conserto põe o backfill atrás de "a coluna ainda não existe",
 * o único momento em que `{0..6}` não pode ter vindo de uma escolha.
 *
 * Por que o baseline inteiro, e não o bloco recortado: ver
 * `atualizar-nao-desliga-o-lembrete.test.ts`, que é o mesmo defeito em outra
 * coluna (PR #847).
 *
 * ## Os dois sentidos
 *
 *   (a) instalação já atualizada, domingo da resposta desligado e todos os dias
 *       marcados na prospecção → re-aplicar → continua `{0..6}`. Pega a volta
 *       do backfill solto.
 *   (b) clone de antes da 0642 (sem a coluna), domingo desligado → re-aplicar
 *       → seg–sáb; domingo ligado → todos os dias. Pega a guarda que nunca
 *       dispara.
 *
 * Cada caso confere o próprio ponto de partida antes de re-aplicar.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

const ORG = "a2699000-0000-4000-8000-000000002699";
const CANAL_ESCOLHEU_TODOS = "a2699000-0000-4000-8000-0000000000a1";
const CANAL_SEM_DOMINGO = "a2699000-0000-4000-8000-0000000000b1";
const CANAL_COM_DOMINGO = "a2699000-0000-4000-8000-0000000000b2";

/** Re-aplicar o baseline leva dezenas de segundos sob carga — o default de 30s não cabe. */
const TEMPO_DE_UM_UPDATE = 300_000;

/** Uma passada do `update.sh`: o arquivo inteiro, numa sessão, com `ON_ERROR_STOP=1`. */
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

function canal(id: string, allowSunday: boolean): void {
  sql(`
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
    values ('${id}', '${ORG}', '${id}', '\\x00');
    insert into public.channel_knobs (organization_id, channel_session_id, allow_sunday)
    values ('${ORG}', '${id}', ${allowSunday});
  `);
}

function diasDo(id: string): string {
  return sql(`select prospeccao_dias::text from public.channel_knobs where channel_session_id = '${id}';`);
}

describe("os dias da prospecção sobrevivem a um update.sh", () => {
  beforeAll(() => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'inv-2699-dias', 'Dias LTDA', 'Dias', '{}'::jsonb)
      on conflict (id) do nothing;
    `);
  });

  it(
    "(a) instalação atualizada: todos os dias marcados com o domingo da resposta desligado continuam todos os dias",
    () => {
      canal(CANAL_ESCOLHEU_TODOS, false);
      sql(`update public.channel_knobs set prospeccao_dias = '{0,1,2,3,4,5,6}' where channel_session_id = '${CANAL_ESCOLHEU_TODOS}';`);
      expect(diasDo(CANAL_ESCOLHEU_TODOS)).toBe("{0,1,2,3,4,5,6}");

      reaplicarOBaseline();

      expect(
        diasDo(CANAL_ESCOLHEU_TODOS),
        "a atualização tirou o domingo da prospecção que o operador tinha marcado — o update.sh re-amarrou o domingo da resposta ao da prospecção",
      ).toBe("{0,1,2,3,4,5,6}");
    },
    TEMPO_DE_UM_UPDATE,
  );

  it(
    "(b) clone de antes da 0642: quem não enviava aos domingos prospecta de seg a sáb, o resto todos os dias",
    () => {
      sql(`alter table public.channel_knobs drop column prospeccao_dias;`);
      canal(CANAL_SEM_DOMINGO, false);
      canal(CANAL_COM_DOMINGO, true);
      expect(
        sql(`
          select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'channel_knobs' and column_name = 'prospeccao_dias';
        `),
        "não consegui montar o clone pré-0642",
      ).toBe("0");

      reaplicarOBaseline();

      expect(diasDo(CANAL_SEM_DOMINGO), "o clone de antes da 0642 não recebeu o backfill").toBe("{1,2,3,4,5,6}");
      expect(diasDo(CANAL_COM_DOMINGO)).toBe("{0,1,2,3,4,5,6}");
    },
    TEMPO_DE_UM_UPDATE,
  );
});
