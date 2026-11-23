/**
 * A mensagem que a janela da Meta (Embedded Signup) manda por `postMessage`,
 * lida por uma função PURA — sem DOM, sem toast, sem estado — para poder ser
 * testada em tabela.
 *
 * Eventos de conclusão (doc da Meta, conferida em 21/11/2026):
 * - `FINISH`: fluxo da Cloud API; traz `phone_number_id` e `waba_id`;
 * - `FINISH_ONLY_WABA`: concluiu sem número (só existe na v2, aposentada);
 * - `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`: coexistência (número que já roda no
 *   app WhatsApp Business); o exemplo da doc traz só `waba_id`.
 *
 * `modo` sai do EVENTO, nunca de um campo livre: coexistência só quando a Meta
 * disse `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`.
 */

export type ModoDaConexao = "coexistencia" | "padrao";

export const EVENTO_DE_COEXISTENCIA = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
const EVENTOS_DE_CONCLUSAO = ["FINISH", "FINISH_ONLY_WABA", EVENTO_DE_COEXISTENCIA] as const;

export type LeituraDaMensagem =
  | { tipo: "ignorar" }
  | { tipo: "cancelado" }
  | { tipo: "erro"; mensagem: string }
  | { tipo: "sessao"; modo: ModoDaConexao; waba_id: string; phone_number_id?: string };

export function ehOrigemDaMeta(origem: string): boolean {
  try {
    const host = new URL(origem).hostname;
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

function texto(valor: unknown): string | undefined {
  return typeof valor === "string" && valor.trim() ? valor.trim() : undefined;
}

export function lerMensagemDoEmbeddedSignup(origem: string, dadosBrutos: unknown): LeituraDaMensagem {
  if (!ehOrigemDaMeta(origem)) return { tipo: "ignorar" };
  let dados = dadosBrutos;
  if (typeof dados === "string") {
    try {
      dados = JSON.parse(dados);
    } catch {
      return { tipo: "ignorar" };
    }
  }
  if (!dados || typeof dados !== "object") return { tipo: "ignorar" };
  const msg = dados as { type?: unknown; event?: unknown; data?: Record<string, unknown> | null };
  if (msg.type !== "WA_EMBEDDED_SIGNUP") return { tipo: "ignorar" };

  if (msg.event === "CANCEL") return { tipo: "cancelado" };
  if (msg.event === "ERROR") return { tipo: "erro", mensagem: texto(msg.data?.error_message) ?? "" };

  if (typeof msg.event !== "string" || !(EVENTOS_DE_CONCLUSAO as readonly string[]).includes(msg.event)) {
    return { tipo: "ignorar" };
  }
  const waba_id = texto(msg.data?.waba_id);
  if (!waba_id) return { tipo: "ignorar" };
  const phone_number_id = texto(msg.data?.phone_number_id);
  const modo: ModoDaConexao = msg.event === EVENTO_DE_COEXISTENCIA ? "coexistencia" : "padrao";
  // Sem número só passa a conclusão que a Meta documenta sem ele (coexistência
  // e FINISH_ONLY_WABA); um FINISH sem número é mensagem incompleta.
  if (!phone_number_id && msg.event === "FINISH") return { tipo: "ignorar" };
  return phone_number_id ? { tipo: "sessao", modo, waba_id, phone_number_id } : { tipo: "sessao", modo, waba_id };
}
