import "server-only";

import { generateObject } from "ai";
import type { z } from "zod";

import { resolveLanguageModel } from "@/lib/ai/gateway";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { LIMITE_POR_HORA, minutosParaLiberar, type AcaoDaIa } from "./catalogo";

/**
 * A porta única da agência para o modelo (SPEC-ia-da-agencia, I1, I2, I6, I8):
 * chave da INSTALAÇÃO, saída estruturada validada, registro de cada execução e
 * limite por pessoa. Nunca lança: devolve o motivo legível.
 */

export const MODELO_PADRAO_DA_AGENCIA = "anthropic/claude-sonnet-5";

export function modeloDaAgencia(): string {
  return MODELO_PADRAO_DA_AGENCIA;
}

export function iaDisponivel(): boolean {
  return resolveLanguageModel(modeloDaAgencia()) !== null;
}

const SISTEMA = [
  "Você trabalha numa agência de marketing digital brasileira que cuida das redes sociais e dos anúncios de pequenos negócios.",
  "Escreva em português do Brasil, com linguagem simples e direta.",
  "Use só o que está no contexto; quando faltar informação, escreva [preencher] em vez de inventar preço, data, endereço ou número.",
].join(" ");

export type RespostaDaIa<T> = { ok: true; objeto: T } | { ok: false; erro: string };

export async function pedirAIa<T>(p: {
  acao: AcaoDaIa | "propor_mapa";
  userId: string;
  tarefaId?: string | null;
  mapaId?: string | null;
  schema: z.ZodType<T>;
  prompt: string;
}): Promise<RespostaDaIa<T>> {
  const db = createAdminClient();
  const id = modeloDaAgencia();
  const modelo = resolveLanguageModel(id);
  if (!modelo) return { ok: false, erro: "A instalação não tem chave de IA configurada. Peça a quem administra a instalação." };

  const umaHora = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: recentes } = await db.from("agencia_execucoes_ia").select("criado_em").eq("pedido_por", p.userId).gte("criado_em", umaHora).limit(LIMITE_POR_HORA + 1);
  const espera = minutosParaLiberar(((recentes ?? []) as Array<{ criado_em: string }>).map((r) => r.criado_em), new Date());
  if (espera) return { ok: false, erro: `Limite de ${LIMITE_POR_HORA} pedidos à IA por hora. Tente de novo em ${espera} min.` };

  const registro = { tarefa_id: p.tarefaId ?? null, mapa_id: p.mapaId ?? null, acao: p.acao, pedido_por: p.userId, modelo: id };
  try {
    const r = await generateObject({ model: modelo, schema: p.schema, system: SISTEMA, prompt: p.prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(90_000) });
    await db.from("agencia_execucoes_ia").insert({ ...registro, situacao: "ok", tokens_entrada: r.usage?.inputTokens ?? null, tokens_saida: r.usage?.outputTokens ?? null });
    return { ok: true, objeto: r.object as T };
  } catch (e) {
    const detalhe = e instanceof Error ? e.message : String(e);
    logger.warn("agência: pedido à IA falhou", { acao: p.acao, detalhe: detalhe.slice(0, 300) });
    await db.from("agencia_execucoes_ia").insert({ ...registro, situacao: "falhou", erro: detalhe.slice(0, 500) });
    return { ok: false, erro: /schema|parse|validation|No object generated/i.test(detalhe) ? "A IA respondeu fora do formato. Tente de novo." : "A IA não respondeu agora. Tente de novo em instantes." };
  }
}

/** I7: o que a IA pode saber do cliente — nada do cofre, de contrato ou de contato. */
export async function contextoDoCliente(clienteId: string | null): Promise<string> {
  if (!clienteId) return "Cliente: (tarefa interna da agência)";
  const db = createAdminClient();
  const { data } = await db.from("agencia_clientes").select("nome, segmento, cidade, observacoes").eq("id", clienteId).maybeSingle();
  const c = data as { nome: string; segmento: string | null; cidade: string | null; observacoes: string | null } | null;
  if (!c) return "Cliente: (não encontrado)";
  return [`Cliente: ${c.nome}`, c.segmento && `Segmento: ${c.segmento}`, c.cidade && `Cidade: ${c.cidade}`, c.observacoes && `Observações da agência: ${c.observacoes.slice(0, 1500)}`]
    .filter(Boolean)
    .join("\n");
}
