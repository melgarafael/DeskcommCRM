import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O que a migration 0087 promete, cobrado no banco que o CLONE recebe.
 *
 * Este arquivo lê o Postgres descartável que nasce do `supabase/baseline.sql`
 * (`TEST_DB_CONTAINER`, via `scripts/test-db.sh`), nunca o banco de dev — e essa
 * escolha É o teste. A migration é o caminho de quem já tem banco; o baseline é
 * o destino de quem clona. Uma mudança que existe só na primeira não chega ao
 * self-hoster e nada reclama: ele descobre no primeiro `23514` de um INSERT que
 * nunca deveria ter passado, ou pior, num envio pelo canal errado.
 *
 * As asserções são de COMPORTAMENTO onde comportamento é o que importa. Conferir
 * que "existe uma constraint chamada X" prova que alguém escreveu o nome; o que
 * o produto precisa é que a linha errada seja RECUSADA. Por isso os dois casos
 * centrais são INSERTs que têm de estourar, com o nome da trava no erro — sem o
 * nome, "rejeitou" não distingue o CHECK certo de um NOT NULL, de uma FK ou da
 * RLS, e o teste passaria verde pelo motivo errado.
 */

/**
 * Org descartável por caso: as travas são por (organization_id, ...).
 *
 * O id sai de um SELECT à parte, não de um `returning`: psql imprime a etiqueta
 * `INSERT 0 1` no stdout mesmo com `-tA`, e ela colaria no uuid.
 */
function novaOrg(slug: string): string {
  sql(`
    insert into public.organizations (slug, legal_name, display_name)
    values ('${slug}', 'inv 0087', 'inv 0087');
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

/** Insere uma sessão como service_role (RLS fora do caminho — o alvo é a constraint). */
function insertSession(org: string, cols: Record<string, string>): string {
  const nomes = ["organization_id", "webhook_secret_encrypted", ...Object.keys(cols)];
  const vals = [`'${org}'`, `'\\x00'::bytea`, ...Object.values(cols)];
  return sql(`
    insert into public.channel_sessions (${nomes.join(", ")})
    values (${vals.join(", ")});
    select 'ok';
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    // execFileSync joga o stderr do psql em `stderr`; a mensagem do Error só traz o exit.
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

describe("0087 · o canal da sessão chega ao clone", () => {
  it("a coluna existe no baseline, com default 'waha' e not null", () => {
    expect(
      sql(`select column_default, is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'channel_sessions'
              and column_name = 'provider'`),
    ).toBe("'waha'::text|NO");
  });

  it("as três colunas do ramo meta_cloud existem", () => {
    const cols = sql(`select column_name from information_schema.columns
                       where table_schema = 'public' and table_name = 'channel_sessions'
                         and column_name like 'meta\\_%' order by 1`).split("\n");
    // As três `meta_webhook_override_*` (migration 0311) entraram de propósito: são o
    // desfecho do registro do webhook do número ao conectar o canal oficial. A cerca
    // continua valendo — ela existe para pegar coluna que entrou SEM querer.
    expect(cols).toEqual([
      "meta_phone_number_id",
      "meta_token_encrypted",
      "meta_waba_id",
      "meta_webhook_override_em",
      "meta_webhook_override_erro",
      "meta_webhook_override_uri",
    ]);
  });

  it("waha_session_name deixou de ser obrigatório — senão meta_cloud é inexprimível", () => {
    expect(
      sql(`select attnotnull from pg_attribute
            where attrelid = 'public.channel_sessions'::regclass and attname = 'waha_session_name'`),
    ).toBe("f");
  });

  it("sessão meta_cloud sem meta_phone_number_id é RECUSADA pelo banco", () => {
    const org = novaOrg(`inv-0087-a-${Date.now()}`);
    const msg = erroDe(() =>
      insertSession(org, { provider: `'meta_cloud'`, waha_session_name: "null" }),
    );
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("sessão waha sem waha_session_name é RECUSADA — a união vale nos DOIS ramos", () => {
    // O ramo simétrico não é zelo: `drop not null` acabou de tirar a proteção que
    // existia aqui, e sem esta asserção a migration teria AFROUXADO o waha em
    // troca de exprimir o meta_cloud — sem nada falhar.
    const org = novaOrg(`inv-0087-b-${Date.now()}`);
    const msg = erroDe(() => insertSession(org, { waha_session_name: "null" }));
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("provider fora do vocabulário é RECUSADO", () => {
    // A sonda usava `'telegram'` enquanto o Telegram não era provider nenhum.
    // Desde a #3440 ele É (migration 0773), e a sonda passou a medir o
    // contrário do que o nome do caso diz: um valor que o CHECK agora ACEITA.
    // O literal virou `'canal_inexistente'` — o caso continua sendo "valor
    // fora do vocabulário", que é o invariante, e não "o Telegram é recusado".
    const org = novaOrg(`inv-0087-c-${Date.now()}`);
    const msg = erroDe(() =>
      insertSession(org, { provider: `'canal_inexistente'`, waha_session_name: `'s-c'` }),
    );
    expect(msg).toMatch(/channel_sessions_provider_check/);
  });

  it("o mesmo número em DOIS providers na mesma org é RECUSADO", () => {
    // ⚠️ A trava é `channel_sessions_phone_per_org_unique`, do snapshot original —
    // NÃO o `channel_sessions_org_phone_uniq` que o plano da Task 6 mandava criar.
    // Ela já responde ao invariante ("um número vive em UM provider") porque não
    // olha o provider: o par (org, número) é único, ponto. Criar o índice seria
    // duplicar a checagem em toda escrita e colocar uma trava NÃO-deferível ao
    // lado de uma DEFERRABLE INITIALLY DEFERRED — quebrando no meio qualquer
    // transação que hoje troca números entre duas sessões.
    const org = novaOrg(`inv-0087-d-${Date.now()}`);
    const fone = `'+5531999998888'`;
    insertSession(org, { waha_session_name: `'s-d1'`, phone_number: fone });
    const msg = erroDe(() =>
      insertSession(org, {
        provider: `'meta_cloud'`,
        waha_session_name: "null",
        meta_phone_number_id: `'123456'`,
        phone_number: fone,
      }),
    );
    expect(msg).toMatch(/channel_sessions_phone_per_org_unique/);
  });

  /**
   * O CHECK do banco e o union type do TypeScript falam o MESMO vocabulário.
   *
   * O lugar canônico deste par é a lista `PARES` de
   * `vocabulario-banco-x-typescript.test.ts` — e é para lá que ele deve migrar.
   * Ele mora aqui porque `tests/invariants/**` é **congelado** pela governança do
   * repo (`pre-commit`: modificar invariante existente é bloqueado, e a exceção
   * documentada é outra), e circundar o guarda com a flag de override não é ato
   * meu. O pedido está em `loop/inbox.items.md` como `INBOX-004`.
   *
   * ⚠️ Extração vazia é ERRO DO INSTRUMENTO, nunca conjunto vazio legítimo: se o
   * regex deixar de casar (o type muda de arquivo, ganha comentário no meio, vira
   * `as const`), a lista viraria `[]` e a comparação passaria POR VACUIDADE — o
   * teste diria "banco e TypeScript concordam" quando o que houve foi ele deixar
   * de ler. Mesma regra do lado do banco.
   */
  it("o vocabulário do CHECK é o mesmo do ChannelProvider em lib/channels/types.ts", () => {
    const def = sql(`select pg_get_constraintdef(oid) from pg_constraint
                      where conrelid = 'public.channel_sessions'::regclass
                        and conname = 'channel_sessions_provider_check'`);
    const doBanco = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
    expect(doBanco.length).toBeGreaterThan(0);

    const fonte = readFileSync("lib/channels/types.ts", "utf8");
    const decl = /type\s+ChannelProvider\s*=([^;]*);/s.exec(fonte);
    if (!decl) {
      throw new Error(
        "extrator: não achei `type ChannelProvider = ...` em lib/channels/types.ts. " +
          "Corrigir o extrator é o conserto; apagar a asserção NÃO.",
      );
    }
    const doTs = [...decl[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!).sort();
    expect(doTs.length).toBeGreaterThan(0);

    expect(doTs).toEqual(doBanco);
  });

  it("sessões meta_cloud convivem: a UNIQUE de waha_session_name não barra NULLs", () => {
    // Consequência do `drop not null` que passa despercebida até o segundo número
    // Cloud API não entrar: no Postgres NULLs são distintos entre si numa UNIQUE.
    const org = novaOrg(`inv-0087-e-${Date.now()}`);
    insertSession(org, {
      provider: `'meta_cloud'`,
      waha_session_name: "null",
      meta_phone_number_id: `'111'`,
    });
    insertSession(org, {
      provider: `'meta_cloud'`,
      waha_session_name: "null",
      meta_phone_number_id: `'222'`,
    });
    expect(
      sql(`select count(*) from public.channel_sessions
            where organization_id = '${org}' and provider = 'meta_cloud'`),
    ).toBe("2");
  });
});
