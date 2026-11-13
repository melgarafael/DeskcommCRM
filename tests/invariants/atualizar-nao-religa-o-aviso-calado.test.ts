/**
 * ATUALIZAR O CRM NÃO RELIGA O AVISO QUE O APARELHO CALOU (migration 9351, PR #4310)
 * — provado re-aplicando o `baseline.sql` INTEIRO, que é o que o `update.sh` faz.
 *
 * `push_subscriptions.tipos_calados` guarda os tipos de aviso que cada aparelho
 * não quer no celular. O bloco da 9351 só faz `add column if not exists`, mas a
 * unidade de prova é o arquivo inteiro, na ordem do arquivo: um `update … set
 * tipos_calados = '{}'` em QUALQUER outro bloco devolveria ao celular os avisos
 * que a pessoa desligou, sem erro e sem log — e um teste do bloco recortado não
 * o veria (o mesmo argumento de `atualizar-nao-desliga-o-lembrete.test.ts`).
 *
 * Os dois sentidos numa só re-aplicação (cada uma custa dezenas de segundos):
 *   - o aparelho que calou "Nova mensagem" e a passagem continua com os dois calados;
 *   - o aparelho que não calou nada continua recebendo tudo (vazio segue vazio).
 *
 * O lado do navegador (quem desligou antes desta versão não volta a receber a
 * bandeja) é de `lib/notifications/prefs.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

const ORG = "93510000-0000-4000-8000-000000000001";
const USUARIO = "93510000-1111-4000-8000-000000000001";
const CALOU = "93510000-2222-4000-8000-000000000001";
const NAO_CALOU = "93510000-2222-4000-8000-000000000002";

/** Re-aplicar o baseline leva dezenas de segundos sob carga — o default de 30s não cabe. */
const TEMPO_DE_UM_UPDATE = 300_000;

// ponytail: cópia de `atualizar-nao-desliga-o-lembrete.test.ts` (já são três); vira helper
// em `psql-transporte.ts` quando alguém mexer nas outras duas.
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

function caladosDe(id: string): string {
  return sql(`select array_to_string(tipos_calados, ',') from public.push_subscriptions where id = '${id}';`);
}

describe("o aviso calado sobrevive a um update.sh", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values ('${USUARIO}', 'aviso-calado-9351@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'inv-9351-aviso-calado', 'Aviso Calado LTDA', 'Aviso Calado', '{}'::jsonb)
      on conflict (id) do nothing;
      insert into public.push_subscriptions (id, organization_id, user_id, endpoint, p256dh, auth, tipos_calados)
      values ('${CALOU}', '${ORG}', '${USUARIO}', 'https://fcm.googleapis.com/fcm/send/inv-9351-calou', 'p', 'a',
              array['message', 'handoff']);
      insert into public.push_subscriptions (id, organization_id, user_id, endpoint, p256dh, auth)
      values ('${NAO_CALOU}', '${ORG}', '${USUARIO}', 'https://fcm.googleapis.com/fcm/send/inv-9351-nao-calou', 'p', 'a');
    `);
  });

  it(
    "re-aplicar o baseline não mexe nos tipos que cada aparelho calou",
    () => {
      // Ponto de partida conferido: sem isto, um banco que já chegasse vazio
      // deixaria o caso verde por vacuidade.
      expect(caladosDe(CALOU)).toBe("message,handoff");
      expect(caladosDe(NAO_CALOU)).toBe("");

      reaplicarOBaseline();

      expect(
        caladosDe(CALOU),
        "a atualização religou avisos que o aparelho tinha calado — o celular volta a tocar sem a pessoa ter mexido",
      ).toBe("message,handoff");
      expect(caladosDe(NAO_CALOU), "o aparelho que não calou nada deixou de receber algum tipo").toBe("");
    },
    TEMPO_DE_UM_UPDATE,
  );
});
