/**
 * O chat no site não atravessa organização — Spec 36, F1, Task 10.
 *
 * Duas organizações, cada uma com a sua conexão de chat e o seu visitante. O que se cobra é o que
 * a organização B NÃO pode ver nem gravar com as coisas da organização A:
 *
 *   - a chave pública de A resolve a conexão de A, e a de B a de B;
 *   - a entrada pela conexão de A, com o id de um visitante de B, não mexe na conversa de B;
 *   - a leitura das saídas (a função real de `eventos.ts`) da conversa de A não traz nada de B,
 *     e a leitura com a organização errada não traz nada;
 *   - dois visitantes da MESMA organização não leem a conversa um do outro;
 *   - anonimizar o contato de A limpa `contacts.social_identity` dele e não toca o de B.
 *
 * Roda no Postgres descartável (`TEST_DB_CONTAINER`, via `scripts/test-db.sh`). O cliente é a ponte
 * PostgREST→SQL do harness (`tests/support/routing-pg-supabase.ts`): as tabelas, as funções e as
 * travas são reais; o que a ponte não tem é a RLS de sessão, e este invariante não depende dela
 * porque o isolamento que mede é o do filtro de `organization_id` que o código escreve à mão.
 *
 * A pós-entrada (opt-out, lead, agente) fica de fora: é efeito, e não é o que este arquivo mede.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEXTO_DO_AVISO_VERSAO } from "@/lib/channels/webchat/config";
import { conexaoPelaChave } from "@/lib/channels/webchat/conexao-pela-chave";
import { conversaDoVisitante, lerSaidasNovas } from "@/lib/channels/webchat/eventos";
import { ingerirMensagemDoChat, type IngerirMensagemDoChatInput } from "@/lib/channels/webchat/ingest";

import { routingPgSupabase } from "../support/routing-pg-supabase";

vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const admin = routingPgSupabase(pool).client;

/** uuid fixo por caso: o prefixo é deste arquivo, para não colidir com os outros invariantes. */
const P = "c4a70010-0000-4000-8000";
const uuid = (n: number) => `${P}-${String(n).padStart(12, "0")}`;

const ORG_A = uuid(1);
const ORG_B = uuid(2);
const SESSAO_A = uuid(3);
const SESSAO_B = uuid(4);
const CHAVE_A = "wck_isolamento_chave_a";
const CHAVE_B = "wck_isolamento_chave_b";
const VISITANTE_A1 = uuid(10);
const VISITANTE_A2 = uuid(11);
const VISITANTE_B1 = uuid(12);

/** O módulo do chat nasce desligado; o teste liga a instalação e devolve o valor anterior no fim. */
let moduloAnterior: string | null | undefined;

async function consulta(texto: string, valores: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await pool.query(texto, valores)).rows;
}

async function conexaoDe(chave: string) {
  const conexao = await conexaoPelaChave(admin, chave);
  if (!conexao) throw new Error("conexao_do_chat_nao_resolvida");
  return conexao;
}

/**
 * A entrada como o widget a manda: a primeira mensagem de cada visitante leva o aceite (LGPD).
 * Uma recusa aqui é falha do teste, não resultado a medir.
 */
async function entrar(p: Omit<IngerirMensagemDoChatInput, "aceite" | "coleta" | "contato">) {
  const r = await ingerirMensagemDoChat(admin, {
    ...p,
    aceite: { versao: TEXTO_DO_AVISO_VERSAO, em: p.agora.toISOString() },
  });
  if (r.status === "recusada") throw new Error(`entrada_recusada_no_teste: ${r.motivo}`);
  return r;
}

async function contagemNaConversa(conversaId: string): Promise<number> {
  const linhas = await consulta("select count(*)::int as n from messages where conversation_id = $1", [conversaId]);
  return Number(linhas[0]?.n ?? 0);
}

/** Uma resposta do CRM, como a rota de envio a grava: `sent`, de saída, com o `wc:out:` do adaptador. */
async function gravarSaida(organizacao: string, conversaId: string, texto: string): Promise<void> {
  const [conversa] = await consulta(
    "select contact_id, channel_session_id from conversations where id = $1 and organization_id = $2",
    [conversaId, organizacao],
  );
  if (!conversa) throw new Error("conversa_de_teste_ausente");
  await consulta(
    `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, external_id,
                           direction, sent_via, status, type, body, sent_at)
     values ($1, $2, $3, $4, $5, 'outbound', 'ai', 'sent', 'text', $6, now())`,
    [organizacao, conversaId, conversa.contact_id, conversa.channel_session_id, `wc:out:${randomUUID()}`, texto],
  );
}

beforeAll(async () => {
  const anterior = await consulta("select valor from platform_config where chave = 'MODULO_CANAL_WEBCHAT'");
  moduloAnterior = anterior[0] ? ((anterior[0].valor as string | null) ?? null) : undefined;
  await consulta(
    `insert into platform_config (chave, valor) values ('MODULO_CANAL_WEBCHAT', 'ligado')
     on conflict (chave) do update set valor = excluded.valor`,
  );

  for (const [id, slug] of [
    [ORG_A, "webchat-iso-a"],
    [ORG_B, "webchat-iso-b"],
  ] as const) {
    await consulta(
      `insert into organizations (id, slug, legal_name, display_name, status)
       values ($1, $2::citext, $2::text, $2::text, 'active') on conflict (id) do nothing`,
      [id, slug],
    );
  }
  for (const [id, org, chave] of [
    [SESSAO_A, ORG_A, CHAVE_A],
    [SESSAO_B, ORG_B, CHAVE_B],
  ] as const) {
    await pool.query(
      `insert into channel_sessions (id, organization_id, provider, webchat_public_key, webhook_secret_encrypted)
       values ($1, $2, 'webchat', $3, $4)`,
      [id, org, chave, Buffer.alloc(1)],
    );
  }
});

afterAll(async () => {
  if (moduloAnterior === undefined) {
    await consulta("delete from platform_config where chave = 'MODULO_CANAL_WEBCHAT'");
  } else if (moduloAnterior === null) {
    await consulta("update platform_config set valor = null where chave = 'MODULO_CANAL_WEBCHAT'");
  } else {
    await consulta("update platform_config set valor = $1 where chave = 'MODULO_CANAL_WEBCHAT'", [moduloAnterior]);
  }
  await pool.end();
});

describe("chat no site · a chave pública é da organização certa", () => {
  it("a chave de A resolve a conexão de A, e a de B a de B", async () => {
    const a = await conexaoDe(CHAVE_A);
    const b = await conexaoDe(CHAVE_B);
    expect(a).toMatchObject({ id: SESSAO_A, organizationId: ORG_A });
    expect(b).toMatchObject({ id: SESSAO_B, organizationId: ORG_B });
  });
});

describe("chat no site · a entrada fica na organização da conexão", () => {
  let mensagemDeB: { conversationId: string; messageId: string | null };

  beforeAll(async () => {
    const conexaoB = await conexaoDe(CHAVE_B);
    mensagemDeB = await entrar({
      organizationId: conexaoB.organizationId,
      channelSessionId: conexaoB.id,
      visitanteId: VISITANTE_B1,
      mensagemId: "m-b1",
      texto: "oi, sou de B",
      agora: new Date(),
    });
  });

  it("a entrada pela conexão de A grava a conversa e a mensagem só em A", async () => {
    const conexaoA = await conexaoDe(CHAVE_A);
    const r = await entrar({
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_A1,
      mensagemId: "m-a1",
      texto: "oi, sou de A",
      agora: new Date(),
    });
    expect(r.status).toBe("ingested");
    const [conversa] = await consulta("select organization_id from conversations where id = $1", [r.conversationId]);
    const [mensagem] = await consulta("select organization_id from messages where id = $1", [r.messageId]);
    expect(conversa?.organization_id).toBe(ORG_A);
    expect(mensagem?.organization_id).toBe(ORG_A);
  });

  it("a chave de A, com o id de um visitante de B, não cria mensagem na conversa de B", async () => {
    const antes = await contagemNaConversa(mensagemDeB.conversationId);
    const conexaoA = await conexaoDe(CHAVE_A);
    const cruzada = await entrar({
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_B1,
      mensagemId: "m-cruzada",
      texto: "tentativa cruzada",
      agora: new Date(),
    });
    expect(cruzada.conversationId).not.toBe(mensagemDeB.conversationId);
    expect(await contagemNaConversa(mensagemDeB.conversationId)).toBe(antes);
    const onde = await consulta("select organization_id from messages where body = 'tentativa cruzada'");
    expect(onde.map((l) => l.organization_id)).toEqual([ORG_A]);
  });

  it("primeira mensagem sem aceite é recusada e não cria contato, conversa nem mensagem em A", async () => {
    const conexaoA = await conexaoDe(CHAVE_A);
    const visitante = uuid(20);
    const r = await ingerirMensagemDoChat(admin, {
      organizationId: ORG_A,
      channelSessionId: conexaoA.id,
      visitanteId: visitante,
      mensagemId: "m-sem-aceite",
      texto: "oi sem aceite",
      agora: new Date(),
    });
    expect(r).toMatchObject({ status: "recusada", motivo: "aceite_ausente" });

    const contatos = await consulta(
      "select id from contacts where organization_id = $1 and social_identity = $2",
      [ORG_A, `webchat:${conexaoA.id}:${visitante}`],
    );
    const conversas = await consulta(
      "select id from conversations where organization_id = $1 and provider_conversation_id = $2",
      [ORG_A, visitante],
    );
    const mensagens = await consulta(
      "select id from messages where organization_id = $1 and external_id = $2",
      [ORG_A, `wc:${conexaoA.id}:${visitante}:m-sem-aceite`],
    );
    expect(contatos).toHaveLength(0);
    expect(conversas).toHaveLength(0);
    expect(mensagens).toHaveLength(0);
  });
});

describe("chat no site · a leitura das respostas não atravessa organização", () => {
  let conversaA1: string;
  let conversaB1: string;

  beforeAll(async () => {
    const conexaoA = await conexaoDe(CHAVE_A);
    const conexaoB = await conexaoDe(CHAVE_B);
    conversaA1 = (await conversaDoVisitante(admin, {
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_A1,
    }))!;
    conversaB1 = (await conversaDoVisitante(admin, {
      organizationId: conexaoB.organizationId,
      channelSessionId: conexaoB.id,
      visitanteId: VISITANTE_B1,
    }))!;
    await gravarSaida(ORG_A, conversaA1, "resposta para A1");
    await gravarSaida(ORG_B, conversaB1, "resposta para B1");
  });

  it("a leitura da conversa de A, com a organização de A, não traz mensagem de B", async () => {
    const textos = (await lerSaidasNovas(admin, { organizationId: ORG_A, conversationId: conversaA1, limite: 50 })).map(
      (s) => s.texto,
    );
    expect(textos).toContain("resposta para A1");
    expect(textos).not.toContain("resposta para B1");
  });

  it("ler a conversa de A com a organização de B devolve vazio, e o contrário também", async () => {
    expect(await lerSaidasNovas(admin, { organizationId: ORG_B, conversationId: conversaA1, limite: 50 })).toEqual([]);
    expect(await lerSaidasNovas(admin, { organizationId: ORG_A, conversationId: conversaB1, limite: 50 })).toEqual([]);
  });

  it("dois visitantes da mesma organização não leem a conversa um do outro", async () => {
    const conexaoA = await conexaoDe(CHAVE_A);
    await entrar({
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_A2,
      mensagemId: "m-a2",
      texto: "oi, sou o A2",
      agora: new Date(),
    });
    const conversaA2 = (await conversaDoVisitante(admin, {
      organizationId: ORG_A,
      channelSessionId: SESSAO_A,
      visitanteId: VISITANTE_A2,
    }))!;
    expect(conversaA2).not.toBe(conversaA1);
    await gravarSaida(ORG_A, conversaA2, "so para A2");

    const textosDeA1 = (await lerSaidasNovas(admin, { organizationId: ORG_A, conversationId: conversaA1, limite: 50 })).map(
      (s) => s.texto,
    );
    expect(textosDeA1).not.toContain("so para A2");
  });
});

describe("chat no site · anonimizar o contato limpa a identidade social", () => {
  it("anonimizar o contato de A zera o social_identity dele e não toca o de B", async () => {
    const conexaoA = await conexaoDe(CHAVE_A);
    const conversaA1 = (await conversaDoVisitante(admin, {
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_A1,
    }))!;
    const [conversa] = await consulta("select contact_id from conversations where id = $1", [conversaA1]);
    const contatoA = conversa?.contact_id as string;

    const antes = await consulta("select social_identity from contacts where id = $1 and organization_id = $2", [
      contatoA,
      ORG_A,
    ]);
    expect(antes[0]?.social_identity).toBe(`webchat:${SESSAO_A}:${VISITANTE_A1}`);

    await consulta(
      "update contacts set is_anonymized = true, anonymized_at = now() where id = $1 and organization_id = $2",
      [contatoA, ORG_A],
    );

    const depois = await consulta("select social_identity from contacts where id = $1 and organization_id = $2", [
      contatoA,
      ORG_A,
    ]);
    expect(depois[0]?.social_identity).toBeNull();

    const contatoDeB = await consulta(
      "select social_identity from contacts where organization_id = $1 and social_identity = $2",
      [ORG_B, `webchat:${SESSAO_B}:${VISITANTE_B1}`],
    );
    expect(contatoDeB).toHaveLength(1);
  });

  it("depois de anonimizar, o visitante que volta recebe a resposta da conversa nova pela leitura", async () => {
    const conexaoA = await conexaoDe(CHAVE_A);
    const conversaAntiga = (await conversaDoVisitante(admin, {
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_A1,
    }))!;
    const [antiga] = await consulta("select contact_id from conversations where id = $1", [conversaAntiga]);
    await consulta(
      "update contacts set is_anonymized = true, anonymized_at = now() where id = $1 and organization_id = $2",
      [antiga?.contact_id as string, ORG_A],
    );

    const volta = await entrar({
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_A1,
      mensagemId: "m-a1-volta",
      texto: "voltei depois de anonimizar",
      agora: new Date(),
    });
    expect(volta.conversationId).not.toBe(conversaAntiga);

    await gravarSaida(ORG_A, volta.conversationId, "resposta na conversa nova");

    const maisRecente = await conversaDoVisitante(admin, {
      organizationId: conexaoA.organizationId,
      channelSessionId: conexaoA.id,
      visitanteId: VISITANTE_A1,
    });
    expect(maisRecente).toBe(volta.conversationId);

    const textos = (
      await lerSaidasNovas(admin, { organizationId: ORG_A, conversationId: maisRecente!, limite: 50 })
    ).map((s) => s.texto);
    expect(textos).toContain("resposta na conversa nova");
  });
});
