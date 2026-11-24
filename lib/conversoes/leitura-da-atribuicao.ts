/**
 * Ler o clique que identifica a conversão. A etapa Google usa o retrato
 * capturado no nascimento do negócio; as demais conversões usam o primeiro toque do contato.
 *
 * A 0164 (`lib/leads/atribuicao-de-anuncio.ts`) ESTAMPA a atribuição no contato,
 * com guarda de primeiro toque e merge atômico no banco. Este arquivo é o
 * primeiro consumidor dela: até aqui o dado era só de escrita.
 *
 * Não reaproveito o tipo `AtribuicaoDeAnuncio` daquele módulo de propósito. Ele
 * é o formato de ESCRITA e carrega `bruto` — o payload inteiro de onde o dado
 * saiu, que existe para ser prova e pode ter qualquer tamanho. Quem vai enviar
 * precisa de três campos, e arrastar o payload cru para dentro do caminho de
 * envio só criaria chance de ele vazar para um log ou para o fio.
 */
import {
  lerIdentificadoresGoogle,
  type IdentificadoresGoogle,
} from "@/lib/plataformas-de-anuncio/google/identificadores";
import { idDaContaGoogle } from "@/lib/plataformas-de-anuncio/google/metadados-da-campanha";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehPlataformaConhecida } from "@/lib/plataformas-de-anuncio/registry";
import type { PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";

export interface AtribuicaoParaEnvio {
  plataforma: PlataformaDeAnuncio;
  /** `ad_source_id` — o clique que abriu a conversa: `ctwa_clid` ou o `fbclid`/`gclid` do formulário. */
  cliqueDeOrigem: string;
  telefone: string | null;
  /**
   * Presente quando o clique foi capturado na PÁGINA (formulário): a identidade
   * que a plataforma casa é o `fbc`/`fbp` do navegador, e não o `ctwa_clid` da
   * conversa. Vem de `source_metadata` — `ad_click_source: "site"` marca a
   * captura, e as duas chaves são o que o formulário mandou.
   */
  identidadeDoNavegador?: { fbc: string | null; fbp: string | null };
  identificadoresGoogle?: IdentificadoresGoogle;
  /** Customer ID estampado junto com o clique que será enviado. */
  contaGoogleDoClique?: string;
}

export type LeituraDeAtribuicao =
  | { temAtribuicao: true; atribuicao: AtribuicaoParaEnvio }
  | { temAtribuicao: false; motivo: "sem_contato" | "sem_atribuicao" | "plataforma_desconhecida" };

/**
 * ⚠️ FILTRA `organization_id` MESMO TENDO O ID DO CONTATO. O chamador é um
 * worker com client service-role, que bypassa RLS: um `contact_id` de outra
 * organização (por dado corrompido ou por bug de quem monta o evento) leria o
 * telefone e o clique de um terceiro e reportaria a venda na conta de anúncios
 * errada. O mesmo padrão de `encerraDemanda`, e pelo mesmo motivo.
 */
export async function lerAtribuicao(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null,
  negocioDaEtapaGoogle?: { source_metadata?: unknown },
): Promise<LeituraDeAtribuicao> {
  if (!contactId) return { temAtribuicao: false, motivo: "sem_contato" };

  const { data: linha, error } = await admin
    .from("contacts")
    .select(negocioDaEtapaGoogle ? "phone_number" : "phone_number, source_metadata")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle<{ phone_number: string | null; source_metadata?: unknown }>();

  if (error) throw new Error("Não foi possível ler a origem do contato.");
  if (!linha) return { temAtribuicao: false, motivo: "sem_contato" };
  const metadata = negocioDaEtapaGoogle
    ? negocioDaEtapaGoogle.source_metadata
    : linha.source_metadata;
  const meta =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};

  const clique = typeof meta.ad_source_id === "string" ? meta.ad_source_id.trim() : "";
  const telefone = linha.phone_number ? linha.phone_number.replace(/\D/g, "") || null : null;

  const fbc = typeof meta.fbc === "string" && meta.fbc.trim() !== "" ? meta.fbc.trim() : null;
  const fbp = typeof meta.fbp === "string" && meta.fbp.trim() !== "" ? meta.fbp.trim() : null;

  // Quem chegou pela PÁGINA é reportado SEM clique — o `ctwa_clid` é o formato
  // do anúncio clique-pro-WhatsApp e não descreve este lead. Dois casos, um
  // caminho só:
  //
  //  - a origem de site que a `main` já trata (link com UTM da Meta, sem
  //    clique): a pessoa veio de um anúncio que levou à página, e a venda é
  //    reportada pelo telefone;
  //  - o FORMULÁRIO (#2317), marcado com `ad_click_source: "site"` na captura:
  //    o clique veio da landing page, não de uma conversa, e a identidade é o
  //    `fbc`/`fbp` do navegador, que segue junto para o transporte.
  //
  // O `cliqueDeOrigem` vazio é o que troca a identidade no transporte — é ele
  // que faz o evento sair `system_generated` com `fbc`/`fbp` em vez de
  // `business_messaging` com `ctwa_clid`.
  const daPagina =
    meta.ad_click_source === "site" ||
    (!clique && meta.ad_platform === "site" && utmDaMeta(meta.utm_source));
  if (daPagina) {
    return {
      temAtribuicao: true,
      atribuicao: {
        plataforma: "meta_ads",
        cliqueDeOrigem: "",
        telefone,
        ...(fbc || fbp ? { identidadeDoNavegador: { fbc, fbp } } : {}),
      },
    };
  }

  // Sem o clique não há atribuição utilizável: é ele que liga a venda ao anúncio.
  // Ter `ad_platform` sem `ad_source_id` acontece quando o payload trouxe o
  // referral sem o identificador — a 0164 grava os dois como vieram.
  if (!clique) return { temAtribuicao: false, motivo: "sem_atribuicao" };

  // Plataforma que não está no vocabulário significa dado gravado por uma versão
  // futura (ou corrompido). Recusar explicitamente é melhor que assumir a Meta e
  // reportar a venda na conta errada.
  if (!ehPlataformaConhecida(meta.ad_platform)) {
    return { temAtribuicao: false, motivo: "plataforma_desconhecida" };
  }

  const bruto =
    meta.ad_raw && typeof meta.ad_raw === "object" ? (meta.ad_raw as Record<string, unknown>) : {};
  const ids =
    meta.ad_platform === "google_ads"
      ? lerIdentificadoresGoogle(bruto.click_identifiers ?? { gclid: clique })
      : null;
  if (meta.ad_platform === "google_ads" && !ids)
    return { temAtribuicao: false, motivo: "sem_atribuicao" };
  if (negocioDaEtapaGoogle && ids && clique !== (ids.gclid ?? ids.gbraid ?? ids.wbraid))
    return { temAtribuicao: false, motivo: "sem_atribuicao" };
  const conta = ids ? idDaContaGoogle.safeParse(meta.google_customer_id).data : undefined;

  return {
    temAtribuicao: true,
    atribuicao: {
      plataforma: meta.ad_platform,
      ...(ids ? { identificadoresGoogle: ids } : {}),
      ...(conta ? { contaGoogleDoClique: conta } : {}),
      cliqueDeOrigem: clique,
      // Só dígitos: a plataforma exige E.164 sem `+` nem separadores ANTES do
      // hash. Normalizar depois do hash seria tarde — o hash já estaria errado.
      telefone,
    },
  };
}

/** Com uma única conta, o destino pode ser a gerente e o clique vir da conta filha. */
export async function motivoDeContaDaEtapaGoogle(
  admin: SupabaseClient,
  organizationId: string,
  contaDoClique: string | undefined,
  contaDeDestino: string | undefined,
) {
  const destino = idDaContaGoogle.safeParse(contaDeDestino).data;
  if (!destino) return "credencial_incompleta";
  if (contaDoClique === destino) return null;

  // A credencial de conversões já conta como uma conta. Basta uma conta de
  // relatório diferente dela; a PK da tabela é (organization_id, customer_id).
  const { data: outraConta, error } = await admin
    .from("google_ads_reporting_accounts")
    .select("customer_id")
    .eq("organization_id", organizationId)
    .neq("customer_id", destino)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Não foi possível verificar as contas de relatório do Google Ads.");
  if (!outraConta) return null;
  return contaDoClique ? "conta_google_do_clique_divergente" : "conta_google_do_clique_ausente";
}

/**
 * Os `utm_source` que significam "anúncio da Meta". Lista fechada e explícita:
 * quem monta o link escolhe o texto, e casar por "contém face" pegaria
 * `facebook_organico` e mandaria venda orgânica para a conta de anúncios.
 */
export const UTM_SOURCES_DA_META: ReadonlySet<string> = new Set([
  "meta",
  "facebook",
  "fb",
  "instagram",
  "ig",
]);

function utmDaMeta(valor: unknown): boolean {
  return typeof valor === "string" && UTM_SOURCES_DA_META.has(valor.trim().toLowerCase());
}
