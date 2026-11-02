/**
 * Ingestão das avaliações na Central — avaliação vira conversa + mensagem.
 *
 * ─── Por que reusar `conversations`/`messages` em vez de tabela própria ─────
 *
 * A Central (lista, detalhe, busca, abas, contagens) já sabe ler conversa. Uma
 * tabela de avaliações exigiria uma segunda tela com as mesmas quatro coisas e
 * deixaria a avaliação fora da fila de trabalho — que é justamente o problema
 * que a issue #3510 descreve. O que a avaliação tem de próprio (nota, escopo,
 * se já foi respondida) vive em `metadata`, que a lista já carrega.
 *
 * ─── Isolamento de organização ─────────────────────────────────────────────
 *
 * Toda leitura e toda escrita filtram por `organization_id` — o service role
 * bypassa RLS, então o filtro manual é a fronteira. O `channel_session_id` é
 * conferido contra a organização do chamador antes de qualquer escrita: um id
 * de canal de OUTRA organização não vira conversa aqui nem por engano.
 *
 * ─── Idempotência ──────────────────────────────────────────────────────────
 *
 * A sincronização roda de novo a cada consulta e reentrega a MESMA avaliação.
 * A chave é `(organization_id, external_id)` em `messages`, com o `23505`
 * tratado como "já estava lá" — mesma régua do canal intermediado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AvaliacaoDoGoogle } from "./avaliacoes";

/** O canal da avaliação não é desta organização (ou foi arquivado). */
export class CanalDeAvaliacoesAusente extends Error {
  constructor() {
    super("canal_de_avaliacoes_ausente");
    this.name = "CanalDeAvaliacoesAusente";
  }
}

export interface ResultadoDaEntrada {
  novas: number;
  repetidas: number;
}

export interface CanalDaAvaliacao {
  id: string;
  escopo: string;
}

/** Prefixo da identidade social do avaliador — opaca, nunca telefone. */
export function identidadeDoAvaliador(autor: string): string {
  return `googlebusiness:${autor.trim().toLowerCase()}`;
}

/** Id externo da mensagem: escopo + id da avaliação. */
export function idExternoDaAvaliacao(avaliacao: Pick<AvaliacaoDoGoogle, "escopo" | "id">): string {
  return `googlebusiness:${avaliacao.escopo}/reviews/${avaliacao.id}`;
}

/**
 * O canal existe, é desta organização e não está arquivado?
 *
 * Arquivo e DESLIGADO são coisas diferentes, e as duas importam:
 * `archived_at` é exclusão (não sincroniza mais nada); `metadata.disabled` é a
 * vontade do operador — a ingestão CONTINUA gravando, e a lista esconde
 * (`lib/channels/desativado.ts`). Sincronizar o desligado é o que faz o
 * histórico estar lá quando ele religar, sem reimportar nada.
 */
export async function lerCanalDaAvaliacao(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<CanalDaAvaliacao | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, metadata")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new CanalDeAvaliacoesAusente();
  const linha = data as { id: string; metadata: Record<string, unknown> | null } | null;
  if (!linha) return null;
  const escopo = linha.metadata?.google_business_escopo;
  return { id: linha.id, escopo: typeof escopo === "string" ? escopo : "" };
}

async function idDoContato(
  db: SupabaseClient,
  organizationId: string,
  autor: string,
): Promise<string> {
  const identidade = identidadeDoAvaliador(autor);
  const { data } = await db
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("social_identity", identidade)
    .maybeSingle();
  const existente = (data as { id: string } | null)?.id;
  if (existente) return existente;

  const { data: criado, error } = await db
    .from("contacts")
    .insert({
      organization_id: organizationId,
      display_name: autor,
      name: autor,
      social_identity: identidade,
      source: "google_business",
    })
    .select("id")
    .maybeSingle();
  if (error?.code === "23505") {
    // Corrida com outra sincronização: quem perdeu lê o vencedor.
    const { data: relido } = await db
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("social_identity", identidade)
      .maybeSingle();
    const id = (relido as { id: string } | null)?.id;
    if (id) return id;
    throw new Error("contact_for_review_failed");
  }
  const id = (criado as { id: string } | null)?.id;
  if (error || !id) throw new Error("contact_for_review_failed");
  return id;
}

async function idDaConversa(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  contactId: string,
  avaliacao: AvaliacaoDoGoogle,
): Promise<string> {
  const { data } = await db
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("contact_id", contactId)
    .maybeSingle();
  const existente = (data as { id: string } | null)?.id;
  if (existente) return existente;

  const { data: criada, error } = await db
    .from("conversations")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      channel_session_id: channelSessionId,
      channel: "googlebusiness",
      status: "open",
      metadata: {
        google_business: {
          escopo: avaliacao.escopo,
          nota: avaliacao.nota,
          respondida: avaliacao.respondida,
        },
      },
    })
    .select("id")
    .maybeSingle();
  if (error?.code === "23505") {
    const { data: relida } = await db
      .from("conversations")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("channel_session_id", channelSessionId)
      .eq("contact_id", contactId)
      .maybeSingle();
    const id = (relida as { id: string } | null)?.id;
    if (id) return id;
    throw new Error("conversation_for_review_failed");
  }
  const id = (criada as { id: string } | null)?.id;
  if (error || !id) throw new Error("conversation_for_review_failed");
  return id;
}

/**
 * Grava as avaliações do escopo na Central.
 *
 * Devolve quantas entraram e quantas já estavam — o número que o operador vê
 * como "3 novas" e o que a prova usa para a segunda rodada sair zero.
 */
export async function ingerirAvaliacoes(
  db: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    avaliacoes: AvaliacaoDoGoogle[];
  },
): Promise<ResultadoDaEntrada> {
  const canal = await lerCanalDaAvaliacao(db, input.organizationId, input.channelSessionId);
  if (!canal) throw new CanalDeAvaliacoesAusente();

  let novas = 0;
  let repetidas = 0;
  for (const avaliacao of input.avaliacoes) {
    const contactId = await idDoContato(db, input.organizationId, avaliacao.autor);
    const conversationId = await idDaConversa(
      db,
      input.organizationId,
      canal.id,
      contactId,
      avaliacao,
    );
    const quando = avaliacao.criadaEm ?? new Date().toISOString();
    const { error } = await db.from("messages").insert({
      organization_id: input.organizationId,
      conversation_id: conversationId,
      channel_session_id: canal.id,
      contact_id: contactId,
      external_id: idExternoDaAvaliacao(avaliacao),
      type: "text",
      direction: "inbound",
      status: "received",
      body: avaliacao.texto,
      sent_via: "system",
      sent_at: quando,
      metadata: {
        google_business: {
          nota: avaliacao.nota,
          autor: avaliacao.autor,
          escopo: avaliacao.escopo,
          respondida: avaliacao.respondida,
        },
      },
    });
    if (error?.code === "23505") {
      repetidas += 1;
      continue;
    }
    if (error) throw new Error("review_message_insert_failed");
    novas += 1;
    // A linha da lista é a última mensagem: nota e prévia andam juntas, senão
    // a conversa sobe por atividade com a nota da avaliação anterior.
    await db
      .from("conversations")
      .update({
        last_message_at: quando,
        last_inbound_at: quando,
        last_message_preview: avaliacao.texto || null,
        metadata: {
          google_business: {
            escopo: avaliacao.escopo,
            nota: avaliacao.nota,
            respondida: avaliacao.respondida,
          },
        },
      })
      .eq("organization_id", input.organizationId)
      .eq("id", conversationId);
  }
  return { novas, repetidas };
}
