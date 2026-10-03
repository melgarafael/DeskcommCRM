/**
 * O valor da venda lido da CONVERSA — para a compra vinda de anúncio da Meta
 * não parar em `sem_valor` só porque ninguém preencheu o valor do negócio.
 *
 * ─── Por que é automático, e por que é estreito ─────────────────────────────
 *
 * Quem opera pediu que a venda saísse para a Meta sem passo humano. O preço de
 * errar, porém, é alto e irreversível: evento enviado não se apaga, e um valor
 * dez vezes maior ensina ao otimizador a perseguir o público errado. Por isso a
 * leitura só vale quando o valor está DITO na conversa, e três guardas cercam o
 * modelo em vez de confiar nele:
 *
 *  1. o modelo devolve o TRECHO de onde tirou o valor, copiado da conversa;
 *  2. o trecho precisa existir literalmente na transcrição (alucinação cai aqui);
 *  3. o trecho precisa dizer o valor como quantia ("R$ 1.497,00" é 1497, e
 *     nunca 14970 — comparar só os dígitos deixaria passar o décuplo).
 *
 * Qualquer guarda que falhe devolve `ok: false` com o motivo, e a venda segue
 * como pendência `sem_valor` na tela de Conversões — visível, nunca chutada.
 *
 * ─── Nunca lança ────────────────────────────────────────────────────────────
 *
 * Roda dentro do handler de conversão, no dreno de eventos. Orçamento de IA
 * esgotado, provedor fora ou chave ausente não podem derrubar o handler: viram
 * o motivo da pendência, que é onde quem opera vai procurar.
 *
 * O texto da conversa NUNCA sai daqui para a plataforma de anúncio: só o valor
 * e a moeda seguem adiante. O nome do produto, texto livre do modelo, fica no
 * Histórico — numa clínica ele é dado de saúde, e não vai à Meta ao lado do
 * telefone em hash.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { runModelCall, tool, type ModelMessage } from "@/lib/agent-engine/edge/llm/run-model-call";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { env } from "@/lib/env";
import { montarTranscricao } from "@/lib/propostas/preencher-com-conversa";

/** O suficiente para cobrir negociação e fechamento sem pagar por meses de histórico. */
const LIMITE_DE_MENSAGENS = 80;

/** Teto de sanidade: acima disto é quase certamente número de pedido, CPF ou telefone. */
const VALOR_MAXIMO = 10_000_000;

export type LeituraDoValor =
  | {
      ok: true;
      valorCentavos: number;
      moeda: string;
      produto: string | null;
      /** O trecho da conversa de onde o valor saiu — vai para o Histórico, não para a Meta. */
      trecho: string;
    }
  | { ok: false; motivo: string };

const respostaShape = z.object({
  houve_valor: z
    .boolean()
    .describe("true só se a conversa diz EXPLICITAMENTE o valor final que o cliente comprou ou pagou."),
  valor: z
    .number()
    .nullable()
    .describe("O valor final na unidade da moeda (ex.: 497.9 para R$ 497,90). null se não houver."),
  moeda: z.string().nullable().describe("Código ISO-4217 (BRL, USD, EUR). null se não der para saber."),
  produto: z.string().nullable().describe("Nome curto do que foi comprado, como aparece na conversa."),
  trecho: z
    .string()
    .nullable()
    .describe("A frase da conversa onde o valor final aparece, copiada EXATAMENTE como está."),
});

const SISTEMA =
  "Você lê uma conversa de vendas pelo WhatsApp e informa o valor da venda fechada, chamando a ferramenta " +
  "informar_venda. Regras: (1) só informe valor que a conversa DIZ explicitamente — nunca some, multiplique, " +
  "calcule parcelas ou deduza; (2) se houve desconto ou negociação, o valor é o ÚLTIMO combinado; (3) se " +
  "foram oferecidas várias opções e não está claro qual o cliente comprou, houve_valor=false; (4) o trecho " +
  "deve ser copiado literalmente da conversa e conter o número do valor; (5) na dúvida, houve_valor=false — " +
  "um valor errado é pior que nenhum.";

/** Compara textos ignorando caixa e espaços repetidos — o modelo às vezes normaliza espaço. */
function normaliza(texto: string): string {
  return texto.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Os valores em dinheiro que um trecho pode estar dizendo.
 *
 * Comparar DÍGITOS não basta: "R$ 1.497,00" tem os dígitos 149700, que contêm
 * 14970 — um valor dez vezes maior passaria. Cada número é lido como quantia:
 * o último separador seguido de 1 ou 2 dígitos é decimal ("497,90", "1,497.00");
 * seguido de exatamente 3 é ambíguo ("1.497" é mil e quatrocentos ou 1,497) e
 * vale pelas duas leituras.
 */
function valoresDoTrecho(trecho: string): number[] {
  const valores: number[] = [];
  for (const numero of trecho.match(/\d[\d.,]*\d|\d/g) ?? []) {
    const ultimo = Math.max(numero.lastIndexOf(","), numero.lastIndexOf("."));
    if (ultimo < 0) {
      valores.push(Number(numero));
      continue;
    }
    const inteiro = numero.slice(0, ultimo).replace(/[.,]/g, "");
    const fracao = numero.slice(ultimo + 1);
    valores.push(Number(`${inteiro}.${fracao}`));
    if (fracao.length === 3) valores.push(Number(`${inteiro}${fracao}`));
  }
  return valores.filter(Number.isFinite);
}

/**
 * A guarda de alucinação, exportada para o teste vigiar sem modelo: o trecho
 * existe na conversa e diz, como quantia, exatamente o valor devolvido.
 */
export function trechoSustentaOValor(trecho: string, transcricao: string, valor: number): boolean {
  const t = normaliza(trecho);
  if (t.length < 3 || !normaliza(transcricao).includes(t)) return false;
  return valoresDoTrecho(trecho).some((v) => Math.abs(v - valor) < 0.005);
}

export interface DependenciasDaLeitura {
  /** Substitui a chamada de modelo no teste. Default: o seam `runModelCall`. */
  chamarModelo?: (transcricao: string, organizationId: string) => Promise<unknown>;
}

async function chamarModeloPadrao(transcricao: string, organizationId: string): Promise<unknown> {
  const messages: ModelMessage[] = [{ role: "user", content: `Conversa com o cliente:\n${transcricao}` }];
  const { result } = await runModelCall(getSkillsPool(), llmEdgeConfigFromEnv(env), {
    tenantId: organizationId,
    purpose: "conversion_value_from_conversation",
    system: SISTEMA,
    messages,
    tools: {
      informar_venda: tool({ inputSchema: respostaShape, execute: async (args) => args }),
    },
  });
  return result.toolCalls?.find((c) => c.toolName === "informar_venda")?.input ?? null;
}

/**
 * ⚠️ `organization_id` no filtro mesmo com o id do contato: o client é
 * service-role e bypassa RLS — a mesma regra de `leitura-da-atribuicao.ts`.
 */
export async function lerValorDaConversa(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null,
  moedaPadrao: string,
  deps: DependenciasDaLeitura = {},
): Promise<LeituraDoValor> {
  if (!contactId) return { ok: false, motivo: "Lead sem contato: não há conversa para ler o valor." };

  try {
    const { data, error } = await admin
      .from("messages")
      .select("direction, body, media_derived_text")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .in("direction", ["inbound", "outbound"])
      .order("created_at", { ascending: false })
      .limit(LIMITE_DE_MENSAGENS);
    if (error) return { ok: false, motivo: "Não foi possível ler a conversa para achar o valor." };

    const linhas = ((data ?? []) as Array<{
      direction: string;
      body: string | null;
      media_derived_text: string | null;
    }>)
      .slice()
      .reverse()
      // Áudio transcrito conta: "fechado, 497 no pix" muitas vezes chega falado.
      .map((m) => ({ direction: m.direction, body: m.body ?? m.media_derived_text }));
    const transcricao = montarTranscricao(linhas);
    if (!transcricao) return { ok: false, motivo: "A conversa não tem texto para ler o valor." };

    const bruto = await (deps.chamarModelo ?? chamarModeloPadrao)(transcricao, organizationId);
    const parsed = respostaShape.safeParse(bruto);
    if (!parsed.success || !parsed.data.houve_valor) {
      return { ok: false, motivo: "A IA não encontrou o valor da venda dito na conversa." };
    }

    const { valor, trecho } = parsed.data;
    if (valor === null || !Number.isFinite(valor) || valor <= 0 || valor > VALOR_MAXIMO) {
      return { ok: false, motivo: "A IA não encontrou um valor de venda válido na conversa." };
    }
    if (!trecho || !trechoSustentaOValor(trecho, transcricao, valor)) {
      return {
        ok: false,
        motivo: "O valor que a IA leu não aparece escrito na conversa; nada foi enviado para não arriscar um valor errado.",
      };
    }

    const moeda = (parsed.data.moeda ?? "").trim().toUpperCase();
    const produto = (parsed.data.produto ?? "").trim().slice(0, 100);
    return {
      ok: true,
      valorCentavos: Math.round(valor * 100),
      moeda: /^[A-Z]{3}$/.test(moeda) ? moeda : moedaPadrao,
      produto: produto || null,
      trecho: trecho.replace(/\s+/g, " ").trim().slice(0, 160),
    };
  } catch (err) {
    // Orçamento esgotado, provedor fora, IA não configurada: tudo vira o motivo
    // da pendência. Só a mensagem do erro — nunca a conversa.
    const detalhe = err instanceof Error ? err.message : String(err);
    return { ok: false, motivo: `A IA não conseguiu ler o valor: ${detalhe.slice(0, 160)}` };
  }
}
