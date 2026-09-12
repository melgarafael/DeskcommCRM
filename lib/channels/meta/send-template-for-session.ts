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

import { sendTemplate } from "./send-template";

export interface SendTemplateForSessionInput {
  beforeSend?: () => Promise<void>;
  organizationId: string;
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

  // A credencial de AMBIENTE é o único caminho deste envio, e a guarda vem
  // ANTES da consulta ao espelho de propósito: "canal não conectado" é desfecho
  // da classe `queued` (recuperável), e a ordem dos desfechos é comportamento
  // neste repo. Sem ela, uma instalação que conectou o número pela TELA
  // (credencial cifrada no banco, `.env` sem chave) tentaria a Graph com
  // `Bearer` vazio e viraria `failed` com um erro que não nomeia o motivo real
  // — a mudança de elegibilidade da #674 transformaria uma fila recuperável em
  // falha. Com ela, o desfecho é o mesmo de antes do #674: `queued` com
  // `meta_not_configured`.
  //
  // Enviar template com a credencial da SESSÃO é um passo próprio (o adapter
  // ainda não implementa `sendTemplate`); até lá, este caminho é só do env.
  if (!process.env.META_PHONE_NUMBER_ID || !process.env.META_SYSTEM_USER_TOKEN) {
    throw new Error(
      "meta_not_configured: sem credencial de ambiente para enviar template (a conexão feita pela tela ainda não é usada por este caminho).",
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
    phoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
    token: process.env.META_SYSTEM_USER_TOKEN ?? "",
    graphVersion: process.env.META_GRAPH_VERSION ?? "v22.0",
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
