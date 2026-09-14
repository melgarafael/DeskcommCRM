/**
 * Disparo de template pela Cloud API — **a saída do gate `messaging_window`**.
 *
 * Sem isto o gate é parede sem porta: o modelo é vetado, não tem o que fazer, e o
 * turno morre em silêncio — o oposto do invariante 4 do sistema vivo ("nenhuma
 * demanda sem próximo passo"). Vetar é metade do trabalho; a outra metade é oferecer
 * o caminho legítimo.
 *
 * Ordem das checagens, e ela importa:
 *   1. o bind ainda vale? (`bindingState` — hash, aprovação, existência)
 *   2. os valores estão completos? (`missingSlots`)
 *   3. só então monta e envia
 *
 * Nenhuma delas é "tentar e ver": a Meta cobra por mensagem entregue e responde 132000
 * / 132012 depois de aceitar a chamada. Descobrir no erro custa dinheiro e tempo do
 * lead — e é exatamente o estado que esta fase inteira existe para sair.
 */
import { buildComponents, missingSlots, type MetaSendComponent } from "./build-components";
import {
  bindingState,
  type BindingState,
  type CurrentTemplate,
  type TemplateBinding,
} from "./template-binding";
import { deriveTemplateContract } from "./template-contract";

export interface SendTemplateInput {
  phoneNumberId: string;
  token: string;
  graphVersion: string;
  /**
   * Base da API, quando o canal NÃO é a Meta direta. Um parceiro
   * Graph-compatível usa a MESMA Cloud API com outro host/token; sem este campo
   * o envio de modelo sairia pelo `graph.facebook.com` com o token errado.
   * `undefined` = Meta direta (`https://graph.facebook.com/{graphVersion}`).
   */
  graphBase?: string;
  /** Destinatário em dígitos E.164, sem `+` — é o que a Graph API aceita. */
  to: string;
  binding: TemplateBinding;
  /** A linha do espelho local. `null` = template não existe mais na Meta. */
  current: (CurrentTemplate & { components: unknown }) | null;
}

/**
 * `sent` só existe quando a mensagem saiu. Qualquer outro desfecho carrega o MOTIVO —
 * um `false` mudo obrigaria o chamador a adivinhar se reconfigura, se escala ao humano
 * ou se tenta de novo.
 */
export type SendTemplateResult =
  | { sent: true; externalId: string | null }
  // `ok` NUNCA é motivo de falha — excluí-lo torna o switch do tradutor exaustivo
  // por construção, em vez de exigir um `default` que engoliria caso novo em silêncio.
  | { sent: false; reason: Exclude<BindingState, "ok"> }
  | { sent: false; reason: "missing_values"; missing: string[] }
  | { sent: false; reason: "api_error"; code: number | null; message: string };

interface GraphResponse {
  messages?: { id?: string }[];
  error?: { code?: number; message?: string; error_data?: { details?: string } };
}

export async function sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
  // 1) O bind ainda vale? Template editado na Meta desde a configuração manda 2 de 3
  //    parâmetros e falha com 132000 — no disparo, com o lead esperando.
  const estado = bindingState(input.binding, input.current);
  if (estado !== "ok") return { sent: false, reason: estado };

  const contrato = deriveTemplateContract({
    name: input.binding.name,
    language: input.binding.language,
    components: input.current!.components as never,
  });

  // 2) Valores completos? `buildComponents` lança se faltar; perguntar antes deixa a
  //    lista de faltantes acionável em vez de virar uma exceção genérica.
  const faltando = missingSlots(contrato, input.binding.values);
  if (faltando.length > 0) {
    return {
      sent: false,
      reason: "missing_values",
      missing: faltando.map((s) => s.key),
    };
  }

  let components: MetaSendComponent[];
  try {
    components = buildComponents(contrato, input.binding.values);
  } catch (err) {
    // Chegar aqui com `missingSlots` vazio significa defeito NOSSO de derivação, não
    // erro do operador — por isso não vira `missing_values`.
    return {
      sent: false,
      reason: "api_error",
      code: null,
      message: err instanceof Error ? err.message : "build_failed",
    };
  }

  const base = input.graphBase ?? `https://graph.facebook.com/${input.graphVersion}`;
  const url = `${base}/${input.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: input.to,
      type: "template",
      template: {
        name: input.binding.name,
        language: { code: input.binding.language },
        // Template sem parâmetro nenhum NÃO leva `components` — mandar um array
        // vazio é recusado pela Meta.
        ...(components.length > 0 ? { components } : {}),
      },
    }),
  });

  const body = (await res.json().catch(() => ({}))) as GraphResponse;
  if (!res.ok || body.error) {
    return {
      sent: false,
      reason: "api_error",
      code: body.error?.code ?? res.status,
      // O `details` da Meta é o que diz QUAL parâmetro divergiu; sem ele o operador
      // recebe "Parameter format does not match" e nenhuma pista.
      message: body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`,
    };
  }

  return { sent: true, externalId: body.messages?.[0]?.id ?? null };
}
