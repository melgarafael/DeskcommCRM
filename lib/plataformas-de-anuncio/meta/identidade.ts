/**
 * A identidade da Página ou da conta do WhatsApp Business que a Meta COBRA em
 * `user_data` quando a conversão veio de clique-para-WhatsApp (#2098).
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * Com `action_source: "business_messaging"` + `messaging_channel: "whatsapp"`,
 * a Meta recusa o evento sem `page_id` NEM `whatsapp_business_account_id`:
 * HTTP 400, code 100, error_subcode 2804116 — "Falta a identificação da Página
 * ou da conta do WhatsApp Business". Todo Purchase vindo de anúncio
 * clique-para-WhatsApp saía assim: recusado, e no livro-razão só "Invalid
 * parameter", que não diz o que faltava.
 *
 * ─── Por que mora em `organizations.settings.conversions` e não em coluna ──
 *
 * Mesma casa e mesma razão de `report_via_channel`
 * (`lib/conversoes/venda-pelo-canal.ts`): é configuração POR ORGANIZAÇÃO —
 * numa agência que hospeda dois clientes cada um tem a sua Página, e a decisão
 * não é da instalação — e a linha de `ad_platform_connections` não tem onde
 * guardá-la sem migration. `settings` é jsonb e já é lido pela tela de
 * Conversões; acrescentar chave não mexe em schema nenhum.
 *
 * ─── Por que AUSENTE é ausente, e não é preenchido com nada ────────────────
 *
 * Id errado não produz erro diferente: produz recusa OU, pior, evento
 * vinculado a outra conta. O transporte manda SÓ o que está gravado aqui e,
 * quando não há nada, manda sem os dois ids e deixa a recusa ser da Meta —
 * com a mensagem dela no `detail` do envio, que é o que o operador lê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O que a credencial da Meta carrega para o `user_data` de business_messaging. */
export interface IdentidadeDaConversaoMeta {
  /** ID da Página do Facebook ligada ao clique-para-WhatsApp. */
  pageId: string | null;
  /** ID da conta do WhatsApp Business (WABA) ligada ao conjunto de dados. */
  whatsappBusinessAccountId: string | null;
}

export const SEM_IDENTIDADE: IdentidadeDaConversaoMeta = {
  pageId: null,
  whatsappBusinessAccountId: null,
};

/**
 * Id da Meta: só dígitos, com folga para os dois formatos (Página e WABA).
 * Exportada porque a gravação (`definirIdentidadeDaConversao`) confere a MESMA
 * forma: com duas regex, a tela aceitava "1234", dizia "Identidade salva." e a
 * leitura descartava o valor em silêncio.
 */
export const FORMA_DO_ID_META = /^\d{5,64}$/;

/**
 * O que não casar volta `null` — valor torto não vai para o fio, porque uma
 * recusa da Meta por id malformado seria indistinguível da recusa por id faltando.
 */
function idValido(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return FORMA_DO_ID_META.test(limpo) ? limpo : null;
}

/**
 * Lê os dois ids do `settings` da organização. Puro, para o teste poder
 * julgar a regra sem banco: `settings` é o jsonb inteiro (ou `null`).
 */
export function identidadeDaMeta(settings: unknown): IdentidadeDaConversaoMeta {
  if (!settings || typeof settings !== "object") return SEM_IDENTIDADE;
  const conversions = (settings as Record<string, unknown>).conversions;
  if (!conversions || typeof conversions !== "object") return SEM_IDENTIDADE;
  const cfg = conversions as Record<string, unknown>;
  return {
    pageId: idValido(cfg.meta_page_id),
    whatsappBusinessAccountId: idValido(cfg.meta_whatsapp_business_account_id),
  };
}

/**
 * Lê a identidade pela credencial. LANÇA quando a leitura falha — mesmo
 * contrato de `lerVendaPeloCanal`: quem chama (`envio.handler`) espera e tenta
 * de novo. Silenciar a falha aqui mandaria o evento SEM os ids e transformaria
 * um problema de leitura numa recusa da Meta que ninguém associa à origem.
 */
export async function lerIdentidadeDaMeta(
  admin: SupabaseClient,
  organizationId: string,
): Promise<IdentidadeDaConversaoMeta> {
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`leitura da identidade da Meta falhou: ${error.message}`);
  return identidadeDaMeta((data as { settings?: unknown } | null)?.settings);
}
