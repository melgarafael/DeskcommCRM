/**
 * Histórico de envios de conversão e o diagnóstico da integração (0436).
 *
 * A tela de Conversões mostrava só o que NÃO foi reportado. Quem opera tráfego
 * precisa também do contrário: o que foi entregue, quando, com qual ação e qual
 * protocolo — é assim que se confere, no gerenciador da plataforma, que a venda
 * chegou. As duas leituras moram aqui, sobre o mesmo livro-razão
 * (`ad_conversion_dispatches`), sempre filtradas pela organização da sessão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listarRegrasGoogle, type RegraDeConversaoGoogle } from "./regras-google";

export const PERIODOS = ["hoje", "24h", "7d", "30d", "tudo"] as const;
export type Periodo = (typeof PERIODOS)[number];

/**
 * Os estados como quem opera os lê. O livro-razão tem três `status`
 * (sent/skipped/error); "aguardando" e "não enviado" são o mesmo `skipped`
 * separado pelo motivo — um espera a plataforma, o outro espera a pessoa.
 */
export const SITUACOES = ["todas", "entregue", "falha", "aguardando", "nao_enviado"] as const;
export type Situacao = (typeof SITUACOES)[number];

export const MOTIVOS_AGUARDANDO = [
  "aguardando_processamento",
  "nova_tentativa_agendada",
  "reprocessamento_solicitado",
] as const;

export interface FiltrosDoHistorico {
  periodo: Periodo;
  situacao: Situacao;
  /** `Purchase`, `QualifiedLead`, `Etapa:<uuid>`, `MetaEtapa:<uuid>` ou vazio para todos. */
  evento: string;
  plataforma: "" | "google_ads" | "meta_ads";
  busca: string;
  pagina: number;
}

export const TAMANHO_DA_PAGINA = 50;

export interface LinhaDoHistorico {
  id: string;
  leadId: string;
  tituloDoLead: string | null;
  plataforma: string;
  evento: string;
  status: string;
  motivo: string | null;
  detalhe: string | null;
  eventoId: string | null;
  protocolo: string | null;
  acaoGoogle: string | null;
  valorCentavos: number | null;
  moeda: string | null;
  ocorridoEm: string | null;
  tentadoEm: string;
}

export function situacaoDaLinha(status: string, motivo: string | null): Situacao {
  if (status === "sent") return "entregue";
  if (status === "error") return "falha";
  if (motivo && (MOTIVOS_AGUARDANDO as readonly string[]).includes(motivo)) return "aguardando";
  return "nao_enviado";
}

/** O início do período, ou null para "tudo". */
export function inicioDoPeriodo(periodo: Periodo, agora: Date = new Date()): string | null {
  const h = 60 * 60 * 1000;
  switch (periodo) {
    case "hoje": {
      const d = new Date(agora);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "24h":
      return new Date(agora.getTime() - 24 * h).toISOString();
    case "7d":
      return new Date(agora.getTime() - 7 * 24 * h).toISOString();
    case "30d":
      return new Date(agora.getTime() - 30 * 24 * h).toISOString();
    default:
      return null;
  }
}

/** Lê os filtros da URL, caindo no padrão em qualquer valor desconhecido. */
export function lerFiltros(bruto: Record<string, string | undefined>): FiltrosDoHistorico {
  const um = <T extends string>(lista: readonly T[], v: string | undefined, padrao: T): T =>
    v && (lista as readonly string[]).includes(v) ? (v as T) : padrao;
  const evento = bruto.evento ?? "";
  return {
    periodo: um(PERIODOS, bruto.periodo, "30d"),
    situacao: um(SITUACOES, bruto.situacao, "todas"),
    evento: /^(Purchase|QualifiedLead|(Meta)?Etapa:[0-9a-f-]{36})$/.test(evento) ? evento : "",
    plataforma: um(["", "google_ads", "meta_ads"] as const, bruto.plataforma, ""),
    // Só letras, números, espaço e pontuação comum: vai para um ilike.
    busca: (bruto.busca ?? "")
      .replace(/[^\p{L}\p{N} .@+-]/gu, "")
      .trim()
      .slice(0, 60),
    pagina: Math.max(1, Math.min(1000, Number.parseInt(bruto.pagina ?? "1", 10) || 1)),
  };
}

export async function lerHistorico(
  admin: SupabaseClient,
  organizationId: string,
  filtros: FiltrosDoHistorico,
  agora: Date = new Date(),
): Promise<{ linhas: LinhaDoHistorico[]; total: number }> {
  let q = admin
    .from("ad_conversion_dispatches")
    .select(
      "id, lead_id, platform, event_name, status, reason, detail, event_id, remote_request_id, google_action_id, value_cents, currency, event_occurred_at, attempted_at, crm_leads!inner(title)",
      { count: "exact" },
    )
    .eq("organization_id", organizationId);

  q = q.eq("crm_leads.organization_id", organizationId);

  const inicio = inicioDoPeriodo(filtros.periodo, agora);
  if (inicio) q = q.gte("attempted_at", inicio);
  if (filtros.evento) q = q.eq("event_name", filtros.evento);
  if (filtros.plataforma) q = q.eq("platform", filtros.plataforma);
  if (filtros.busca) q = q.ilike("crm_leads.title", `%${filtros.busca}%`);
  switch (filtros.situacao) {
    case "entregue":
      q = q.eq("status", "sent");
      break;
    case "falha":
      q = q.eq("status", "error");
      break;
    case "aguardando":
      q = q.eq("status", "skipped").in("reason", [...MOTIVOS_AGUARDANDO]);
      break;
    case "nao_enviado":
      q = q.eq("status", "skipped").not("reason", "in", `(${MOTIVOS_AGUARDANDO.join(",")})`);
      break;
  }

  const de = (filtros.pagina - 1) * TAMANHO_DA_PAGINA;
  const { data, count, error } = await q
    .order("attempted_at", { ascending: false })
    .range(de, de + TAMANHO_DA_PAGINA - 1);
  if (error) throw new Error("Não foi possível ler o histórico de envios.");

  const linhas = ((data ?? []) as unknown[]).map((bruto) => {
    const l = bruto as {
      id: string;
      lead_id: string;
      platform: string;
      event_name: string;
      status: string;
      reason: string | null;
      detail: string | null;
      event_id: string | null;
      remote_request_id: string | null;
      google_action_id: string | null;
      value_cents: number | null;
      currency: string | null;
      event_occurred_at: string | null;
      attempted_at: string;
      crm_leads: { title: string | null } | Array<{ title: string | null }> | null;
    };
    const lead = Array.isArray(l.crm_leads) ? l.crm_leads[0] : l.crm_leads;
    return {
      id: l.id,
      leadId: l.lead_id,
      tituloDoLead: lead?.title ?? null,
      plataforma: l.platform,
      evento: l.event_name,
      status: l.status,
      motivo: l.reason,
      detalhe: l.detail,
      eventoId: l.event_id,
      protocolo: l.remote_request_id,
      acaoGoogle: l.google_action_id,
      valorCentavos: l.value_cents,
      moeda: l.currency,
      ocorridoEm: l.event_occurred_at,
      tentadoEm: l.attempted_at,
    };
  });
  return { linhas, total: count ?? linhas.length };
}

/** O nome que a pessoa reconhece para o evento do livro-razão. */
export function rotuloDoEvento(
  evento: string,
  regras: Pick<RegraDeConversaoGoogle, "eventName" | "label">[],
): string {
  if (evento === "Purchase") return "Compra";
  const regra = regras.find((r) => r.eventName === evento);
  if (regra) return regra.label;
  return evento === "QualifiedLead" ? "Lead qualificado" : "Etapa do funil";
}

// ── Diagnóstico ─────────────────────────────────────────────────────────────

export type Saude = "ok" | "atencao" | "problema";

export interface ItemDoDiagnostico {
  chave: "conexao" | "chegando" | "falhas" | "aguardando" | "cobertura";
  saude: Saude;
  titulo: string;
  detalhe: string;
}

const DIA = 24 * 60 * 60 * 1000;

function haQuanto(iso: string, agora: Date): string {
  const dias = Math.floor((agora.getTime() - new Date(iso).getTime()) / DIA);
  if (dias <= 0) return "hoje";
  if (dias === 1) return "há 1 dia";
  return `há ${dias} dias`;
}

/**
 * A saúde da integração com o Google Ads, em cinco perguntas. Cada uma vem com
 * o que fazer quando não está bem — diagnóstico que só acusa não serve.
 */
export async function lerDiagnosticoGoogle(
  admin: SupabaseClient,
  organizationId: string,
  entrada: {
    instalacaoConfigurada: boolean;
    habilitada: boolean;
    temRefreshToken: boolean;
    customerId: string | null;
    temAcaoDeVenda: boolean;
    etapasAbertas: number;
  },
  agora: Date = new Date(),
): Promise<ItemDoDiagnostico[]> {
  const semana = new Date(agora.getTime() - 7 * DIA).toISOString();
  const base = () =>
    admin
      .from("ad_conversion_dispatches")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("platform", "google_ads");

  const [ultimo, falhas, aguardando, regras] = await Promise.all([
    admin
      .from("ad_conversion_dispatches")
      .select("attempted_at")
      .eq("organization_id", organizationId)
      .eq("platform", "google_ads")
      .eq("status", "sent")
      .order("attempted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    base().eq("status", "error").gte("attempted_at", semana),
    base()
      .eq("status", "skipped")
      .in("reason", [...MOTIVOS_AGUARDANDO]),
    listarRegrasGoogle(admin, organizationId).catch(() => null),
  ]);

  const itens: ItemDoDiagnostico[] = [];

  // Banco indisponível não equivale a zero falhas ou integração saudável.
  if (ultimo.error || falhas.error || aguardando.error || regras === null) {
    throw new Error("Não foi possível ler o diagnóstico de conversões.");
  }

  if (!entrada.instalacaoConfigurada) {
    itens.push({
      chave: "conexao",
      saude: "problema",
      titulo: "Instalação sem credenciais do Google Ads",
      detalhe:
        "Quem instalou o sistema precisa configurar GOOGLE_ADS_OAUTH_CLIENT_ID e GOOGLE_ADS_OAUTH_CLIENT_SECRET. Até lá, nada é enviado ao Google.",
    });
  } else if (!entrada.temRefreshToken || !entrada.customerId) {
    itens.push({
      chave: "conexao",
      saude: "problema",
      titulo: "Conta Google não conectada",
      detalhe: "Clique em Conectar com Google e informe o Customer ID da conta de anúncios.",
    });
  } else if (!entrada.habilitada) {
    itens.push({
      chave: "conexao",
      saude: "atencao",
      titulo: "Envio pausado",
      detalhe: "A conta está conectada, mas o envio está desligado na aba Configuração.",
    });
  } else {
    itens.push({
      chave: "conexao",
      saude: "ok",
      titulo: "Conexão ativa",
      detalhe: "A conta está conectada e o envio está ligado.",
    });
  }

  const ultimoEnvio = (ultimo.data as { attempted_at: string } | null)?.attempted_at ?? null;
  itens.push(
    ultimoEnvio
      ? {
          chave: "chegando",
          saude: agora.getTime() - new Date(ultimoEnvio).getTime() > 14 * DIA ? "atencao" : "ok",
          titulo: "Conversões chegando ao Google",
          detalhe: `Última conversão aceita ${haQuanto(ultimoEnvio, agora)}.`,
        }
      : {
          chave: "chegando",
          saude: "atencao",
          titulo: "Nenhuma conversão aceita ainda",
          detalhe:
            "Pode ser falta de negócios vindos de anúncio do Google, ou a captura do clique ainda não configurada no site.",
        },
  );

  const nFalhas = falhas.count ?? 0;
  itens.push({
    chave: "falhas",
    saude: nFalhas > 0 ? "problema" : "ok",
    titulo: nFalhas > 0 ? `${nFalhas} envio(s) recusado(s) em 7 dias` : "Sem falhas recentes",
    detalhe:
      nFalhas > 0
        ? "Abra o histórico filtrando por Falhas: o detalhe de cada linha é a resposta do Google."
        : "Nenhum envio foi recusado nos últimos 7 dias.",
  });

  const nAguardando = aguardando.count ?? 0;
  itens.push({
    chave: "aguardando",
    saude: nAguardando > 0 ? "atencao" : "ok",
    titulo:
      nAguardando > 0 ? `${nAguardando} envio(s) aguardando o Google` : "Nada aguardando o Google",
    detalhe:
      nAguardando > 0
        ? "A confirmação é consultada sozinha. Passadas 24 horas, vira pendência na aba Configuração."
        : "Todos os envios já têm resposta.",
  });

  const ligadas = (regras ?? []).filter((r) => r.enabled).length;
  const cobertas = ligadas + (entrada.temAcaoDeVenda ? 1 : 0);
  const totalDeMomentos = entrada.etapasAbertas + 1;
  itens.push({
    chave: "cobertura",
    saude: cobertas === 0 ? "problema" : entrada.temAcaoDeVenda ? "ok" : "atencao",
    titulo: `${cobertas} de ${totalDeMomentos} momentos do funil com conversão configurada`,
    detalhe: entrada.temAcaoDeVenda
      ? "A venda está configurada. Etapas ligadas dão mais sinal ao Google antes da venda."
      : "A venda (negócio ganho) não tem ação de conversão: é ela que ensina o Google a buscar quem compra.",
  });

  return itens;
}
