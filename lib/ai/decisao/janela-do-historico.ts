import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_CLASSIFIER_CONTEXT_MESSAGES, quantidadeDeHistoricoSalva } from '@/lib/ai/classifier-context';

/** Compatibilidade do clima sem quantidade aplicável; não muda o default antigo do roteador. */
export const HISTORICO_PADRAO_DO_CLIMA = MAX_CLASSIFIER_CONTEXT_MESSAGES;
export interface JanelaDoHistorico {
  quantidade: number;
  origem: 'roteador' | 'padrao_clima';
  motivo: 'configurado' | 'sem_canal' | 'sem_roteador' | 'config_ausente_ou_invalida' | 'leitura_indisponivel' | 'vinculo_ambiguo';
}

/** Mesma chave/normalização do loader nativo do roteador; vínculo é empresa + canal da conversa persistida. */
export async function resolverJanelaDoClima(admin: SupabaseClient, input: {
  organizationId: string; channelSessionId: string | null;
}): Promise<JanelaDoHistorico> {
  const padrao = (motivo: JanelaDoHistorico['motivo']): JanelaDoHistorico => ({ quantidade: HISTORICO_PADRAO_DO_CLIMA, origem: 'padrao_clima', motivo });
  if (!input.channelSessionId) return padrao('sem_canal');
  try {
    const { data, error } = await admin.from('ai_routers').select('id,config')
      .eq('organization_id', input.organizationId).eq('channel_session_id', input.channelSessionId)
      .eq('is_active', true).limit(2);
    if (error || !Array.isArray(data)) return padrao('leitura_indisponivel');
    if (!data.length) return padrao('sem_roteador');
    if (data.length !== 1) return padrao('vinculo_ambiguo');
    const quantidade = quantidadeDeHistoricoSalva(data[0]!.config);
    return quantidade === null ? padrao('config_ausente_ou_invalida') : { quantidade, origem: 'roteador', motivo: 'configurado' };
  } catch { return padrao('leitura_indisponivel'); }
}
