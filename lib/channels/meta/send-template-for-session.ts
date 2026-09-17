/**
 * Cola entre o handler de mensagens e `sendTemplate`: resolve a linha do espelho e
 * traduz o desfecho em algo que o handler saiba gravar.
 *
 * Fica em `lib/channels/` por causa do invariante 1 da doutrina — carrega nome de
 * provider e a catraca proíbe isso fora daqui. Mas a razão de existir é outra: sem
 * ela, o handler precisaria conhecer `meta_templates`, `bindingState` e o formato do
 * contrato, e viraria o lugar que sabe demais sobre um canal específico.
 *
 * **O bind é reconstruído do próprio espelho.** O chamador manda nome, idioma e
 * valores; o `contract_hash` vem do banco, dos dois lados da comparação. Isso torna a
 * trava por hash um no-op AQUI de propósito: quem precisa dela é a configuração
 * salva (a Fase 4b, quando o follow-up guardar um bind), não um envio pedido agora,
 * com o contrato lido no mesmo instante.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

import { resolveMetaCreds } from "./credentials";
import { sendTemplate } from "./send-template";

export interface SendTemplateForSessionInput {
  beforeSend?: () => Promise<void>;
  organizationId: string;
  /**
   * `channel_sessions.meta_phone_number_id` DESTA conexão — o `sessionRef` do canal
   * oficial. É a segunda metade da chave por que a credencial é resolvida (a primeira
   * é a organização) e o número por que a mensagem sai.
   *
   * Vem do chamador em vez de ser buscado aqui porque é ele quem tem a linha da
   * sessão na mão — e pedir a credencial "da sessão" com o número de OUTRA conexão
   * não casaria linha nenhuma, devolvendo o envio ao ambiente: o defeito que esta
   * fatia fecha, de volta pela porta dos fundos.
   */
  sessionRef: string;
  /** Destinatário em dígitos E.164, já resolvido pelo adapter. */
  to: string;
  name: string;
  language: string;
  values: Record<string, string>;
}

/**
 * Devolve o `external_id` do envio. **Lança** em qualquer desfecho que não seja
 * sucesso — o handler já tem `catch` que grava `failed` com o motivo, e inventar um
 * segundo caminho de erro aqui duplicaria a tradução.
 *
 * As mensagens carregam o motivo real (contrato obsoleto, valor faltando, recusa da
 * plataforma) porque é isso que o operador lê em `error_message`.
 */
export async function sendTemplateForSession(
  db: SupabaseClient,
  input: SendTemplateForSessionInput,
): Promise<string | null> {
  if (!input.name || !input.language) {
    throw new Error("template_incompleto: nome e idioma são obrigatórios em type=template");
  }

  // A credencial vem da SESSÃO (o que o operador salvou na tela de conexão) e o
  // ambiente fica só como RESERVA — a mesma porta que `send`, `checkHealth` e
  // `fetchInboundMedia` já usam. Antes disto este caminho lia
  // `META_PHONE_NUMBER_ID`/`META_SYSTEM_USER_TOKEN` do ambiente e mais nada: numa
  // instalação que conectou o número pela TELA (credencial cifrada no banco, `.env`
  // sem chave) o modelo não sincronizava nem saía, e a recusa não dizia por quê —
  // logo o modelo, que é justamente o que a janela fechada exige.
  //
  // A GUARDA continua ANTES da consulta ao espelho, e a ordem dos desfechos é
  // comportamento neste repo: "canal não conectado" é desfecho da classe `queued`
  // (recuperável). Sem ela, uma instalação sem credencial nenhuma tentaria a Graph
  // com `Bearer` vazio e viraria `failed` com um erro que não nomeia o motivo real —
  // e a mudança de elegibilidade da #674 transformaria uma fila recuperável em
  // falha. Com ela, o desfecho é `queued` com `meta_not_configured`.
  const creds = await resolveMetaCreds(createAdminClient(), {
    organizationId: input.organizationId,
    phoneNumberId: input.sessionRef,
  });
  if (!creds) {
    throw new Error(
      "meta_not_configured: sem credencial para esta sessão (nem na sessão, nem no ambiente).",
    );
  }

  const { data: linha, error } = await db
    .from("meta_templates")
    .select("name, language, status, contract_hash, components")
    .eq("organization_id", input.organizationId)
    .eq("name", input.name)
    .eq("language", input.language)
    .maybeSingle();

  if (error) throw new Error(`template_lookup_failed: ${error.message}`);

  await input.beforeSend?.();
  const resultado = await sendTemplate({
    phoneNumberId: creds.phoneNumberId,
    token: creds.token,
    graphVersion: creds.graphVersion,
    to: input.to,
    binding: {
      name: input.name,
      language: input.language,
      // Ver o cabeçalho: o hash sai do espelho dos dois lados, então `bindingState`
      // aqui checa existência e aprovação, não obsolescência.
      contractHash: linha?.contract_hash ?? "",
      values: input.values,
    },
    current: linha
      ? {
          name: linha.name,
          language: linha.language,
          contractHash: linha.contract_hash,
          status: linha.status,
          components: linha.components,
        }
      : null,
  });

  if (resultado.sent) return resultado.externalId;

  switch (resultado.reason) {
    case "missing":
      throw new Error(`template_missing: ${input.name} (${input.language}) não está no espelho`);
    case "not_approved":
      throw new Error(`template_not_approved: ${input.name} (${input.language})`);
    case "stale":
      throw new Error(`template_stale: ${input.name} mudou na Meta desde a configuração`);
    case "missing_values":
      throw new Error(`template_missing_values: ${resultado.missing.join(", ")}`);
    case "api_error":
      throw new Error(`meta_${resultado.code ?? "erro"}: ${resultado.message}`);
  }
}
