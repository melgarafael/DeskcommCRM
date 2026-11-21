import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { assinar, chaveDeCobranca, criarOrg, criarPlano, insercaoDeCanal, uuid } from "./cobranca-helpers";

/**
 * O banco aceita o canal de chat no site (`webchat`) — Spec 36, F1, Task 1.
 *
 * Roda no Postgres descartável que nasce do `supabase/baseline.sql`
 * (`TEST_DB_CONTAINER`, via `scripts/test-db.sh`). O que se cobra é COMPORTAMENTO:
 * a linha certa entra, a errada é RECUSADA pelo nome da trava que a recusou.
 * Sem o nome no erro, "rejeitou" não distingue o CHECK certo de um NOT NULL ou de
 * um índice, e o caso passaria verde pelo motivo errado.
 */

const P = "c4a70001-0000-4000-8000";

let sequencia = 0;

/** Org descartável por caso: as travas são por organização. */
function novaOrg(): string {
  sequencia += 1;
  const id = uuid(P, sequencia);
  criarOrg(id, `webchat-banco-${sequencia}`);
  return id;
}

/** INSERT de sessão, SEM `;`. Quem chama decide as colunas do canal. */
function insercao(org: string, cols: Record<string, string>): string {
  const nomes = ["organization_id", "webhook_secret_encrypted", ...Object.keys(cols)];
  const vals = [`'${org}'`, `'\\x00'::bytea`, ...Object.values(cols)];
  return `insert into public.channel_sessions (${nomes.join(", ")}) values (${vals.join(", ")})`;
}

/** Stderr do psql quando o script falha, ou "" quando passa. */
function erroDe(script: string): string {
  try {
    sql(`${script};`);
    return "";
  } catch (e) {
    // execFileSync joga o stderr do psql em `stderr`; a mensagem do Error só traz o exit.
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
}

describe("chat no site · o banco aceita provider webchat", () => {
  it("aceita provider 'webchat' com chave pública", () => {
    const org = novaOrg();
    expect(erroDe(insercao(org, { provider: "'webchat'", webchat_public_key: "'wck_aceita_com_chave'" }))).toBe("");
  });

  it("recusa provider 'webchat' sem chave pública (provider_ref_check)", () => {
    const org = novaOrg();
    const msg = erroDe(insercao(org, { provider: "'webchat'" }));
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("aceita conversations.channel = 'webchat'", () => {
    const org = novaOrg();
    const sessao = uuid(P, 10_000 + sequencia);
    const contato = uuid(P, 20_000 + sequencia);
    const conversa = uuid(P, 30_000 + sequencia);
    const script = `
      ${insercao(org, { id: `'${sessao}'`, provider: "'webchat'", webchat_public_key: `'wck_conversa_${sequencia}'` })};
      insert into public.contacts (id, organization_id, display_name) values ('${contato}', '${org}', 'Visitante fictício');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, channel)
        values ('${conversa}', '${org}', '${contato}', '${sessao}', 'open', 'webchat');
    `;
    expect(erroDe(script)).toBe("");
  });

  it("recusa conversations.channel fora do vocabulário (conversations_channel_check)", () => {
    const org = novaOrg();
    const sessao = uuid(P, 40_000 + sequencia);
    const contato = uuid(P, 50_000 + sequencia);
    const script = `
      ${insercao(org, { id: `'${sessao}'`, provider: "'webchat'", webchat_public_key: `'wck_canal_invalido_${sequencia}'` })};
      insert into public.contacts (id, organization_id, display_name) values ('${contato}', '${org}', 'Visitante fictício');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, channel)
        values ('${uuid(P, 60_000 + sequencia)}', '${org}', '${contato}', '${sessao}', 'open', 'canal_inexistente');
    `;
    expect(erroDe(script)).toMatch(/conversations_channel_check/);
  });
});

describe("chat no site · origens permitidas (fn_webchat_origens_validas)", () => {
  const arrayDe = (origens: string[]) => `ARRAY[${origens.map((o) => `'${o}'`).join(", ")}]::text[]`;

  it("recusa 21 origens (o teto é 20)", () => {
    const org = novaOrg();
    const origens = Array.from({ length: 21 }, (_, i) => `https://a${i}.com`);
    const msg = erroDe(
      insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_21_${sequencia}'`, webchat_allowed_origins: arrayDe(origens) }),
    );
    expect(msg).toMatch(/channel_sessions_webchat_allowed_origins_check/);
  });

  it("recusa origem com caminho", () => {
    const org = novaOrg();
    const msg = erroDe(
      insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_caminho_${sequencia}'`, webchat_allowed_origins: arrayDe(["https://a.com/caminho"]) }),
    );
    expect(msg).toMatch(/channel_sessions_webchat_allowed_origins_check/);
  });

  it("recusa origem em http (que não seja tratada pela rota de loopback)", () => {
    const org = novaOrg();
    const msg = erroDe(
      insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_http_${sequencia}'`, webchat_allowed_origins: arrayDe(["http://a.com"]) }),
    );
    expect(msg).toMatch(/channel_sessions_webchat_allowed_origins_check/);
  });

  it("aceita http://localhost:3000 (o banco aceita o loopback; a rota decide quando vale)", () => {
    const org = novaOrg();
    expect(
      erroDe(insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_localhost_${sequencia}'`, webchat_allowed_origins: arrayDe(["http://localhost:3000"]) })),
    ).toBe("");
  });

  it("recusa elemento NULL na lista de origens (NULL não é origem)", () => {
    const org = novaOrg();
    const msg = erroDe(
      insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_null_${sequencia}'`, webchat_allowed_origins: "ARRAY[NULL]::text[]" }),
    );
    expect(msg).toMatch(/channel_sessions_webchat_allowed_origins_check/);
  });

  it("aceita https com host e com porta", () => {
    const org = novaOrg();
    expect(
      erroDe(insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_https_${sequencia}'`, webchat_allowed_origins: arrayDe(["https://a.com"]) })),
    ).toBe("");
    const org2 = novaOrg();
    expect(
      erroDe(insercao(org2, { provider: "'webchat'", webchat_public_key: `'wck_porta_${sequencia}'`, webchat_allowed_origins: arrayDe(["https://a.com:8443"]) })),
    ).toBe("");
  });
});

describe("chat no site · a chave pública é única entre conexões ativas", () => {
  it("duas conexões ATIVAS com a mesma chave são recusadas", () => {
    const chave = "'wck_chave_repetida_unica'";
    const org = novaOrg();
    expect(erroDe(insercao(org, { provider: "'webchat'", webchat_public_key: chave }))).toBe("");
    const msg = erroDe(insercao(novaOrg(), { provider: "'webchat'", webchat_public_key: chave }));
    expect(msg).toMatch(/channel_sessions_webchat_public_key_ativa_unique|duplicate key/);
  });
});

describe("chat no site · uma conexão ativa por organização", () => {
  it("a segunda conexão webchat ATIVA da mesma organização dá 23505", () => {
    const org = novaOrg();
    expect(erroDe(insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_org_um_${sequencia}'` }))).toBe("");
    const msg = erroDe(insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_org_dois_${sequencia}'` }));
    expect(msg).toMatch(/23505|channel_sessions_webchat_org_ativa_unique/);
  });

  it("uma conexão ARQUIVADA mais uma ATIVA da mesma organização passa", () => {
    const org = novaOrg();
    expect(
      erroDe(
        insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_arq_${sequencia}'`, archived_at: "now()" }),
      ),
    ).toBe("");
    expect(erroDe(insercao(org, { provider: "'webchat'", webchat_public_key: `'wck_ativa_${sequencia}'` }))).toBe("");
  });
});

describe("chat no site · o plano não conta o canal webchat como número", () => {
  const PLANO = uuid(P, 90_000);
  const ORG = uuid(P, 90_001);
  const WHATSAPP = uuid(P, 90_002);
  const WEBCHAT = uuid(P, 90_003);

  beforeAll(() => {
    criarPlano({ id: PLANO, nome: "Um número (chat)", maxCanais: 1 });
    criarOrg(ORG, "webchat-banco-plano");
    assinar(ORG, PLANO);
    chaveDeCobranca("ligado");
  });

  it("com teto 1, o WhatsApp ocupa a vaga e o webchat depois não dá PT402", () => {
    sql(`${insercaoDeCanal(WHATSAPP, ORG)};`);
    const msg = erroDe(
      insercao(ORG, { id: `'${WEBCHAT}'`, provider: "'webchat'", webchat_public_key: "'wck_plano_teste_um'" }),
    );
    expect(msg).not.toContain("PT402");
    expect(msg).toBe("");
  });
});

describe("chat no site · reviver a vaga não conta o webchat", () => {
  const PLANO = uuid(P, 91_000);
  const ORG = uuid(P, 91_001);
  const CHAT_ATIVO = uuid(P, 91_002);
  const WAHA_MORTO = uuid(P, 91_003);

  beforeAll(() => {
    criarPlano({ id: PLANO, nome: "Um número (reviver chat)", maxCanais: 1 });
    criarOrg(ORG, "webchat-banco-reviver");
    assinar(ORG, PLANO);
    chaveDeCobranca("ligado");
  });

  it("com teto 1 e um webchat ativo, reviver a linha WAHA morta sem número não dá PT402", () => {
    // O chat ativo não pode ocupar a vaga: se contasse, a conta daria 1 >= 1 e o reviver
    // recusaria. A linha WAHA morta sem número também não ocupa (0809).
    sql(`${insercao(ORG, { id: `'${CHAT_ATIVO}'`, provider: "'webchat'", webchat_public_key: "'wck_reviver_ativo'" })};`);
    sql(`${insercao(ORG, { id: `'${WAHA_MORTO}'`, waha_session_name: `'reviver-morto'`, status: "'FAILED'" })};`);
    expect(
      erroDe(`set role service_role; select public.fn_vaga_ao_reviver_canal('${ORG}', '${WAHA_MORTO}')`),
    ).toBe("");
    expect(sql(`select status from public.channel_sessions where id = '${WAHA_MORTO}';`).trim().split("\n").at(-1)).toBe("STARTING");
  });
});
