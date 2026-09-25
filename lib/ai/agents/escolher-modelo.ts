/**
 * Qual modelo o primeiro agente da organização vai usar.
 *
 * A regra era só uma: o modelo marcado como padrão do provedor
 * (`is_default_for_provider`). Funciona para Anthropic, OpenAI e Google, que o
 * `baseline.sql` semeia marcados — e trava para a OpenRouter, que é a opção
 * **[1]** do menu do instalador.
 *
 * MEDIDO num ambiente real (400 modelos OpenRouter sincronizados, 333 com
 * suporte a ferramentas): NENHUM deles vem marcado como padrão, porque quem
 * traz o catálogo é o cron `sync-model-catalog` e ele não escreve esse campo.
 * Então o wizard dizia "esta instalação ainda não baixou a lista de modelos" —
 * uma frase falsa, já que a lista estava lá — e mandava esperar a atualização
 * diária, que nunca resolveria: no dia seguinte o catálogo continua sem padrão.
 *
 * Quem instalou pela opção que o instalador chama de mais simples ficava com um
 * agente em rascunho para sempre, sem nenhum caminho que funcionasse.
 *
 * A escolha automática é preferível a travar, mas não é silenciosa: quem chama
 * recebe a ORIGEM da escolha para poder dizer na tela qual cérebro foi escolhido
 * e que dá para trocar.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ModeloDoCatalogo {
  model_id: string;
  is_default_for_provider?: boolean | null;
  supports_tools?: boolean | null;
  input_price_per_million_cents?: number | null;
  output_price_per_million_cents?: number | null;
}

export type EscolhaDeModelo =
  | { escolhido: true; modelId: string; origem: "curado" | "automatico" }
  | { escolhido: false; motivo: "catalogo_vazio" | "nenhum_com_ferramentas" };

/**
 * O agente do CRM opera por FERRAMENTAS (criar lead, mover card). Modelo sem
 * tool calling não dá erro: responde um texto plausível e nada chega ao funil —
 * o pior desfecho do produto. Por isso `supports_tools` não é preferência, é
 * requisito, e é a mesma régua que `validarBinding` aplica no painel.
 */
function serve(m: ModeloDoCatalogo): boolean {
  return m.supports_tools === true;
}

/** Soma dos preços conhecidos; ausente conta como caro para ir ao fim da fila. */
function custo(m: ModeloDoCatalogo): number {
  const entrada = m.input_price_per_million_cents;
  const saida = m.output_price_per_million_cents;
  if (typeof entrada !== "number" || typeof saida !== "number") return Number.MAX_SAFE_INTEGER;
  return entrada + saida;
}

/**
 * Preço zero não é "barato": é o degrau gratuito do agregador, com limite de
 * requisições agressivo e disponibilidade que muda sem aviso.
 *
 * MEDIDO percorrendo o wizard: com a regra do menor preço, a escolha caiu em
 * `cohere/north-mini-code:free` — um modelo GRATUITO e de PROGRAMAÇÃO — para
 * atender os pacientes de uma clínica. Era o mais barato do catálogo e a pior
 * escolha possível. Quem contrata alguém não quer o funcionário mais barato do
 * mundo; quer um que dê conta.
 */
function ehGratuito(m: ModeloDoCatalogo): boolean {
  return custo(m) === 0;
}

export function escolherModeloDoProvedor(
  modelos: ReadonlyArray<ModeloDoCatalogo>,
): EscolhaDeModelo {
  if (modelos.length === 0) return { escolhido: false, motivo: "catalogo_vazio" };

  // 1) O curado vence sempre — é uma escolha que alguém fez de propósito, e ela
  //    não deve ser reavaliada por preço.
  const curado = modelos.find((m) => m.is_default_for_provider === true && serve(m));
  if (curado) return { escolhido: true, modelId: curado.model_id, origem: "curado" };

  // 2) Sem curado: o mais barato ENTRE OS QUE SERVEM. Barato é o apelo de quem
  //    escolhe um provedor agregador, e o dono troca depois se quiser — o que
  //    ele não pode é ficar sem funcionário porque ninguém marcou um padrão.
  const candidatos = modelos.filter(serve);
  if (candidatos.length === 0) return { escolhido: false, motivo: "nenhum_com_ferramentas" };

  // Entre os que servem, os PAGOS primeiro. O degrau gratuito só entra se não
  // houver nenhum pago — melhor um modelo com limite do que nenhum funcionário.
  const pagos = candidatos.filter((m) => !ehGratuito(m));
  const fila = pagos.length > 0 ? pagos : candidatos;

  const melhor = [...fila].sort((a, b) => {
    const d = custo(a) - custo(b);
    // Desempate por nome: sem isto, duas execuções com o mesmo catálogo
    // poderiam publicar modelos diferentes, e "por que mudou?" não teria
    // resposta.
    return d !== 0 ? d : a.model_id.localeCompare(b.model_id);
  })[0]!;

  return { escolhido: true, modelId: melhor.model_id, origem: "automatico" };
}

/**
 * A mesma régua, lida do catálogo (`ai_models`) de um provedor.
 *
 * Existe para que quem grava o padrão da organização (o onboarding, o
 * `bootstrap-owner.ts`) e quem o LÊ (`lib/ai/gateway-binding.ts`, quando o par
 * gravado não se sustenta) escolham o mesmo modelo por construção, e não por
 * três cópias da mesma consulta que envelhecem separadas.
 *
 * `null` é "não consegui ler o catálogo" — distinto de catálogo vazio, que é o
 * estado legítimo de uma instalação OpenRouter antes do primeiro sync. Nunca
 * lança: quem chama decide o que fazer sem a resposta.
 */
export async function escolherModeloNoCatalogo(
  admin: SupabaseClient,
  provider: string,
): Promise<EscolhaDeModelo | null> {
  try {
    const { data, error } = await admin
      .from("ai_models")
      .select(
        "model_id, is_default_for_provider, supports_tools, input_price_per_million_cents, output_price_per_million_cents",
      )
      .eq("provider", provider)
      .is("deprecated_at", null);
    if (error) return null;
    return escolherModeloDoProvedor((data ?? []) as ModeloDoCatalogo[]);
  } catch {
    // O `null` já é a informação: todo chamador registra a leitura que falhou.
    return null;
  }
}
