/**
 * CRIAR CONTATO ABRE CONVERSA? — a regra das DUAS portas, num lugar só (#3718).
 *
 * A pergunta morava em dois arquivos com duas respostas e nenhuma explicação: a
 * criação unitária (`app/api/v1/contacts/_handler.ts`) abria a conversa quando o
 * contato tinha telefone e a organização tinha sessão pronta para envio; a
 * importação por CSV (`app/api/v1/contacts/import/route.ts`) não abria — e nem
 * um nem outro dizia por quê. Quem lesse só a importação podia concluir que era
 * esquecimento, e quem lesse só a criação não sabia que o efeito não valia para
 * o lote.
 *
 * A RESPOSTA, agora única e escrita:
 *
 *   - ficha criada À MÃO abre a conversa (porta `manual`);
 *   - planilha importada NÃO abre, de propósito (porta `importacao_csv`).
 *
 * ─── POR QUE A IMPORTAÇÃO NÃO ABRE: O PREÇO ──────────────────────────────────
 *
 * Um arquivo traz até 500 contatos (`CSV_MAX_DATA_ROWS`, `lib/contacts/csv.ts`).
 * Abrir conversa para todos custaria, POR CONTATO:
 *
 *   1. `sessaoProntaParaEnvio` — de 1 a 2 SELECT em `channel_sessions`;
 *   2. `ensureConversation` → RPC `fn_service_begin` — advisory lock
 *      (`fn_service_lock`), SELECT em `contacts`, SELECT … FOR NO KEY UPDATE em
 *      `conversations`, SELECT em `channel_sessions` e, quando não existe
 *      conversa, o INSERT em `conversations`.
 *
 * São ~2.500 statements no MESMO request que já faz 500 INSERTs e 500
 * `emit_event`. Mas o preço que fica não é o do banco: é a caixa de entrada. O
 * `fn_service_begin` INSERE conversa com `status='open'` quando não há nenhuma,
 * então 500 linhas de planilha virariam 500 conversas abertas, sem ninguém do
 * outro lado e sem ninguém para atendê-las. Importar uma lista de contatos frios
 * não é convidar 500 pessoas para a fila de atendimento.
 *
 * ─── POR QUE A FICHA MANUAL ABRE ─────────────────────────────────────────────
 *
 * Quem digita a ficha está criando UM contato que já quer atender; a conversa
 * aberta é o que deixa o telefone pronto para a primeira mensagem. Um contato,
 * um efeito — o mesmo raciocínio do preço acima, na direção contrária.
 *
 * ─── O QUE MUDOU AQUI ───────────────────────────────────────────────────────
 *
 * 1. A decisão saiu dos dois handlers e mora em `ABRE_CONVERSA`. Mudar a regra
 *    é mudar UMA linha, e as duas portas obedecem: a importação chama
 *    `abrirConversaDoContatoNovo` com `porta: "importacao_csv"` e recebe
 *    `porta_nao_abre` ANTES de qualquer leitura — medido no teste, zero chamadas
 *    ao banco, mesmo na planilha cheia.
 * 2. O `catch` vazio da criação unitária deixou de engolir o erro. A conversa
 *    continua best-effort (o contato já está gravado; a rota não pode falhar por
 *    causa dela), mas a falha agora sai em `logger.warn` com organização,
 *    contato e porta. Antes, sessão torta abria contato sem conversa e o log não
 *    dizia nada — nem que tinha tentado.
 * 3. A sessão é escolhida com `preferirTelefone`: a porta que abre PORQUE "o
 *    contato tem telefone" não pode abrir num canal social, que não alcança
 *    telefone nenhum. Era a continuação do #3358 que o comentário de
 *    `lib/automation/start-conversation.ts` já apontava como pendente no create.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { logger } from "@/lib/logger";

/**
 * As portas que criam contato, e só elas.
 *
 * `manual` é a criação de UMA ficha por vez — o `POST /api/v1/contacts` e a
 * prospecção, que cria o contato e sai conversando com ele na mesma rodada.
 * O MCP não passa por aqui: abre conversa por `openSharedContactConversation`,
 * com a sessão escolhida por quem chama. `importacao_csv` é a planilha, que é o
 * único caminho em que "abrir conversa" acontece centenas de vezes de uma vez.
 */
export type PortaDaCriacao = "manual" | "importacao_csv";

/**
 * A REGRA. Uma linha por porta — mudar o comportamento é mudar aqui, e as duas
 * portas passam a obedecer sem que nenhum handler seja tocado.
 */
const ABRE_CONVERSA: Readonly<Record<PortaDaCriacao, boolean>> = {
  manual: true,
  importacao_csv: false,
};

/** A regra crua, para quem a precisa sem efeito (e para o teste medir). */
export function abreConversaAoCriar(porta: PortaDaCriacao): boolean {
  return ABRE_CONVERSA[porta];
}

export interface ContatoRecemCriado {
  porta: PortaDaCriacao;
  organizationId: string;
  contactId: string;
  /** `contacts.phone_number` como ficou gravado; sem ele a porta não abre. */
  phoneNumber: string | null;
  requestId?: string;
}

/**
 * O que aconteceu, para quem quiser contar (o handler não precisa: a rota não
 * muda de resposta por causa da conversa).
 */
export type DesfechoDaConversa =
  | { aberta: true; conversationId: string }
  | { aberta: false; motivo: "porta_nao_abre" | "sem_telefone" | "sem_sessao" | "falhou" };

function mensagemDoErro(erro: unknown): string {
  // O PostgREST devolve o erro como objeto simples (`{ code, message }`), não
  // como `Error` — `String(erro)` viraria "[object Object]" e o log não diria
  // nada, que é exatamente o defeito que este PR conserta.
  if (erro instanceof Error) return erro.message;
  if (erro && typeof erro === "object") {
    const { message } = erro as { message?: unknown };
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(erro);
}

/**
 * Abre (ou reabre) a conversa de um contato recém-criado — SE a regra da porta
 * mandar e SE houver por onde. Nunca lança: o contato já está gravado, e perder
 * a conversa é um efeito a menos, não um cadastro a menos.
 */
export async function abrirConversaDoContatoNovo(
  supabase: SupabaseClient,
  contato: ContatoRecemCriado,
): Promise<DesfechoDaConversa> {
  // A regra primeiro, e ANTES de qualquer leitura: é o que faz a importação de
  // 500 linhas custar zero consulta por este caminho.
  if (!abreConversaAoCriar(contato.porta)) return { aberta: false, motivo: "porta_nao_abre" };
  if (!contato.phoneNumber) return { aberta: false, motivo: "sem_telefone" };

  try {
    // `preferirTelefone` porque o gatilho desta porta é o telefone: sem a
    // preferência, a sessão mais antiga da organização decide, e numa org que
    // pareou Instagram antes do WhatsApp a conversa nasceria no canal que não
    // alcança o número.
    const sessionId = await sessaoProntaParaEnvio(supabase, contato.organizationId, {
      preferirTelefone: true,
    });
    if (!sessionId) return { aberta: false, motivo: "sem_sessao" };
    const conversationId = await ensureConversation(
      supabase,
      contato.organizationId,
      contato.contactId,
      sessionId,
    );
    return { aberta: true, conversationId };
  } catch (erro) {
    // Sem telefone no contexto: o logger da casa não grava número (LGPD).
    logger.warn("contato criado: a conversa não abriu (o contato já está gravado)", {
      porta: contato.porta,
      organization_id: contato.organizationId,
      contact_id: contato.contactId,
      request_id: contato.requestId,
      detail: mensagemDoErro(erro),
    });
    return { aberta: false, motivo: "falhou" };
  }
}
