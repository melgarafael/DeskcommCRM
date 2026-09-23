/**
 * A configuração da landing page de captura — para qual WhatsApp e com qual
 * texto pré-preenchido ela redireciona, por organização.
 *
 * Mora um degrau acima de `google/` e de `meta/` porque a PERGUNTA é a mesma
 * nos dois: "para onde esta organização manda quem clicou, e com que texto".
 * As tabelas são duas (uma por eixo de captura) pelo mesmo motivo do cabeçalho
 * da migration 0306 — cada eixo nasce e funciona sozinho, sem depender de a
 * organização ter conectado credencial nenhuma na API da plataforma.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Lista fechada: o nome da tabela chega aqui como texto, e o tipo é o que
 * impede uma chamada nova de ler uma tabela que não tem estas três colunas.
 */
export type TabelaDeLanding = "google_ads_landing_pages" | "meta_ads_landing_pages";

export interface ConfigDaLanding {
  whatsappE164: string;
  messageTemplate: string;
}

/** `null` tanto para "nunca configurou" quanto para "desligou" — a landing page trata os dois igual: não redireciona. */
export async function lerConfigDaLanding(
  admin: SupabaseClient,
  tabela: TabelaDeLanding,
  organizationId: string,
): Promise<ConfigDaLanding | null> {
  const { data, error } = await admin
    .from(tabela)
    .select("whatsapp_e164, message_template, enabled")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    logger.error("[plataformas-de-anuncio.landing-config] leitura falhou", {
      tabela,
      organizationId,
      detalhe: error.message,
    });
    return null;
  }
  if (!data) return null;

  const linha = data as { whatsapp_e164: string; message_template: string; enabled: boolean };
  if (!linha.enabled) return null;

  return { whatsappE164: linha.whatsapp_e164, messageTemplate: linha.message_template };
}

/** A configuração como a TELA precisa dela: inclusive quando está desligada. */
export interface EstadoDaCaptura extends ConfigDaLanding {
  habilitada: boolean;
}

/**
 * Irmã de `lerConfigDaLanding`, e separada dela de propósito: a rota pública
 * trata "desligada" como "não existe" (não redireciona), enquanto a tela
 * precisa MOSTRAR o que está gravado para poder religar. Uma função só, com
 * bandeira, faria o caminho do clique carregar a necessidade da tela.
 */
export async function lerEstadoDaCaptura(
  admin: SupabaseClient,
  tabela: TabelaDeLanding,
  organizationId: string,
): Promise<EstadoDaCaptura | null> {
  const { data, error } = await admin
    .from(tabela)
    .select("whatsapp_e164, message_template, enabled")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    logger.error("[plataformas-de-anuncio.landing-config] leitura para a tela falhou", {
      tabela,
      organizationId,
      detalhe: error.message,
    });
    return null;
  }
  if (!data) return null;

  const linha = data as { whatsapp_e164: string; message_template: string; enabled: boolean };
  return {
    whatsappE164: linha.whatsapp_e164,
    messageTemplate: linha.message_template,
    habilitada: linha.enabled,
  };
}
