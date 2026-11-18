import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * 9093: a ligação do canal com o provedor parceiro é gravada só pelo servidor.
 *
 * `zernio_credencial_da_instalacao`, `zernio_account_id`, `zernio_profile_id` e
 * `zernio_webhook_id` decidem com que chave e por qual conta a instalação fala
 * com o provedor, e a chave da instalação alcança todos os números da conta
 * dela. `channel_sessions` tem GRANT ALL para `authenticated`, e as policies
 * deixam o admin da organização inserir e alterar a própria linha direto pela
 * API do banco. Sem o gatilho da 9093, esse admin escreveria "use a chave da
 * instalação com a conta X" sem que o servidor tivesse conectado X.
 *
 * As recusas vêm acompanhadas de controles. O MESMO admin altera outra coluna
 * da MESMA linha, e o service role grava as colunas travadas. Sem isso, um
 * 42501 vindo de outro lugar (RLS, suporte somente leitura) seria lido como
 * prova de que a trava funciona.
 */

const RECUSA = "canal_ligacao_ao_provedor_e_do_servidor";
/** Outra organização, criada na transação, para o caso de trocar a linha de dona. */
const OUTRA_ORG = "cccccccc-9093-4000-8000-0000000000aa";
const CANAL = "cccccccc-9093-4000-8000-000000000001";
const CONTA = "9093".repeat(6);

/** A linha que o SERVIDOR gravou (conexão por um clique), criada na mesma transação. */
function linhaDoServidor(pelaInstalacao = true): string {
  return `
    insert into public.channel_sessions
      (id, organization_id, provider, zernio_account_id, zernio_credencial_da_instalacao,
       zernio_profile_id, zernio_webhook_id, phone_number, webhook_path_token,
       webhook_secret_encrypted, display_name, archived_at)
    values ('${CANAL}', '${GOV_ORG}', 'zernio', '${CONTA}', ${pelaInstalacao},
       ${pelaInstalacao ? "'perfil-9093'" : "null"}, 'webhook-9093', '+5511990909093', 'tok-9093-inv',
       '\\x00'::bytea, 'Canal 9093', now());`;
}

const OUTRA_ORG_SQL = `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'inv-9093-outra', 'Inv 9093 Outra', 'Inv 9093 Outra')
      on conflict do nothing;`;

function comoAdmin(dml: string, pelaInstalacao = true): string {
  return sql(`
    begin;
    ${OUTRA_ORG_SQL}
    ${linhaDoServidor(pelaInstalacao)}
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
    with w as (${dml} returning 1) select 'LINHAS:' || count(*) from w;
    rollback;`);
}

function comoServidor(dml: string): string {
  return sql(`
    begin;
    ${OUTRA_ORG_SQL}
    ${linhaDoServidor()}
    set local role service_role;
    with w as (${dml} returning 1) select 'LINHAS:' || count(*) from w;
    rollback;`);
}

function erroDe(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

beforeAll(() => {
  seedGov();
});

describe("9093: o admin da organização não grava a ligação do canal com o provedor", () => {
  it.each([
    ["zernio_account_id", `'${"f".repeat(24)}'`],
    ["zernio_profile_id", `'perfil-de-outra-organizacao'`],
    ["zernio_webhook_id", `'webhook-de-outro-sistema'`],
    ["zernio_credencial_da_instalacao", "false"],
    ["phone_number", `'+5511980000000'`],
  ])("UPDATE de %s na própria linha: 42501", (coluna, valor) => {
    const erro = erroDe(() =>
      comoAdmin(`update public.channel_sessions set ${coluna} = ${valor} where id = '${CANAL}'`),
    );
    expect(erro, `o admin alterou ${coluna} SEM erro`).not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it.each([
    ["desarquivar (archived_at = null)", "archived_at = null"],
    ["mudar o arquivamento", "archived_at = now() - interval '1 day'"],
    ["trocar o provedor", "provider = 'zernio_social'"],
    ["trocar a organização", `organization_id = '${OUTRA_ORG}'`],
  ])("linha da instalação: %s pela API do banco: 42501", (_rotulo, atribuicao) => {
    const erro = erroDe(() =>
      comoAdmin(`update public.channel_sessions set ${atribuicao} where id = '${CANAL}'`),
    );
    expect(erro, `o admin conseguiu ${_rotulo} SEM erro`).not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("linha da instalação: DELETE pela API do banco: 42501", () => {
    const erro = erroDe(() => comoAdmin(`delete from public.channel_sessions where id = '${CANAL}'`));
    expect(erro, "o admin apagou a linha da instalação SEM erro").not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("CONTROLE: fora das linhas da instalação, o admin apaga a própria linha", () => {
    expect(comoAdmin(`delete from public.channel_sessions where id = '${CANAL}'`, false)).toContain(
      "LINHAS:1",
    );
  });

  it("INSERT de uma linha que aponta para a chave da instalação (arquivada, fora do índice único): 42501", () => {
    const erro = erroDe(() =>
      sql(`
        begin;
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
        insert into public.channel_sessions
          (organization_id, provider, zernio_account_id, zernio_credencial_da_instalacao,
           zernio_webhook_id, webhook_path_token, webhook_secret_encrypted, archived_at)
        values ('${GOV_ORG}', 'zernio', '${"e".repeat(24)}', true, 'w', 'tok-9093-forjado', '\\x00'::bytea, now());
        rollback;`),
    );
    expect(erro, "o admin inseriu a linha SEM erro").not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("INSERT só com a conta, sem o ponteiro: 42501", () => {
    const erro = erroDe(() =>
      sql(`
        begin;
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
        insert into public.channel_sessions
          (organization_id, provider, zernio_account_id, webhook_path_token, webhook_secret_encrypted, archived_at)
        values ('${GOV_ORG}', 'zernio', '${"e".repeat(24)}', 'tok-9093-forjado-2', '\\x00'::bytea, now());
        rollback;`),
    );
    expect(erro, "o admin inseriu a conta SEM erro").not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("CONTROLE: o MESMO admin renomeia a MESMA linha", () => {
    expect(
      comoAdmin(`update public.channel_sessions set display_name = 'Renomeado' where id = '${CANAL}'`),
    ).toContain("LINHAS:1");
  });

  it("CONTROLE: fora das linhas da instalação, o telefone segue editável pelo admin", () => {
    expect(
      comoAdmin(
        `update public.channel_sessions set phone_number = '+5511980000000' where id = '${CANAL}'`,
        false,
      ),
    ).toContain("LINHAS:1");
  });
});

describe("9093: o servidor (service role) grava a ligação", () => {
  it("UPDATE das colunas travadas", () => {
    expect(
      comoServidor(`
        update public.channel_sessions
           set zernio_account_id = '${"f".repeat(24)}', zernio_profile_id = 'perfil-novo',
               zernio_webhook_id = 'webhook-novo', phone_number = '+5511980000000'
         where id = '${CANAL}'`),
    ).toContain("LINHAS:1");
  });

  it.each([
    ["mudar o arquivamento", "archived_at = now() - interval '1 day'"],
    ["trocar o provedor", "provider = 'zernio_social'"],
    ["trocar a organização", `organization_id = '${OUTRA_ORG}'`],
  ])("linha da instalação: %s", (_rotulo, atribuicao) => {
    expect(
      comoServidor(`update public.channel_sessions set ${atribuicao} where id = '${CANAL}'`),
    ).toContain("LINHAS:1");
  });

  it("DELETE da linha da instalação — sem o `coalesce(new, old)` a exclusão seria cancelada em silêncio", () => {
    expect(comoServidor(`delete from public.channel_sessions where id = '${CANAL}'`)).toContain(
      "LINHAS:1",
    );
  });

  it("INSERT de uma linha pela instalação", () => {
    expect(
      comoServidor(`
        insert into public.channel_sessions
          (organization_id, provider, zernio_account_id, zernio_credencial_da_instalacao,
           zernio_profile_id, zernio_webhook_id, webhook_path_token, webhook_secret_encrypted, archived_at)
        values ('${GOV_ORG}', 'zernio', '${"d".repeat(24)}', true, 'p', 'w', 'tok-9093-servidor',
          '\\x00'::bytea, now())`),
    ).toContain("LINHAS:1");
  });
});

// ─── 9104: a credencial do número oficial também é do servidor ──────────────
//
// `meta_token_encrypted`, `meta_phone_number_id` e `meta_waba_id` dizem com que
// número e com que token a instalação fala com a Meta pela organização. Quem as
// grava é a rota do servidor (conexão e exclusão do canal oficial), pelo
// service role. A linha nasce arquivada para não esbarrar no índice único de
// número ativo nem no limite de canais do plano, que não são o que se mede.

const CANAL_OFICIAL = "cccccccc-9104-4000-8000-000000000001";

const LINHA_OFICIAL = `
    insert into public.channel_sessions
      (id, organization_id, provider, meta_phone_number_id, meta_waba_id, meta_token_encrypted,
       webhook_path_token, webhook_secret_encrypted, display_name, archived_at)
    values ('${CANAL_OFICIAL}', '${GOV_ORG}', 'meta_cloud', '9104-pn', '9104-conta', '\\x01'::bytea,
       'tok-9104-inv', '\\x00'::bytea, 'Oficial 9104', now());`;

function comoAdminNoOficial(dml: string): string {
  return sql(`
    begin;
    ${LINHA_OFICIAL}
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated"}', true) is not null;
    with w as (${dml} returning 1) select 'LINHAS:' || count(*) from w;
    rollback;`);
}

function comoServidorNoOficial(dml: string): string {
  return sql(`
    begin;
    ${LINHA_OFICIAL}
    set local role service_role;
    with w as (${dml} returning 1) select 'LINHAS:' || count(*) from w;
    rollback;`);
}

/** Uma linha nova, arquivada, com UMA coluna meta_* preenchida (ou nenhuma). */
function insercaoOficial(coluna: string | null, valor = "null"): string {
  const extra = coluna ? `, ${coluna}` : "";
  const v = coluna ? `, ${valor}` : "";
  const provedor = coluna === "meta_phone_number_id" ? "'meta_cloud'" : "'waha'";
  const sessao = coluna === "meta_phone_number_id" ? "null" : "'inv-9104-insert'";
  return `insert into public.channel_sessions
      (organization_id, provider, waha_session_name, webhook_path_token, webhook_secret_encrypted, archived_at${extra})
    values ('${GOV_ORG}', ${provedor}, ${sessao}, 'tok-9104-insert', '\\x00'::bytea, now()${v})`;
}

const COLUNAS_OFICIAIS: Array<[string, string]> = [
  ["meta_token_encrypted", "'\\x02'::bytea"],
  ["meta_phone_number_id", "'9104-pn-de-outro'"],
  ["meta_waba_id", "'9104-conta-de-outro'"],
];

describe("9104: o admin da organização não grava a credencial do número oficial", () => {
  it.each(COLUNAS_OFICIAIS)("UPDATE de %s na própria linha: 42501", (coluna, valor) => {
    const erro = erroDe(() =>
      comoAdminNoOficial(`update public.channel_sessions set ${coluna} = ${valor} where id = '${CANAL_OFICIAL}'`),
    );
    expect(erro, `o admin alterou ${coluna} SEM erro`).not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("UPDATE que zera o token: 42501 (a exclusão do canal zera pelo service role)", () => {
    const erro = erroDe(() =>
      comoAdminNoOficial(`update public.channel_sessions set meta_token_encrypted = null where id = '${CANAL_OFICIAL}'`),
    );
    expect(erro, "o admin zerou o token SEM erro").not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it.each(COLUNAS_OFICIAIS)("INSERT com %s: 42501", (coluna, valor) => {
    const erro = erroDe(() => comoAdminNoOficial(insercaoOficial(coluna, valor)));
    expect(erro, `o admin inseriu ${coluna} SEM erro`).not.toBeNull();
    expect(erro).toContain(RECUSA);
  });

  it("CONTROLE: o MESMO admin renomeia a MESMA linha", () => {
    expect(
      comoAdminNoOficial(`update public.channel_sessions set display_name = 'Renomeado 9104' where id = '${CANAL_OFICIAL}'`),
    ).toContain("LINHAS:1");
  });

  it("CONTROLE: reescrever o MESMO valor não é alteração", () => {
    expect(
      comoAdminNoOficial(`
        update public.channel_sessions
           set meta_token_encrypted = meta_token_encrypted, meta_phone_number_id = meta_phone_number_id,
               meta_waba_id = meta_waba_id
         where id = '${CANAL_OFICIAL}'`),
    ).toContain("LINHAS:1");
  });

  it("CONTROLE: o MESMO admin insere uma linha sem as colunas meta_*", () => {
    expect(comoAdminNoOficial(insercaoOficial(null))).toContain("LINHAS:1");
  });
});

describe("9104: o servidor (service role) grava a credencial do número oficial", () => {
  it("UPDATE das três colunas", () => {
    expect(
      comoServidorNoOficial(`
        update public.channel_sessions
           set meta_token_encrypted = '\\x02'::bytea, meta_phone_number_id = '9104-pn-novo',
               meta_waba_id = '9104-conta-nova'
         where id = '${CANAL_OFICIAL}'`),
    ).toContain("LINHAS:1");
  });

  it("UPDATE que zera o token (o que a exclusão do canal faz)", () => {
    expect(
      comoServidorNoOficial(`update public.channel_sessions set meta_token_encrypted = null where id = '${CANAL_OFICIAL}'`),
    ).toContain("LINHAS:1");
  });

  it.each(COLUNAS_OFICIAIS)("INSERT com %s", (coluna, valor) => {
    expect(comoServidorNoOficial(insercaoOficial(coluna, valor))).toContain("LINHAS:1");
  });
});
