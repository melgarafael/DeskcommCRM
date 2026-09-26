/**
 * O TETO POR ORGANIZAÇÃO EXISTE NO BANCO, CONTA SÓ O VIVO E RECUSA COM A
 * MENSAGEM CERTA (issue #1448).
 *
 * Os três casos da issue — dentro do teto passa, no teto+1 recusa, revogado
 * libera espaço — são os do GATILHO `trg_teto_de_tokens_ativos`, e um gatilho
 * não existe em unitário com dublê: lá a contagem seria a minha cópia da regra
 * e continuaria verde depois de alguém apagar o gatilho de verdade. Por isto o
 * caso roda contra Postgres real, com o `baseline.sql` aplicado — que é
 * exatamente o caminho do self-hoster (mesma razão de
 * `tests/invariants/capacidades-ausentes.test.ts`).
 *
 * O número do teto NÃO é escrito aqui: o teste lê `v_teto` do corpo da função
 * instalada (`pg_get_functiondef`), para que trocar a constante na migration
 * não deixe a suíte medindo um número que o banco não usa.
 *
 * O caso final cobre a conta que o unitário não alcança: a função nasce com
 * `revoke execute ... from public, anon, authenticated` (item 9 da doutrina) e,
 * ainda assim, TEM de disparar para o papel `authenticated` — que é quem insere
 * quando a tela emite um token. Se houvesse checagem de EXECUTE no disparo, o
 * teto derrubaria a emissão inteira com permission denied em vez de recusar com
 * a mensagem.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 4,
});

/** Ids próprios e fixos: cada arquivo de invariante tem banco próprio, mas o
 *  teste local de quem roda tudo junto agradece uma limpeza determinística. */
const ORG = "44800000-0000-4000-8000-000000000448";
const ORG_OUTRA = "44800000-0000-4000-8000-000000000449";
const USER = "44800000-0000-4000-8000-000000000450";

let teto = 0;

function erroDe(e: unknown): { code?: string; message: string } {
  const err = e as { code?: string; message?: string };
  return { code: err.code, message: err.message ?? String(e) };
}

/** Emite UM token na organização e devolve o erro do Postgres, se houver. */
async function emitir(org: string, sufixo: string): Promise<{ code?: string; message: string } | null> {
  try {
    await pool.query(
      `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes)
       values ($1, $2, $3, $4, decode(md5(random()::text), 'hex'), '["mcp:read"]'::jsonb)`,
      [org, USER, `teto-${sufixo}`, `dsk_t${sufixo}`],
    );
    return null;
  } catch (e) {
    return erroDe(e);
  }
}

async function ativos(org: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.api_tokens
      where organization_id = $1 and revoked_at is null
        and (expires_at is null or expires_at > now())`,
    [org],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  // Statements separados: o driver `pg` não aceita parâmetros em multi-statement.
  await pool.query(`delete from public.api_tokens where organization_id in ($1, $2)`, [ORG, ORG_OUTRA]);
  await pool.query(`delete from public.user_organizations where organization_id in ($1, $2)`, [ORG, ORG_OUTRA]);
  await pool.query(`delete from public.organizations where id in ($1, $2)`, [ORG, ORG_OUTRA]);
  await pool.query(`delete from auth.users where id = $1`, [USER]);
  await pool.query(`insert into auth.users (id, email) values ($1, 'teto-1448@invariant.test')`, [USER]);
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
     values ($1, 'teto-1448', 'Teto 1448', 'Teto 1448'),
            ($2, 'teto-1448-b', 'Teto 1448 B', 'Teto 1448 B')`,
    [ORG, ORG_OUTRA],
  );

  // O número vem da função INSTALADA, não de uma cópia aqui dentro.
  const { rows } = await pool.query<{ def: string }>(
    `select prosrc as def from pg_proc
      where proname = 'fn_teto_de_tokens_ativos' and pronamespace = 'public'::regnamespace`,
  );
  const batida = /v_teto\s+constant integer :=\s*(\d+)/.exec(rows[0]?.def ?? "");
  if (!batida) throw new Error("fn_teto_de_tokens_ativos não está instalada (ou perdeu v_teto)");
  teto = Number(batida[1]);
});

afterAll(async () => {
  await pool.end();
});

describe("teto de tokens ativos por organização (0415)", () => {
  it("a trava é um trigger BEFORE INSERT e a função não é alcançável pela REST", async () => {
    const trg = await pool.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'public.api_tokens'::regclass and tgname = 'trg_teto_de_tokens_ativos'
          and not tgisinternal`,
    );
    expect(trg.rows.map((r) => r.tgname)).toEqual(["trg_teto_de_tokens_ativos"]);

    // Item 9 da doutrina: as DUAS origens revogadas (grant a PUBLIC e o grant
    // direto do ALTER DEFAULT PRIVILEGES ... TO anon), mais authenticated.
    for (const papel of ["anon", "authenticated"]) {
      const { rows } = await pool.query<{ tem: boolean }>(
        `select has_function_privilege($1, 'public.fn_teto_de_tokens_ativos()', 'execute')::bool as tem`,
        [papel],
      );
      expect(rows[0]!.tem, `papel ${papel} não pode executar a função`).toBe(false);
    }
    expect(teto).toBeGreaterThan(0);
  });

  it("dentro do teto a emissão passa, uma por uma, até encher", async () => {
    for (let i = 0; i < teto; i++) {
      const erro = await emitir(ORG, `cheio-${i}`);
      expect(erro, `a emissão ${i + 1} de ${teto} foi recusada: ${erro?.message}`).toBeNull();
    }
    expect(await ativos(ORG)).toBe(teto);
  });

  it("no teto+1 a emissão é recusada com a mensagem própria, dizendo o limite e o que revogar", async () => {
    const erro = await emitir(ORG, "estouro");
    expect(erro?.code, `esperava PT409 e veio ${erro?.code}: ${erro?.message}`).toBe("PT409");
    expect(erro!.message).toContain("Teto de tokens ativos por organização atingido");
    expect(erro!.message).toContain(`${teto} de ${teto}`);
    expect(erro!.message).toContain("Revogue um token");
    expect(erro!.message).toContain("revogados ou expirados não contam");
    expect(await ativos(ORG)).toBe(teto);
  });

  it("revogar um token libera espaço na hora — é o que deixa a rotação passar", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `update public.api_tokens set revoked_at = now(), revoked_by = $2
        where id = (select id from public.api_tokens
                     where organization_id = $1 and revoked_at is null
                     order by created_at limit 1)
        returning id`,
      [ORG, USER],
    );
    expect(rows).toHaveLength(1);
    expect(await ativos(ORG)).toBe(teto - 1);

    const erro = await emitir(ORG, "rotacao");
    expect(erro, `rotação legítima recusada: ${erro?.message}`).toBeNull();
    expect(await ativos(ORG)).toBe(teto);

    // O token revogado NUNCA volta a contar, por mais emissões que venham.
    const novoEstouro = await emitir(ORG, "estouro-depois-da-rotacao");
    expect(novoEstouro?.code).toBe("PT409");
  });

  it("token vencido também libera espaço", async () => {
    await pool.query(
      `update public.api_tokens set expires_at = now() - interval '1 minute'
        where id = (select id from public.api_tokens
                     where organization_id = $1 and revoked_at is null and expires_at is null
                     order by created_at limit 1)`,
      [ORG],
    );
    expect(await ativos(ORG)).toBe(teto - 1);
    const erro = await emitir(ORG, "depois-do-vencido");
    expect(erro, `emissão depois de expirar recusada: ${erro?.message}`).toBeNull();
    expect(await ativos(ORG)).toBe(teto);
  });

  it("outra organização não paga a conta da que está no teto", async () => {
    const erro = await emitir(ORG_OUTRA, "outra-org");
    expect(erro, `organização alheia recusada: ${erro?.message}`).toBeNull();
    expect(await ativos(ORG_OUTRA)).toBe(1);
  });

  it("quem já está acima do teto não é derrubado: a trava recusa SÓ a inserção", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `update public.api_tokens set name = name || ' (rebatizado)'
        where organization_id = $1 and revoked_at is null
          and (expires_at is null or expires_at > now())
        returning id::text as n`,
      [ORG],
    );
    expect(rows.length).toBe(teto);
    expect(await ativos(ORG)).toBe(teto);
    // E a contagem de TODO o que existe na organização só cresce: nada é apagado.
    const { rows: visiveis } = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.api_tokens where organization_id = $1`,
      [ORG],
    );
    expect(Number(visiveis[0]!.n)).toBeGreaterThanOrEqual(teto);
  });

  it("authenticated sem EXECUTE ainda dispara o gatilho — e a recusa é o teto, não permission denied", async () => {
    /**
     * Uma tentativa de INSERT como outro papel, numa transação PRÓPRIA: um erro
     * aborta a transação inteira (25P02), então os dois probes não podem
     * dividir a mesma — e o rollback devolve a conexão limpa ao pool.
     */
    const probe = async (org: string, prefix: string): Promise<{ code?: string; message: string } | null> => {
      const cliente = await pool.connect();
      try {
        await cliente.query("begin");
        await cliente.query("set local role authenticated");
        try {
          await cliente.query(
            `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes)
             values ($1, $2, $3, $4, decode(md5(random()::text), 'hex'), '[]'::jsonb)`,
            [org, USER, `teto-${prefix}`, prefix],
          );
          return null;
        } catch (e) {
          return erroDe(e);
        }
      } finally {
        await cliente.query("rollback").catch(() => undefined);
        cliente.release();
      }
    };

    // Organização NO teto: se o disparo pedisse EXECUTE, o erro seria
    // "permission denied for function" e não o PT409 do corpo do gatilho.
    const noTeto = await probe(ORG, "dsk_tpapel");
    expect(noTeto?.code, `esperava PT409 e veio ${noTeto?.code}: ${noTeto?.message}`).toBe("PT409");

    // Controle: organização COM espaço, o mesmo papel passa pelo gatilho e só
    // então cai na policy da RLS — prova que a recusa acima veio do teto.
    const controle = await probe(ORG_OUTRA, "dsk_cpal");
    expect(controle, "o controle não deveria passar: a RLS do papel sem JWT nega a linha").not.toBeNull();
    expect(controle!.code).not.toBe("PT409");
    expect(controle!.code, `esperava recusa de RLS, veio ${controle!.code}: ${controle!.message}`).toBe("42501");
  });
});
