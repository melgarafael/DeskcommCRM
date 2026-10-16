// @vitest-environment node
/**
 * A CONVERSA QUE NASCE DURANTE A TRAVA DO CONTATO (issue #2748).
 *
 * O gatilho `fn_conversa_calcula_trava_do_contato` lia `contacts` sem lock. Se
 * o contato recebia `force_human` (transação ainda aberta) enquanto a conversa
 * dele nascia, a leitura enxergava a versão antiga e o bit nascia FALSO — a
 * conversa aparecia em `automatico` até a próxima escrita no contato.
 *
 * Duas sessões de verdade, no Postgres efêmero do `test:db`:
 *
 *   ⭐ o caso da corrida — uma sessão segura o `update … force_human` sem
 *      commit enquanto a outra cria a conversa: com `for share` a segunda
 *      ESPERA o commit e o bit nasce `aguardando`; sem ele, nasce `automatico`
 *      e este arquivo fica vermelho.
 *
 *   ⭐ o pulo da leitura — a tentativa de INSERT do upsert de mensagem passa
 *      pelo gatilho ANTES de o conflito ser detectado; quando a conversa já
 *      existe o valor seria descartado, e a leitura com lock a cada mensagem
 *      era o custo que a medição da issue mostrou (-10% a -20%). O segundo
 *      caso prova que a mensagem em conversa existente NÃO espera a trava —
 *      e que o bit continua sendo mantido pelo gatilho do contato.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const CONTAINER = process.env.TEST_DB_CONTAINER;
if (!CONTAINER) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:invariants` (scripts/test-db.sh)",
  );
}

const ORG = "aaaaaaaa-0000-4000-8000-00000000f101";
const SESS = "aaaaaaaa-0000-4000-8000-00000000f102";
const C1 = "aaaaaaaa-0000-4000-8000-00000000f1c1";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma sessão psql ASSÍNCRONA (para rodar em paralelo com a do teste), devolvendo
 * o tempo de parede — é ele que prova a espera de lock. O `sql()` do gov-helpers
 * é síncrono de propósito; concorrência entra por aqui.
 */
function psqlAssincrono(script: string): Promise<{ saida: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const p = spawn(
      "docker",
      ["exec", "-i", CONTAINER as string, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let saida = "";
    let erro = "";
    p.stdout.on("data", (d: Buffer) => (saida += d.toString()));
    p.stderr.on("data", (d: Buffer) => (erro += d.toString()));
    p.on("close", (codigo) => {
      if (codigo === 0) resolve({ saida, ms: Date.now() - t0 });
      else reject(new Error(`psql falhou (${codigo}): ${erro}`));
    });
    p.stdin.end(script);
  });
}

function semear() {
  sql(`
    delete from conversations where organization_id = '${ORG}';
    delete from contacts where organization_id = '${ORG}';
    delete from channel_sessions where organization_id = '${ORG}';
    delete from organizations where id = '${ORG}';
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'corrida-forshare-2748', 'Corrida LTDA', 'Corrida');
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
      values ('${SESS}', '${ORG}', '\\x00', 'corrida-forshare-2748');
    insert into contacts (id, organization_id, force_human, is_blocked)
      values ('${C1}', '${ORG}', false, false);
  `);
}

const bitDaConversa = () =>
  lastLine(
    sql(`select coalesce(c.contato_trava_humano::text, '(sem conversa)')
           from public.conversations c where c.contact_id = '${C1}'`),
  );

describe("a conversa que nasce durante a trava do contato (issue #2748)", () => {
  it("⭐ conversa que nasce com force_human EM VOO nasce aguardando (for share)", async () => {
    semear();

    // A sessão que segura o UPDATE (2 s) sem commit.
    const travando = psqlAssincrono(
      `begin;\nupdate public.contacts set force_human = true where id = '${C1}';\nselect pg_sleep(2);\ncommit;`,
    );
    await dormir(600); // a trava já está tomada

    // A sessão que cria a conversa no meio: com `for share` ela espera o commit.
    const nascendo = await psqlAssincrono(
      `select public.fn_upsert_wa_conversation('${ORG}', '${C1}', '${SESS}');`,
    );
    await travando;

    expect(
      bitDaConversa(),
      "a conversa nasceu com a leitura ANTIGA do contato: o `for share` sumiu do gatilho",
    ).toBe("true");
    expect(
      nascendo.ms,
      "a sessão da conversa não esperou o commit da trava — leu sem lock",
    ).toBeGreaterThan(900);
  });

  it("⭐ mensagem em conversa que JÁ existe não espera a trava (o pulo da leitura)", async () => {
    semear();
    // A conversa existe desde antes (upsert com o contato limpo).
    await psqlAssincrono(`select public.fn_upsert_wa_conversation('${ORG}', '${C1}', '${SESS}');`);
    expect(bitDaConversa()).toBe("false");

    // A sessão concorrente segura um UPDATE do contato que NÃO mexe em
    // `force_human`/`is_blocked` — a forma exata do upsert de contato que toda
    // mensagem recebida faz. (Mudar a trava de verdade faria o gatilho do
    // contato segurar a CONVERSA, e aí o conflito do upsert espera a conversa,
    // não a leitura — preexistente e fora do escopo desta cerca.)
    const segurando = psqlAssincrono(
      `begin;\nupdate public.contacts set phone_number = phone_number where id = '${C1}';\nselect pg_sleep(2);\ncommit;`,
    );
    await dormir(600);

    // A MESMA mensagem de novo: a conversa existe, o upsert só conflita — não
    // há valor a calcular, e o gatilho não pode pagar a leitura com lock.
    const conflitando = await psqlAssincrono(
      `select public.fn_upsert_wa_conversation('${ORG}', '${C1}', '${SESS}');`,
    );
    await segurando;

    expect(
      conflitando.ms,
      "a mensagem em conversa existente esperou a trava — o pulo da leitura caiu",
    ).toBeLessThan(700);
    // E o bit segue o do contato (oupsert de mensagem não mexe nele).
    expect(bitDaConversa()).toBe("false");
  });
});
