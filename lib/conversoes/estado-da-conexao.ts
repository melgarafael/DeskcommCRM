/**
 * O que a TELA precisa saber — e nada além.
 *
 * ⚠️ O TOKEN NUNCA SAI DAQUI. A leitura devolve apenas SE existe credencial
 * gravada, nunca o valor. É o mesmo contrato da tela do Google (0201): o campo
 * de segredo volta vazio e "vazio" significa "mantenha o que está lá". Devolver
 * o token para pré-preencher o input o colocaria no HTML de uma página que o
 * browser cacheia — e o segredo passaria a viver em disco de cliente.
 *
 * ─── Por que as pendências vêm junto ────────────────────────────────────────
 *
 * Invariante 6 da doutrina: "o que acontece quando falta configuração é
 * VISÍVEL". Uma tela que só mostrasse os campos do formulário responderia
 * "está conectado?" e deixaria a pergunta que importa sem resposta — "então por
 * que minhas vendas não aparecem no gerenciador?". As duas moram na mesma tela
 * porque são a mesma pergunta do ponto de vista de quem paga a mídia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";

export interface EstadoDaConexao {
  conectada: boolean;
  datasetId: string | null;
  temToken: boolean;
  habilitada: boolean;
  testEventCode: string | null;
}

export interface PendenciaDeEnvio {
  leadId: string;
  status: string;
  motivo: string | null;
  detalhe: string | null;
  valorCentavos: number | null;
  tentadoEm: string;
  tituloDoLead: string | null;
}

export async function lerEstadoDaConexao(
  admin: SupabaseClient,
  organizationId: string,
  plataforma: PlataformaDeAnuncio = "meta_ads",
): Promise<EstadoDaConexao> {
  const { data } = await admin
    .from("ad_platform_connections")
    // `access_token_encrypted` NÃO entra no select: o que não é lido não vaza
    // por descuido de quem serializar a resposta depois.
    .select("dataset_id, test_event_code, enabled, access_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("platform", plataforma)
    .maybeSingle();

  const linha = data as {
    dataset_id: string | null;
    test_event_code: string | null;
    enabled: boolean;
    access_token_encrypted: string | null;
  } | null;

  return {
    conectada: Boolean(linha),
    datasetId: linha?.dataset_id ?? null,
    // Booleano derivado, e o valor morre nesta função.
    temToken: Boolean(linha?.access_token_encrypted),
    habilitada: linha?.enabled ?? false,
    testEventCode: linha?.test_event_code ?? null,
  };
}

/**
 * As vendas de anúncio que NÃO foram reportadas, mais recentes primeiro.
 *
 * Só linhas com atribuição chegam ao livro-razão (ver o cabeçalho de
 * `envio.handler.ts`), então tudo que aparece aqui é uma venda que DEVERIA ter
 * ido e não foi. Sem esse filtro na origem, a tela mostraria toda venda orgânica
 * como pendência e ninguém leria a lista duas vezes.
 */
export async function lerPendencias(
  admin: SupabaseClient,
  organizationId: string,
  limite = 20,
): Promise<PendenciaDeEnvio[]> {
  const { data } = await admin
    .from("ad_conversion_dispatches")
    .select("lead_id, status, reason, detail, value_cents, attempted_at, crm_leads(title)")
    .eq("organization_id", organizationId)
    .neq("status", "sent")
    .order("attempted_at", { ascending: false })
    .limit(limite);

  return ((data ?? []) as unknown[]).map((linha) => {
    const l = linha as {
      lead_id: string;
      status: string;
      reason: string | null;
      detail: string | null;
      value_cents: number | null;
      attempted_at: string;
      crm_leads: { title: string | null } | { title: string | null }[] | null;
    };
    const lead = Array.isArray(l.crm_leads) ? l.crm_leads[0] : l.crm_leads;
    return {
      leadId: l.lead_id,
      status: l.status,
      motivo: l.reason,
      detalhe: l.detail,
      valorCentavos: l.value_cents,
      tentadoEm: l.attempted_at,
      tituloDoLead: lead?.title ?? null,
    };
  });
}

/** Quantas vendas foram reportadas com sucesso — o contraponto da lista acima. */
export async function contaEnviadas(
  admin: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { count } = await admin
    .from("ad_conversion_dispatches")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "sent");
  return count ?? 0;
}

/**
 * O texto que o operador lê. O banco guarda slug estável; a tradução mora aqui,
 * para a contagem não depender do idioma de quem salvou — e para cada motivo
 * dizer O QUE FAZER, não só o que houve. "sem_valor" sem a instrução seguinte
 * manda a pessoa procurar um defeito que não existe.
 */
export const MOTIVO_LEGIVEL: Record<string, string> = {
  sem_valor:
    "A venda fechou sem valor preenchido. A plataforma exige valor e moeda em uma compra — preencha o valor do negócio e ele será reportado na próxima passagem.",
  sem_conexao:
    "Nenhuma conta de anúncios conectada nesta organização. Preencha o formulário acima.",
  conexao_desabilitada:
    "A conexão existe mas está desligada. Ligue o envio no formulário acima.",
  credencial_incompleta:
    "Falta o identificador do destino ou o token. Complete o formulário acima.",
  cifra_indisponivel:
    "Esta instalação está sem a chave mestra de criptografia — quem instalou o sistema precisa configurá-la. Reconectar pela tela não resolve.",
  plataforma_sem_transporte:
    "O lead veio de uma plataforma para a qual ainda não sabemos reportar conversão.",
  recusado_pela_plataforma:
    "A plataforma recusou o envio. O detalhe ao lado é a resposta dela.",
};
