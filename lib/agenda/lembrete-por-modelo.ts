import type { SupabaseClient } from "@supabase/supabase-js";

import { slotKey } from "@/lib/channels/meta/build-components";
import { renderTemplateBody } from "@/lib/channels/meta/render-template";
import { isStatusSendable } from "@/lib/channels/meta/template-binding";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import { valorParaParametro } from "@/lib/channels/meta/variaveis-do-fluxo";

/**
 * O LEMBRETE POR MODELO APROVADO — quando a janela de 24 h do cliente fechou.
 *
 * O lembrete da agenda sai como texto livre. Num número que só aceita texto
 * livre de quem escreveu nas últimas 24 h (o oficial, direto ou por parceiro),
 * a reserva feita dias antes cai fora da janela e o cron PULA o lembrete
 * (#2595): o cliente não é avisado. Com `calendar_event_types.
 * reminder_meta_template_id`, o lembrete sai pelo modelo aprovado DAQUELE
 * número.
 *
 * O que o lembrete sabe preencher é o que ele tem: as variáveis do CORPO,
 * posicionais e de texto, recebem nesta ordem o primeiro nome do contato, o dia
 * e a hora, o título do compromisso e o endereço. Qualquer outra coisa (mais de
 * quatro variáveis, buraco na numeração, variável nomeada, mídia no cabeçalho,
 * sufixo de link no botão) não tem de onde sair — e o modelo não é usado, nem
 * oferecido na tela: a plataforma recusaria o envio de qualquer jeito.
 *
 * A leitura do contrato é a MESMA do envio (`deriveTemplateContract`): a regra de
 * "o que é variável" não pode ter uma versão aqui e outra no pré-voo do
 * `sendMessageHandler`, senão a tela oferece o que o envio depois recusa.
 */
export const ORDEM_DAS_VARIAVEIS_DO_LEMBRETE = ["primeiro_nome", "quando", "titulo", "endereco"] as const;

/** A linha de `meta_templates` que o lembrete lê. */
export interface ModeloDoLembrete {
  id: string;
  name: string;
  language: string;
  status: string;
  channel_session_id: string | null;
  parameter_format: string | null;
  components: unknown;
}

function temCorpo(components: unknown): boolean {
  return (
    Array.isArray(components) &&
    components.some(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        String((c as { type?: unknown }).type).toUpperCase() === "BODY" &&
        typeof (c as { text?: unknown }).text === "string" &&
        ((c as { text: string }).text.trim().length > 0),
    )
  );
}

/**
 * Quantas variáveis o lembrete preenche neste modelo — ou `null` quando ele não
 * consegue preencher alguma (ou quando não há corpo de texto).
 */
export function variaveisQueOLembretePreenche(
  modelo: Pick<ModeloDoLembrete, "name" | "language" | "parameter_format" | "components">,
): number | null {
  // Sem corpo de texto não há lembrete a mandar — e o texto que fica na conversa
  // sairia vazio.
  if (!temCorpo(modelo.components)) return null;
  const contrato = deriveTemplateContract({
    name: modelo.name,
    language: modelo.language,
    ...(modelo.parameter_format ? { parameter_format: modelo.parameter_format } : {}),
    components: modelo.components as never,
  });
  if (contrato.slots.length === 0) return 0;
  // Nomeada (`{{nome_do_cliente}}`) exige o nome do parâmetro no envio, e o
  // lembrete só sabe a ORDEM das peças.
  if (contrato.parameterFormat !== "POSITIONAL") return null;
  const numeros = new Set<number>();
  for (const slot of contrato.slots) {
    if (slot.address.kind !== "body" || slot.expects !== "text") return null;
    const n = Number(slot.key);
    if (!Number.isInteger(n) || n < 1) return null;
    numeros.add(n);
  }
  const ordenados = [...numeros].sort((a, b) => a - b);
  if (ordenados.length > ORDEM_DAS_VARIAVEIS_DO_LEMBRETE.length) return null;
  if (ordenados.some((n, i) => n !== i + 1)) return null;
  return ordenados.length;
}

/** O modelo pode ser escolhido para o lembrete: aprovado e preenchível. */
export function modeloServeAoLembrete(modelo: ModeloDoLembrete): boolean {
  return isStatusSendable(modelo.status) && variaveisQueOLembretePreenche(modelo) !== null;
}

/**
 * Os valores do modelo e o texto como ele chega ao cliente (é o que fica na
 * conversa para quem atende e para o agente). `null` quando uma peça que o
 * modelo pede está vazia — a plataforma recusa parâmetro vazio. O primeiro nome
 * vazio já chega aqui com o substituto.
 */
export function valoresDoModeloDoLembrete(
  modelo: Pick<ModeloDoLembrete, "name" | "language" | "parameter_format" | "components">,
  pecas: Record<string, string>,
): { valores: Record<string, string>; texto: string } | null {
  const quantas = variaveisQueOLembretePreenche(modelo);
  if (quantas === null) return null;
  const valores: Record<string, string> = {};
  for (let n = 1; n <= quantas; n += 1) {
    // A mesma limpeza das campanhas e dos fluxos: o título e o endereço vêm de
    // formulário e podem ter quebra de linha, que a plataforma recusa.
    const valor = valorParaParametro(pecas[ORDEM_DAS_VARIAVEIS_DO_LEMBRETE[n - 1]!] ?? "");
    if (!valor) return null;
    valores[slotKey({ kind: "body" }, String(n))] = valor;
  }
  const texto = renderTemplateBody(modelo.components, valores, {
    name: modelo.name,
    language: modelo.language,
    ...(modelo.parameter_format ? { parameterFormat: modelo.parameter_format } : {}),
  });
  return { valores, texto };
}

const COLUNAS = "id, name, language, status, channel_session_id, parameter_format, components";

/**
 * O modelo configurado no tipo, só se for DESTA organização, DESTE número,
 * aprovado e preenchível. Qualquer outra coisa é `null`: um modelo de outro
 * número sairia pelo número errado, e um não aprovado a plataforma recusa.
 */
export async function lerModeloDoLembrete(
  admin: SupabaseClient,
  org: string,
  modeloId: string,
  canalId: string,
): Promise<ModeloDoLembrete | null> {
  const { data, error } = await admin
    .from("meta_templates")
    .select(COLUNAS)
    .eq("organization_id", org)
    .eq("id", modeloId)
    .maybeSingle();
  if (error || !data) return null;
  const modelo = data as ModeloDoLembrete;
  if (modelo.channel_session_id !== canalId) return null;
  return modeloServeAoLembrete(modelo) ? modelo : null;
}

/** Os modelos que a tela oferece ao lembrete, com o número dono de cada um. */
export async function modelosQueOLembreteEnvia(
  db: SupabaseClient,
  org: string,
): Promise<ModeloDoLembrete[]> {
  const { data, error } = await db
    .from("meta_templates")
    .select(COLUNAS)
    .eq("organization_id", org)
    .order("name");
  if (error) throw new Error(error.message);
  return ((data ?? []) as ModeloDoLembrete[]).filter(
    (m) => m.channel_session_id !== null && modeloServeAoLembrete(m),
  );
}
