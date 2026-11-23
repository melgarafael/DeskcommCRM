import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  conversaAbreNegocio,
  lerNegocioDoCanal,
  salvarNegocioDoCanal,
} from "@/lib/channels/negocio-da-conversa";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * A CONEXÃO DECIDE SE A CONVERSA NOVA ABRE NEGÓCIO (#4670) — contra o SCHEMA real.
 *
 * A issue mediu o problema em produção: uma empresa com vários números usa só
 * alguns para vender, e todo número abria card. A chave é POR CONEXÃO, ligada
 * por padrão, e o DEFAULT é o que faz a atualização ser invisível — por isso o
 * que se mede aqui é o BANCO, não uma reescrita da consulta em SQL:
 * `pgComoSupabase` troca só o transporte, e a decisão que roda é a de produção
 * (`garantirLeadDaConversa`).
 *
 * Congela: (1) a conexão desligada NÃO cria `crm_leads` e devolve o motivo
 * próprio; (2) a ligada cria como antes; (3) a linha anterior à coluna (o
 * estado de toda instalação que só atualiza) continua criando — e o DEFAULT
 * declarado é `true`; (4) a organização B não lê nem grava a chave da A; (5) a
 * mesma porta que o cartão da conexão usa (ler/salvar) muda a decisão de
 * verdade.
 *
 * Comando:
 *     pnpm test:db tests/invariants/conexao-decide-se-a-conversa-cria-negocio.test.ts
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG_A = "4670c000-0000-4000-8000-00000000000a";
const ORG_B = "4670c000-0000-4000-8000-00000000000b";

/** O número de suporte da issue: conversa nova NÃO abre negócio. */
const SESSAO_DESLIGADA = "4670c000-1111-4000-8000-000000000001";
/** O número de vendas: abre, como sempre. */
const SESSAO_LIGADA = "4670c000-1111-4000-8000-000000000002";
/** Linha anterior à migration: INSERT sem a coluna — é a instalação antiga. */
const SESSAO_ANTIGA = "4670c000-1111-4000-8000-000000000003";
/** O número que o cartão da conexão vai desligar e religar. */
const SESSAO_DO_CARTAO = "4670c000-1111-4000-8000-000000000004";
/** Conexão da organização vizinha. */
const SESSAO_B = "4670c000-1111-4000-8000-00000000000b";

const CONVERSA_DESLIGADA = "4670c000-2222-4000-8000-000000000001";
const CONVERSA_LIGADA = "4670c000-2222-4000-8000-000000000002";
const CONVERSA_ANTIGA = "4670c000-2222-4000-8000-000000000003";
const CONVERSA_DO_CARTAO = "4670c000-2222-4000-8000-000000000004";
const CONVERSA_B = "4670c000-2222-4000-8000-00000000000b";

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Conexão 4670 LTDA', 'Conexão 4670') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function criarContato(org: string, nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'whatsapp') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

async function criarConversa(org: string, contato: string, sessao: string, id: string): Promise<void> {
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id)
     values ($1, $2, $3, $4)`,
    [id, org, contato, sessao],
  );
}

/** A prova que importa é a do BANCO: um retorno pode dizer "não criei" e a linha existir. */
async function cardsDoContato(contato: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*) as n from crm_leads where contact_id = $1",
    [contato],
  );
  return Number(rows[0]!.n);
}

let contatoDesligado: string;
let contatoLigado: string;
let contatoAntigo: string;
let contatoDoCartao: string;
let contatoB: string;

beforeAll(async () => {
  await criarOrg(ORG_A, "org-4670-a");
  await criarOrg(ORG_B, "org-4670-b");

  // `webhook_secret_encrypted` é NOT NULL e as quatro linhas só diferem no que
  // esta feature acrescenta — a ANTIGA não nomeia a coluna de propósito.
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, conversa_nova_cria_negocio)
     values ($1, $4, '4670-desligada', '\\x00'::bytea, false),
            ($2, $4, '4670-ligada',    '\\x00'::bytea, true),
            ($3, $4, '4670-cartao',    '\\x00'::bytea, true)`,
    [SESSAO_DESLIGADA, SESSAO_LIGADA, SESSAO_DO_CARTAO, ORG_A],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, $2, '4670-antiga', '\\x00'::bytea)`,
    [SESSAO_ANTIGA, ORG_A],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, $2, '4670-vizinha', '\\x00'::bytea)`,
    [SESSAO_B, ORG_B],
  );

  contatoDesligado = await criarContato(ORG_A, "Suporte Desligado");
  contatoLigado = await criarContato(ORG_A, "Vendas Ligado");
  contatoAntigo = await criarContato(ORG_A, "Instalação Antiga");
  contatoDoCartao = await criarContato(ORG_A, "Cartão da Conexão");
  contatoB = await criarContato(ORG_B, "Vizinha");

  await criarConversa(ORG_A, contatoDesligado, SESSAO_DESLIGADA, CONVERSA_DESLIGADA);
  await criarConversa(ORG_A, contatoLigado, SESSAO_LIGADA, CONVERSA_LIGADA);
  await criarConversa(ORG_A, contatoAntigo, SESSAO_ANTIGA, CONVERSA_ANTIGA);
  await criarConversa(ORG_A, contatoDoCartao, SESSAO_DO_CARTAO, CONVERSA_DO_CARTAO);
  await criarConversa(ORG_B, contatoB, SESSAO_B, CONVERSA_B);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("#4670 · a conexão decide, e o banco prova", () => {
  it("⭐ conexão DESLIGADA: nenhum `crm_leads` nasce, e o motivo é próprio", async () => {
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_A,
      contactId: contatoDesligado,
      conversationId: CONVERSA_DESLIGADA,
      nomeDoContato: "Suporte Desligado",
    });

    expect(r).toEqual({ criado: false, motivo: "conexao_nao_cria_negocio" });
    expect(await cardsDoContato(contatoDesligado), "o funil não pode ganhar o card").toBe(0);
  });

  it("conexão LIGADA, da MESMA organização: cria como hoje", async () => {
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_A,
      contactId: contatoLigado,
      conversationId: CONVERSA_LIGADA,
      nomeDoContato: "Vendas Ligado",
    });

    expect(r).toMatchObject({ criado: true });
    expect(await cardsDoContato(contatoLigado)).toBe(1);
  });

  it("CONTROLE · instalação antiga: a linha sem a coluna continua criando, e o DEFAULT é `true`", async () => {
    const { rows } = await pool.query<{ column_default: string | null }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'channel_sessions'
          and column_name = 'conversa_nova_cria_negocio'`,
    );
    // O DEFAULT não é detalhe: é ele que faz a atualização não mudar nada para
    // quem nunca abrir a tela. Invertê-lo derruba este caso, e o de baixo.
    expect(rows[0]?.column_default, "o DEFAULT tem de ser ligado").toContain("true");

    const daLinhaAntiga = await pool.query<{ valor: boolean }>(
      "select conversa_nova_cria_negocio as valor from channel_sessions where id = $1",
      [SESSAO_ANTIGA],
    );
    expect(daLinhaAntiga.rows[0]?.valor, "linha que não nomeia a coluna nasce ligada").toBe(true);

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_A,
      contactId: contatoAntigo,
      conversationId: CONVERSA_ANTIGA,
      nomeDoContato: "Instalação Antiga",
    });
    expect(r).toMatchObject({ criado: true });
    expect(await cardsDoContato(contatoAntigo)).toBe(1);
  });

  it("organização B não lê nem grava a chave da A", async () => {
    expect(await lerNegocioDoCanal(db, ORG_A, SESSAO_DESLIGADA)).toBe(false);
    // A MESMA sessão, pedida pela vizinha, não existe para ela.
    expect(await lerNegocioDoCanal(db, ORG_B, SESSAO_DESLIGADA)).toBeNull();
    expect(await salvarNegocioDoCanal(db, ORG_B, SESSAO_DESLIGADA, true)).toBeNull();

    // E o valor de A continua o que era — a tentativa de fora não gravou nada.
    expect(await lerNegocioDoCanal(db, ORG_A, SESSAO_DESLIGADA)).toBe(false);

    // A conversa da A também não existe para a B: a decisão que volta é a de
    // hoje, não a chave da vizinha.
    expect(await conversaAbreNegocio(db, ORG_B, CONVERSA_DESLIGADA)).toEqual({ cria: true });
  });

  it("a porta do cartão da conexão muda a decisão de verdade: desligar recusa, religar volta a criar", async () => {
    expect(await salvarNegocioDoCanal(db, ORG_A, SESSAO_DO_CARTAO, false)).toBe(false);
    expect(await lerNegocioDoCanal(db, ORG_A, SESSAO_DO_CARTAO)).toBe(false);

    // Com a chave desligada, esta conversa não abre card…
    const recusado = await garantirLeadDaConversa(db, {
      organizationId: ORG_A,
      contactId: contatoDoCartao,
      conversationId: CONVERSA_DO_CARTAO,
      nomeDoContato: "Cartão da Conexão",
    });
    expect(recusado).toMatchObject({ criado: false, motivo: "conexao_nao_cria_negocio" });
    expect(await cardsDoContato(contatoDoCartao)).toBe(0);

    // …e religar faz a PRÓXIMA mensagem criar, sem ninguém tocar em nada:
    // é o "a próxima tenta de novo" que a recusa promete.
    expect(await salvarNegocioDoCanal(db, ORG_A, SESSAO_DO_CARTAO, true)).toBe(true);
    const depois = await garantirLeadDaConversa(db, {
      organizationId: ORG_A,
      contactId: contatoDoCartao,
      conversationId: CONVERSA_DO_CARTAO,
      nomeDoContato: "Cartão da Conexão",
    });
    expect(depois).toMatchObject({ criado: true });
    expect(await cardsDoContato(contatoDoCartao)).toBe(1);
  });
});
