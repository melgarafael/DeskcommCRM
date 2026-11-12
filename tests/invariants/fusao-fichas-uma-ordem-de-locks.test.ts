// @vitest-environment node
/**
 * A FUSÃO DE FICHAS TAMBÉM TEM UMA ORDEM DE LOCKS SÓ (issue #2884).
 *
 * A 0681 pôs `fn_mark_conversation_message` na ordem única do serviço —
 * CONTATO antes de CONVERSA —, a mesma do gatilho do contato
 * (`trg_contato_atualiza_trava_nas_conversas`, AFTER UPDATE: ele já roda com o
 * contato travado). Mas uma migration POSTERIOR, a 9043 (ficha com vários
 * telefones), reescreveu `fn_mesclar_contatos` travando na ordem INVERSA: as
 * CONVERSAS dos contatos primeiro (`for no key update`), os contatos depois
 * (`for update`, passos 2 e 3). A ordem AB-BA voltou pela porta da fusão.
 *
 * Duas sessões de verdade, no Postgres efêmero do `pnpm test:db`:
 *
 *   ⭐ o ciclo — A segura o CONTATO e, no meio, troca `force_human` (o gatilho
 *      do contato pede as CONVERSAS dele); B roda a fusão de fichas. Com a
 *      conversa antes do contato (a forma da 9043) o ciclo fecha e sai 40P01;
 *      com a ordem única (contato antes da conversa) ele não fecha e as duas
 *      transações terminam. Este caso FICA VERMELHO se a ordem voltar a ser
 *      inversa.
 *
 *   ⭐ a ordem no corpo INSTALADO — lida de `pg_proc.prosrc`, sem cronômetro:
 *      a trava de `contacts` aparece ANTES da de `conversations` no corpo que
 *      o banco tem de pé. É a régua que não depende de janela de tempo.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const CONTAINER = process.env.TEST_DB_CONTAINER;
if (!CONTAINER) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const SESS = "eeeeeeee-0000-4000-8000-000000000002";
const SESS2 = "eeeeeeee-0000-4000-8000-000000000003";
const C1 = "eeeeeeee-2222-4000-8000-000000000001";
const C2 = "eeeeeeee-2222-4000-8000-000000000002";
const CONV1 = "eeeeeeee-4444-4000-8000-000000000001";
const CONV2 = "eeeeeeee-4444-4000-8000-000000000002";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rodada = { saida: string; erro: string; codigo: number | null; ms: number };

/** Uma sessão psql ASSÍNCRONA de verdade, sempre RESOLVENDO com o 40P01 à vista. */
function psql(script: string, pararNoErro = true): Promise<Rodada> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [
      "exec",
      "-i",
      CONTAINER as string,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
    ];
    if (pararNoErro) args.push("-v", "ON_ERROR_STOP=1");
    args.push("-f", "-");
    const p = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let saida = "";
    let erro = "";
    p.stdout.on("data", (d: Buffer) => (saida += d.toString()));
    p.stderr.on("data", (d: Buffer) => (erro += d.toString()));
    p.on("close", (codigo) => resolve({ saida, erro, codigo, ms: Date.now() - t0 }));
    p.stdin.end(script);
  });
}

const contar40p01 = (...erros: string[]) =>
  (erros.join("\n").match(/deadlock detected/g) ?? []).length;

function semear() {
  sql(`
    delete from conversations where organization_id = '${ORG}';
    delete from contact_phones where organization_id = '${ORG}';
    delete from contacts where organization_id = '${ORG}';
    delete from channel_sessions where organization_id = '${ORG}';
    delete from organizations where id = '${ORG}';
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'fusao-fichas-2884', 'Fusão LTDA', 'Fusão');
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
      values ('${SESS}', '${ORG}', '\\x00', 'fusao-fichas-2884'),
             ('${SESS2}', '${ORG}', '\\x00', 'fusao-fichas-2884-b');
    insert into contacts (id, organization_id, name, force_human, is_blocked)
      values ('${C1}', '${ORG}', 'Ficha que fica', false, false),
             ('${C2}', '${ORG}', 'Ficha absorvida', false, false);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV1}', '${ORG}', '${C1}', '${SESS}', 'open'),
             ('${CONV2}', '${ORG}', '${C2}', '${SESS2}', 'open');
  `);
}

describe("a fusão de fichas segue a ordem única de locks (issue #2884)", () => {
  it("⭐ a passagem para humano e a fusão de fichas não fecham o ciclo (a ordem inversa dá 40P01)", async () => {
    semear();

    // A segura o CONTATO com um UPDATE que NÃO mexe em force_human (para não
    // disparar o gatilho da conversa ainda) e, no meio da janela, troca
    // force_human — é o gatilho que pede as CONVERSAS do contato.
    const travando = psql(
      `begin;\n` +
        `update public.contacts set name = name where id = '${C1}';\n` +
        `select pg_sleep(1.5);\n` +
        `update public.contacts set force_human = true where id = '${C1}';\n` +
        `commit;`,
    );
    await dormir(500); // A já segura o contato

    // B funde a ficha absorvida na que fica. Com a ordem da 9043 a fusão trava
    // as CONVERSAS e depois pede o CONTATO (que A tem) → ciclo.
    const fundindo = psql(
      `select public.fn_mesclar_contatos('${ORG}'::uuid, '${C1}'::uuid, array['${C2}']::uuid[]);`,
    );
    const [ra, rb] = await Promise.all([travando, fundindo]);

    expect(
      contar40p01(ra.erro, rb.erro),
      "a passagem para humano e a fusão de fichas fecharam o ciclo AB-BA (40P01): " +
        "a fusão está travando as CONVERSAS antes dos CONTATOS",
    ).toBe(0);
    expect(ra.codigo, `a passagem para humano não concluiu: ${ra.erro}`).toBe(0);
    expect(rb.codigo, `a fusão de fichas não concluiu: ${rb.erro}`).toBe(0);

    // A trava SOBREVIVEU e a fusão aconteceu de ponta a ponta.
    expect(lastLine(sql(`select force_human::text from public.contacts where id = '${C1}'`))).toBe(
      "true",
    );
    expect(
      lastLine(sql(`select coalesce(is_merged_into::text,'null') from public.contacts where id = '${C2}'`)),
    ).toBe(C1);
    expect(
      lastLine(
        sql(`select contact_id::text from public.conversations where id = '${CONV2}'`),
      ),
    ).toBe(C1);
  });

  it("⭐ a ordem no corpo instalado: contatos antes de conversas", () => {
    const corpo = sql(
      `select prosrc from pg_proc where proname='fn_mesclar_contatos' and pronamespace='public'::regnamespace`,
    );
    // Comentário não trava linha nenhuma: a régua mede o que o Postgres executa.
    const fonte = corpo
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join(" ")
      .replace(/\s+/g, " ");

    const travaContato = fonte.indexOf(
      "from public.contacts where id = any(array[p_contato_principal]||p_contatos_secundarios)",
    );
    const travaConversa = fonte.indexOf(
      "from public.conversations where organization_id=p_organization_id",
    );

    expect(travaContato, "a fusão não trava os CONTATOS por id (a linha sumiu do corpo)").toBeGreaterThan(
      -1,
    );
    expect(travaConversa, "a fusão não trava as CONVERSAS (a linha sumiu do corpo)").toBeGreaterThan(
      -1,
    );
    expect(
      travaContato,
      "a fusão trava as CONVERSAS antes dos CONTATOS — a ordem AB-BA com o gatilho do contato " +
        "e com a fn_mark_conversation_message está de volta",
    ).toBeLessThan(travaConversa);
  });
});
