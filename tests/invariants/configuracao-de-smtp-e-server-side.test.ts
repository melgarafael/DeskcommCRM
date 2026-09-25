/**
 * `platform_smtp_settings` É SERVER-SIDE ONLY — E ISSO SE MEDE, NÃO SE DECLARA.
 *
 * ## O que se pagaria
 *
 * A tabela guarda a senha do servidor SMTP da instalação, cifrada. Quem tem
 * acesso a essa credencial tem a capacidade de emitir e-mails em nome de todo
 * o domínio e da organização.
 *
 * O `supabase/baseline.sql` traz `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
 * TABLES TO anon` e `... TO authenticated`, e eles valem para toda tabela criada
 * DEPOIS deles — isto é, para todo apêndice novo. **Tabela nova nasce
 * concedida.**
 *
 * ## Por que RLS-sem-policy NÃO basta sozinha
 *
 * Com RLS ligada e zero policies, `anon` e `authenticated` recebem ZERO LINHAS —
 * parece seguro, e um teste que contasse linhas passaria mesmo SEM o revoke.
 * Por isso este arquivo mede **privilégio** (o que sobra no dia em que alguém
 * acrescentar "só uma policy de leitura") **e** comportamento (`permission
 * denied`, que é o que distingue "a policy barrou" de "o privilégio não existe").
 *
 * Irmão declarado de `tests/invariants/app-da-meta-e-server-side.test.ts` e
 * `tests/invariants/credencial-do-google-e-server-side.test.ts`, que são o
 * molde — inclusive na razão de a tabela não entrar em `rls-isolation.test.ts`:
 * ela não é tenant-aware e não deve ser (não tem `organization_id`, então
 * também não entra na varredura de completude). A credencial é da INSTALAÇÃO.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELA = "platform_smtp_settings";

/** Roda um comando sob outro papel e devolve o erro do Postgres, ou `null`. */
function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/**
 * Afirma que o Postgres RECUSOU o comando por privilégio.
 *
 * O modo de falha interessante é `erroSob` devolver `null`: o comando PASSOU.
 * Com RLS ligada e o grant de volta, `anon` recebe zero linhas SEM erro — e uma
 * asserção `toContain` sobre `null` reprova com uma mensagem que não diz nada
 * sobre a tabela ter ficado exposta.
 */
function esperaBarrado(papel: string, comando: string): void {
  const erro = erroSob(papel, comando);
  expect(erro, `\`${papel}\` executou "${comando}" SEM erro — a tabela está exposta`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function privilegiosDe(papel: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = '${TABELA}'
       and grantee = '${papel}';
  `).trim();
}

beforeAll(() => {
  // Banco compartilhado entre os arquivos desta suíte (`fileParallelism: false`).
  // Partir de estado conhecido é o que impede um caso de passar por causa de uma
  // fixture de rodada anterior.
  sql(`delete from public.${TABELA};`);

  // A CHAVE MESTRA DE CIFRA, sem a qual `fn_encrypt_oauth` levanta. O banco
  // efêmero do harness nasce sem ela.
  sql(`
    insert into private.app_secrets (name, value)
    values ('nuvemshop_oauth_key', 'chave-de-teste-do-harness-0255-nao-e-segredo')
    on conflict (name) do nothing;
  `);
});

afterAll(() => {
  sql(`delete from public.${TABELA};`);
});

describe("o PostgREST não serve a configuração de SMTP da instalação", () => {
  it("`anon` não tem privilégio NENHUM", () => {
    expect(privilegiosDe("anon")).toBe("NENHUM");
  });

  it("`authenticated` também não tem — nenhuma tela lê isto pelo client de sessão", () => {
    // Quem lê é `lib/email/config.ts`, no servidor, com o admin client.
    expect(privilegiosDe("authenticated")).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo da sonda", () => {
    // Sem este caso, uma sonda medindo errado (nome de tabela trocado, schema
    // errado) devolveria NENHUM para todo mundo e os dois casos de cima
    // passariam por acidente. E é o privilégio que a server action usa: se ele
    // sumir, a credencial deixa de ser gravável.
    const privilegios = privilegiosDe("service_role");
    expect(privilegios).toContain("SELECT");
    expect(privilegios).toContain("INSERT");
    expect(privilegios).toContain("UPDATE");
  });

  it("`anon` é BARRADO ao ler — permission denied, não zero linhas", () => {
    esperaBarrado("anon", `select id from public.${TABELA}`);
  });

  it("`authenticated` é BARRADO ao ler", () => {
    esperaBarrado("authenticated", `select id from public.${TABELA}`);
  });

  it("`authenticated` é BARRADO ao escrever", () => {
    esperaBarrado(
      "authenticated",
      `insert into public.${TABELA} (id) values (1)`,
    );
  });

  it("a RLS está LIGADA — o segundo degrau, para o dia em que o grant voltar", () => {
    const ligada = sql(`
      select relrowsecurity from pg_class
       where oid = 'public.${TABELA}'::regclass;
    `).trim();
    expect(ligada, "RLS desligada: o revoke vira a única defesa").toBe("t");
  });

  it("não há policy nenhuma — servir esta tabela nunca foi a intenção", () => {
    const quantas = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and tablename = '${TABELA}';
    `).trim();
    expect(
      quantas,
      "alguém criou policy: a tabela passa a ser SERVIDA, e a senha do SMTP " +
        "fica atrás de uma regra em vez de atrás da ausência de privilégio",
    ).toBe("0");
  });
});

describe("a senha do SMTP é gravada cifrada, e volta pela decifra", () => {
  it("a coluna é bytea e o que se grava NÃO se lê em claro", () => {
    const senha = "senha-smtp-secreta-de-teste-0333";
    sql(`
      insert into public.${TABELA} (id, smtp_host, smtp_port, smtp_security, smtp_password_encrypted)
      values (
        1,
        'smtp.example.com',
        587,
        'starttls',
        public.fn_encrypt_oauth('${senha}')
      )
      on conflict (id) do update set
        smtp_password_encrypted = excluded.smtp_password_encrypted;
    `);

    const cru = sql(
      `select encode(smtp_password_encrypted, 'escape')
         from public.${TABELA} where id = 1;`,
    );
    expect(cru.includes(senha), "a senha SMTP está legível na coluna — fn_encrypt_oauth não foi aplicada").toBe(
      false,
    );

    const decifrado = sql(
      `select public.fn_decrypt_oauth(smtp_password_encrypted)
         from public.${TABELA} where id = 1;`,
    ).trim();
    expect(decifrado, "a decifra não devolveu o que foi gravado").toBe(senha);
  });

  it("o singleton é singleton — não dá para ter duas configurações de SMTP na mesma instalação", () => {
    const erro = (() => {
      try {
        sql(`insert into public.${TABELA} (id) values (2);`);
        return null;
      } catch (err) {
        return motivoDoErro(err);
      }
    })();
    expect(erro, "aceitou uma segunda linha: o CHECK do singleton não está no baseline").not.toBeNull();
  });
});
