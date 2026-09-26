/**
 * Rascunho sugerido por integração (issue #1611) — as regras num lugar só.
 *
 * ─── O que é ────────────────────────────────────────────────────────────────
 *
 * Há operações em que a mensagem ao cliente precisa sair de uma PESSOA, mas
 * quem sabe o que dizer é outro sistema (ERP que sabe que a cobrança venceu,
 * documento faltando, formulário a reenviar). Hoje a integração só tem duas
 * saídas ruins: enviar por token (a bolha diz `Sistema`, `sent_by_user_id` fica
 * nulo e a IA não é silenciada como no envio humano) ou copiar-e-colar.
 *
 * Este módulo é a terceira: a integração GUARDA o texto no servidor, recebe a
 * URL, e a caixa de entrada abre com o texto no `Composer` e o aviso de origem.
 * Nada é enviado sem o clique de quem atende — por isso as regras de validade
 * vivem aqui, separadas da rota e da tool MCP, que são duas portas para a mesma
 * casa.
 *
 * ─── Por que o texto NÃO vai na URL ─────────────────────────────────────────
 *
 * Mensagem a cliente costuma ter dado pessoal, e URL acaba em registro de
 * proxy, histórico do navegador e relatório de erro; o comprimento é limitado;
 * e um link com texto pronto, mandado por qualquer pessoa, vira engenharia
 * social contra o atendente. Com a linha guardada, só quem tem token da
 * organização cria.
 *
 * Módulo PURO de propósito: zero import de runtime — só tipos. É o que deixa
 * `components/inbox/Composer.tsx` (client) importar os tipos daqui sem puxar
 * servidor para o navegador, e o que deixa o teste unitário falar com um dublê
 * de cliente em vez de banco.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Mesmo teto do envio (`sendMessageSchema`). O CHECK da migration espelha isto. */
export const TEXTO_MAXIMO = 4096;

/** Janela da issue: 24h, contando da criação. */
export const JANELA_PADRAO_HORAS = 24;

/** Máximo aceito em `expira_em_horas` (30 dias) — acima disso é descuido. */
export const JANELA_MAXIMA_HORAS = 720;

export type MotivoDeRecusa = "nao_encontrado" | "outra_conversa" | "usado" | "expirado";

/**
 * O que a caixa de entrada recebe, JUNTO da conversa a que pertence.
 *
 * `conversationId` vem da URL (`?id=`), não da leitura: quando o rascunho não
 * vale mais a leitura não tem conversa nenhuma, e é a conversa da URL que diz
 * ONDE o aviso aparece.
 */
export interface AvisoDeRascunho {
  conversationId: string;
  leitura: LeituraDoRascunho;
}

/** Forma canônica de UUID v4. Fora disto a coluna nem recebe a consulta. */
export function ehUuid(valor: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor);
}

/**
 * O que a caixa de entrada recebe. Dois estados, e os dois são AVISO: a issue
 * pede que a conversa abra "sem texto e com aviso" quando o rascunho não vale
 * mais — silenciar seria fazer o atendente achar que o texto nunca existiu.
 */
export type LeituraDoRascunho =
  | {
      estado: "sugerido";
      draftId: string;
      conversationId: string;
      texto: string;
      origem: string;
    }
  | { estado: "indisponivel"; motivo: MotivoDeRecusa };

export type ResultadoDaCriacao =
  | { ok: true; draftId: string; url: string }
  | { ok: false; motivo: "texto_invalido" | "origem_invalida" | "conversa_nao_encontrada" };

/**
 * O link que a integração recebe. Os DOIS parâmetros porque `?rascunho=` sem
 * `?id=` não diz de qual conversa o texto é — e a régua de leitura recusa
 * rascunho de outra conversa.
 */
export function urlDoRascunho(conversationId: string, draftId: string): string {
  return `/app/inbox?id=${conversationId}&rascunho=${draftId}`;
}

interface EntradaDeCriacao {
  organizationId: string;
  conversationId: string;
  texto: string;
  origem: string;
  expiraEmHoras?: number;
  apiTokenId?: string | null;
}

/**
 * Cria o rascunho. A conversa é conferida COM o `organization_id` na mesma
 * consulta: um token de uma organização não cria rascunho em conversa de
 * outra — é o critério de aceite da issue, e o filtro programático é
 * obrigatório porque o caminho do token usa service role (anti-pattern 10).
 */
export async function criarRascunho(
  db: SupabaseClient,
  entrada: EntradaDeCriacao,
): Promise<ResultadoDaCriacao> {
  const texto = entrada.texto.trim();
  if (texto.length < 1 || texto.length > TEXTO_MAXIMO) {
    return { ok: false, motivo: "texto_invalido" };
  }
  const origem = entrada.origem.trim();
  if (origem.length < 1 || origem.length > 64) {
    return { ok: false, motivo: "origem_invalida" };
  }

  const { data: conversa } = await db
    .from("conversations")
    .select("id")
    .eq("organization_id", entrada.organizationId)
    .eq("id", entrada.conversationId)
    .maybeSingle();
  if (!conversa) return { ok: false, motivo: "conversa_nao_encontrada" };

  const horas = entrada.expiraEmHoras ?? JANELA_PADRAO_HORAS;
  const expira = new Date(Date.now() + horas * 3_600_000).toISOString();

  const { data, error } = await db
    .from("conversation_drafts")
    .insert({
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      body: texto,
      source: origem,
      created_by_api_token_id: entrada.apiTokenId ?? null,
      expires_at: expira,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, motivo: "conversa_nao_encontrada" };
  }
  return { ok: true, draftId: data.id as string, url: urlDoRascunho(entrada.conversationId, data.id as string) };
}

interface EntradaDeConsumo {
  organizationId: string;
  conversationId: string;
  draftId: string;
  userId: string | null;
}

/**
 * Marca o rascunho como usado, com quem o usou.
 *
 * Os guardas estão no PRÓPRIO UPDATE (org, conversa, não usado, não vencido):
 * é o que torna a operação idempotente e atômica — dois cliques simultâneos não
 * contam dois usos, e um rascunho vencido não é "consumido" agora para sempre.
 * Devolve `consumido: false` em vez de erro: a mensagem já saiu, e falhar o
 * envio por causa do rascunho seria trocar o problema pelo pior.
 */
export async function consumirRascunho(
  db: SupabaseClient,
  entrada: EntradaDeConsumo,
): Promise<boolean> {
  const { data } = await db
    .from("conversation_drafts")
    .update({
      consumed_at: new Date().toISOString(),
      consumed_by_user_id: entrada.userId,
    })
    .eq("organization_id", entrada.organizationId)
    .eq("conversation_id", entrada.conversationId)
    .eq("id", entrada.draftId)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();

  return !!data;
}

interface EntradaDeLeitura {
  organizationId: string;
  conversationId: string;
  draftId: string;
}

/**
 * Lê o rascunho para a caixa de entrada e decide o que a tela mostra.
 *
 * A ordem dos recusos é a da mensagem que o atendente lê: não encontrado (que
 * é o que um rascunho de OUTRA organização vira, porque o `organization_id`
 * entra na consulta), depois outra conversa, depois usado, depois vencido.
 */
export async function lerRascunho(
  db: SupabaseClient,
  entrada: EntradaDeLeitura,
): Promise<LeituraDoRascunho> {
  // UUID malformado não vai ao banco: a coluna `uuid` devolveria erro de
  // sintaxe, e uma URL digitada à mão não precisa pagar uma consulta para
  // virar "não encontrado".
  if (!ehUuid(entrada.draftId) || !ehUuid(entrada.conversationId)) {
    return { estado: "indisponivel", motivo: "nao_encontrado" };
  }

  const { data } = await db
    .from("conversation_drafts")
    .select("id, conversation_id, body, source, consumed_at, expires_at")
    .eq("organization_id", entrada.organizationId)
    .eq("id", entrada.draftId)
    .maybeSingle();

  if (!data) return { estado: "indisponivel", motivo: "nao_encontrado" };
  if (data.conversation_id !== entrada.conversationId) {
    return { estado: "indisponivel", motivo: "outra_conversa" };
  }
  if (data.consumed_at) return { estado: "indisponivel", motivo: "usado" };
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return { estado: "indisponivel", motivo: "expirado" };
  }

  return {
    estado: "sugerido",
    draftId: data.id as string,
    conversationId: data.conversation_id as string,
    texto: data.body as string,
    origem: data.source as string,
  };
}
