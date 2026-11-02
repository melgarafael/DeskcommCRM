/**
 * O METADADO `pagamento` DA MENSAGEM — o que a CONVERSA mostra (issue #3509).
 *
 * ─── Ponteiro, não verdade ──────────────────────────────────────────────────
 *
 * `messages.metadata` é vocabulário aberto por desenho (o comentário da coluna
 * no baseline diz isso): serve para a tela ler o que precisa sem join. O que ele
 * guarda aqui é o suficiente para o balão escrever "R$ 150,00 · pendente" — e
 * nada mais. Quem decide se pagou é `pagamento_recebimentos.status`, e é por isso
 * que este objeto carrega `recebimento_id`: sem a chave, o metadado seria uma
 * segunda cópia da verdade, e a anonimização (que ZERA o metadata, passo 3 da
 * cascata) apagaria o registro do pagamento junto com o texto da conversa.
 *
 * ─── Por que `valor` em CENTAVOS ────────────────────────────────────────────
 *
 * O repo inteiro fala centavos (`lib/money.ts`), e o banco também
 * (`valor_cents bigint`). Guardar "150.00" em texto no metadado criaria uma
 * terceira representação do mesmo número — a que sempre diverge primeiro. A
 * chave se chama `valor` porque é ela que a issue nomeia; a unidade está escrita
 * aqui e no comentário do módulo, e o teste fixa o contrato.
 */
import { formatCents } from "@/lib/money";

import {
  SITUACOES_DO_RECEBIMENTO,
  TAMANHO_MAXIMO_DO_ID_EXTERNO,
  TAMANHO_MAXIMO_DO_LINK,
  type ProvedorDeRecebimento,
  type SituacaoDoRecebimento,
} from "./vocabulario";

/** A chave em `messages.metadata`. Uma só, para não existir a versão "2". */
export const CHAVE_DO_METADADO = "pagamento";

export interface PagamentoNaMensagem {
  /** `infinitepay` hoje. Fica no metadado para o balão não precisar do join. */
  provedor: ProvedorDeRecebimento | string;
  /** O id do pagamento NO PROVEDOR (a mesma chave de `pagamento_recebimentos.external_id`). */
  id: string;
  /** Valor em CENTAVOS. */
  valor: number;
  /** ISO 4217. */
  moeda: string;
  status: SituacaoDoRecebimento;
  /** A linha de `pagamento_recebimentos` — a verdade. */
  recebimento_id: string;
}

export interface EntradaDoMetadado {
  provedor: ProvedorDeRecebimento | string;
  id: string;
  valor: number;
  moeda: string;
  status: SituacaoDoRecebimento;
  recebimento_id: string;
}

/** Monta o objeto EXATO que vai para `metadata.pagamento`. */
export function metadadoDoPagamento(entrada: EntradaDoMetadado): PagamentoNaMensagem {
  return {
    provedor: entrada.provedor,
    id: entrada.id,
    valor: entrada.valor,
    moeda: entrada.moeda,
    status: entrada.status,
    recebimento_id: entrada.recebimento_id,
  };
}

/**
 * Lê `metadata.pagamento` de volta, TOLERANTE.
 *
 * O metadata é escrito por nós, mas já foi escrito por versões anteriores e por
 * clientes (a rota de envio aceita `metadata` do corpo). Um leitor que confia na
 * forma derrubaria a lista de mensagens inteira por causa de uma linha estranha;
 * este devolve `null` e a conversa segue. `null` NÃO é "não pagou": é "esta
 * mensagem não é um link de pagamento registrado".
 */
export function lerPagamentoDoMetadado(metadata: unknown): PagamentoNaMensagem | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bruto = (metadata as Record<string, unknown>)[CHAVE_DO_METADADO];
  if (!bruto || typeof bruto !== "object") return null;
  const p = bruto as Record<string, unknown>;
  const id = texto(p.id);
  const provedor = texto(p.provedor);
  const moeda = texto(p.moeda);
  const recebimentoId = texto(p.recebimento_id);
  const valor = typeof p.valor === "number" && Number.isInteger(p.valor) && p.valor > 0 ? p.valor : null;
  const status = texto(p.status);
  if (!id || !provedor || !moeda || !recebimentoId || valor === null) return null;
  if (!status || !(SITUACOES_DO_RECEBIMENTO as readonly string[]).includes(status)) return null;
  return { provedor, id, valor, moeda, status: status as SituacaoDoRecebimento, recebimento_id: recebimentoId };
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * O link que se aceita registrar.
 *
 * ⚠️ SÓ `https`. Um link de pagamento em `http` é um link que qualquer um no
 * caminho troca, e o cliente paga no lugar errado — a falha mais caro de
 * explicar. Não há lista de domínios aqui de propósito: o adaptador de cada
 * provedor é que sabe o dele, e inventar uma lista agora recusaria o domínio
 * novo do próprio provedor (a issue registra que ele está em transição).
 */
export function linkAceitavel(bruto: string): boolean {
  const url = bruto.trim();
  if (url.length === 0 || url.length > TAMANHO_MAXIMO_DO_LINK) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // Sem credencial embutida (`https://user:senha@host/...`): é truque de
  // phishing clássico — o que o navegador mostra é o host, e o que o cliente lê
  // é a parte antes do `@`.
  if (parsed.username || parsed.password) return false;
  return parsed.hostname.includes(".");
}

/** O id do provedor: sem espaço, sem controle, tamanho limitado. */
export function idExternoAceitavel(bruto: string): boolean {
  const id = bruto.trim();
  if (id.length === 0 || id.length > TAMANHO_MAXIMO_DO_ID_EXTERNO) return false;
  return /^[A-Za-z0-9._:\-]+$/.test(id);
}

/**
 * O link registrado é o link que está NA CONVERSA.
 *
 * Sem esta conferência, a rota de registro viraria um lugar onde o banco guarda
 * um pagamento que ninguém mandou ao cliente — e o aviso de "pago" chegaria para
 * um link que a atendente nunca colou. Comparação pelo corpo NORMALIZADO
 * (espaços colapsados): quem cola do aplicativo traz quebra de linha e espaço
 * sobrando, e recusar por isso seria reprovar o uso normal.
 */
export function mensagemContemOLink(corpo: string | null | undefined, link: string): boolean {
  if (!corpo) return false;
  const alvo = link.trim();
  if (alvo.length === 0) return false;
  return normalizar(corpo).includes(normalizar(alvo));
}

function normalizar(texto: string): string {
  return texto.replace(/\s+/g, " ").trim();
}

/** "R$ 150,00" — a linha que o aviso de pagamento escreve na timeline. */
export function valorEmTexto(cents: number, moeda: string): string {
  return formatCents(cents, moeda);
}
