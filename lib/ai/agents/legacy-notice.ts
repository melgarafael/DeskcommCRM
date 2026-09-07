import type {SupabaseClient} from '@supabase/supabase-js';
import {logger} from '@/lib/logger';
import type {PublishOutcome} from './first-publication';
const causes={
 sem_canal:'Conecte ou escolha um canal de WhatsApp para este agente.',
 sem_credencial:'Cadastre e valide a chave do provedor de inteligência artificial.',
 sem_modelo:'Sincronize o catálogo e escolha um modelo compatível com ferramentas.',
 modelo_ambiguo:'Escolha explicitamente o provedor e o modelo para este agente.',
 sem_versao:'Este agente ainda não tem uma versão publicada. Retome a configuração preservada.',
 migracao_falhou:'A recuperação não terminou. Retome a configuração preservada e revise canal, modelo e credencial.',
 pronto:'A configuração foi recuperada. As respostas usam a versão publicada do agente.',
} as const;
export type LegacyRecoveryCause=keyof typeof causes;
export function legacyRecoveryCause(result:PublishOutcome):LegacyRecoveryCause{
 if(result.published)return 'pronto';
 if(result.reason==='no_channel')return 'sem_canal';
 if(result.reason==='sem_chave')return 'sem_credencial';
 if(result.reason==='no_model')return 'sem_modelo';
 return 'migracao_falhou';
}
export function legacyRecoveryMessage(code:LegacyRecoveryCause){return causes[code];}
export async function recordLegacyNotice(db:SupabaseClient,org:string,agent:string,code:LegacyRecoveryCause){
 try{
  const {error}=await db.rpc('fn_agent_legacy_notice',{p_org:org,p_agent:agent,p_code:code,p_title:code==='pronto'?'Agente recuperado':'Agente precisa concluir a configuração',p_body:`${causes[code]} Abra IA → Agentes → Recuperar agente legado.`});
  if(error)throw error;
 }catch(error){logger.warn('Falha ao registrar estado do agente legado',{organization_id:org,agent_id:agent,code,error:error instanceof Error?error.message:String(error)});}
}
