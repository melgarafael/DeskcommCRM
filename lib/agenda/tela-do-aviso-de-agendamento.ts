/**
 * O ESTADO da tela "Agenda › Avisos no WhatsApp" — o que o GET e o PUT de
 * `/api/v1/agenda/aviso` devolvem.
 *
 * ## Por que o aviso de caso aparece aqui
 *
 * O padrão da configuração é "usar o mesmo número do aviso de caso". Para a
 * pessoa saber o que isso significa ANTES de ligar, a tela precisa mostrar
 * qual número e qual conexão são esses — mascarado, porque ela não está
 * editando aquele número aqui. Quando o aviso de caso não está configurado, a
 * tela diz isso e oferece o número próprio.
 *
 * ## Leitura pelo client de SESSÃO
 *
 * As duas configurações têm RLS `admin`, e o histórico `manager`. A rota já
 * exigiu `admin`; ler pela sessão mantém a RLS como segunda cerca.
 *
 * Nenhuma leitura lança: falhar a tela inteira por um histórico que não veio
 * deixaria a pessoa sem conseguir desligar o aviso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listSelectableChannels } from "@/lib/channels/selectable";
import { mascara } from "@/lib/escalacao/aviso-ao-suporte";
import { logger } from "@/lib/logger";

/** Quantas entregas a lista mostra — responde "está saindo?" sem paginar. */
const ENTREGAS_NA_LISTA = 20;

export interface ConexaoDoAvisoDeAgendamento {
  id: string;
  nome: string;
  /** `WORKING` é o único que envia agora. */
  status: string;
  /** Capacidade, nunca provedor (`lib/channels/selectable.ts`). */
  aceitaMensagemLivre: boolean;
}

export interface ConfigDoAvisoDeAgendamentoNaTela {
  usa_numero_do_aviso_de_caso: boolean;
  channel_session_id: string | null;
  /** O número inteiro: é o campo que a pessoa está editando. */
  telefone: string | null;
  ligado: boolean;
  atualizado_em: string;
}

export interface AvisoDeCasoNaTela {
  /** Os quatro últimos dígitos — este número não é editado aqui. */
  destino_mascarado: string;
  channel_session_id: string | null;
}

export interface EntregaDeAgendamentoNaTela {
  id: string;
  tipo: string;
  evento: string | null;
  dia: string | null;
  destino_mascarado: string;
  status: string;
  erro_codigo: string | null;
  enviado_em: string | null;
  created_at: string;
}

export interface EstadoDaTelaDoAvisoDeAgendamento {
  config: ConfigDoAvisoDeAgendamentoNaTela | null;
  aviso_de_caso: AvisoDeCasoNaTela | null;
  conexoes: ConexaoDoAvisoDeAgendamento[];
  entregas: EntregaDeAgendamentoNaTela[];
  /** `organizations.timezone` — o relógio do resumo das 7h. */
  fuso: string;
}

export async function lerEstadoDaTelaDoAvisoDeAgendamento(
  db: SupabaseClient,
  organizationId: string,
): Promise<EstadoDaTelaDoAvisoDeAgendamento> {
  const [config, avisoDeCaso, conexoes, entregas, fuso] = await Promise.all([
    lerConfig(db, organizationId),
    lerAvisoDeCaso(db, organizationId),
    lerConexoes(db, organizationId),
    lerEntregas(db, organizationId),
    lerFuso(db, organizationId),
  ]);
  return { config, aviso_de_caso: avisoDeCaso, conexoes, entregas, fuso };
}

async function lerConfig(db: SupabaseClient, orgId: string): Promise<ConfigDoAvisoDeAgendamentoNaTela | null> {
  const { data, error } = await db
    .from("config_aviso_de_agendamento")
    .select("usa_numero_do_aviso_de_caso, channel_session_id, telefone_destino, ligado, updated_at")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) {
    logger.warn("[aviso-de-agendamento] configuração não lida", { organizationId: orgId, causa: error.message });
    return null;
  }
  const linha = data as {
    usa_numero_do_aviso_de_caso: boolean;
    channel_session_id: string | null;
    telefone_destino: string | null;
    ligado: boolean;
    updated_at: string;
  } | null;
  if (!linha) return null;
  return {
    usa_numero_do_aviso_de_caso: linha.usa_numero_do_aviso_de_caso,
    channel_session_id: linha.channel_session_id,
    telefone: linha.telefone_destino,
    ligado: linha.ligado,
    atualizado_em: linha.updated_at,
  };
}

async function lerAvisoDeCaso(db: SupabaseClient, orgId: string): Promise<AvisoDeCasoNaTela | null> {
  const { data, error } = await db
    .from("config_aviso_de_caso")
    .select("telefone_destino, channel_session_id")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) {
    logger.warn("[aviso-de-agendamento] aviso de caso não lido", { organizationId: orgId, causa: error.message });
    return null;
  }
  const linha = data as { telefone_destino: string | null; channel_session_id: string | null } | null;
  if (!linha?.telefone_destino) return null;
  return { destino_mascarado: mascara(linha.telefone_destino), channel_session_id: linha.channel_session_id };
}

async function lerConexoes(db: SupabaseClient, orgId: string): Promise<ConexaoDoAvisoDeAgendamento[]> {
  try {
    const canais = await listSelectableChannels(db, orgId);
    return canais.map((c) => ({
      id: c.id,
      nome: c.display_name,
      status: c.status,
      aceitaMensagemLivre: c.aceitaMensagemLivre,
    }));
  } catch (err) {
    logger.warn("[aviso-de-agendamento] conexões não lidas", {
      organizationId: orgId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function lerEntregas(db: SupabaseClient, orgId: string): Promise<EntregaDeAgendamentoNaTela[]> {
  const { data, error } = await db
    .from("entregas_de_aviso_de_agendamento")
    .select("id, tipo, evento, dia, destino, status, erro_codigo, enviado_em, created_at")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(ENTREGAS_NA_LISTA);
  if (error) {
    logger.warn("[aviso-de-agendamento] histórico não lido", { organizationId: orgId, causa: error.message });
    return [];
  }
  return ((data ?? []) as Array<Omit<EntregaDeAgendamentoNaTela, "destino_mascarado"> & { destino: string | null }>).map(
    ({ destino, ...resto }) => ({ ...resto, destino_mascarado: destino ? mascara(destino) : "" }),
  );
}

async function lerFuso(db: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await db.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  return (data as { timezone?: string | null } | null)?.timezone || "America/Sao_Paulo";
}
