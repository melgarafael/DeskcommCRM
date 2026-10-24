"use client";
import {useState} from 'react';
import {useAuth,usePermission} from '@/hooks/auth/AuthProvider';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api/client';
import {Button} from '@/components/ui/button';
import {useT} from '@/hooks/i18n/useT';
import type {ComunicacaoDoEvento,EstadoDaComunicacao} from '@/lib/escalacao/comunicacao-do-caso';

const labels:Record<EstadoDaComunicacao,string>={pending:'Comunicação pendente',queued:'Na fila',sent:'Mensagem enviada',
  deferred:'Tentativa adiada',vetoed:'Envio recusado',failed:'Falha ou entrega a conferir',cancelled_or_stale:'Decisão fora de vigência',unknown_legacy:'Comunicação antiga não comprovada'};
export function CaseCommunication({caseId,events}:{caseId:string;events:ComunicacaoDoEvento[]}){
  const {user}=useAuth(),allowed=usePermission("ai.inbox.view"),
    canWrite=allowed&&(!user.support||(user.support.status==='active'&&user.support.access_mode==='full'));
  const t=useT(),qc=useQueryClient();const [editing,setEditing]=useState<string|null>(null),[note,setNote]=useState('');
  const mutation=useMutation({mutationFn:({event_id,action,body}:{event_id:string;action:'retry'|'rectify';body?:string})=>
    apiClient.post(`/api/v1/ai/cases/${caseId}/communication`,{event_id,action,...(body?{body}:{})}),
    onSuccess:()=>{setEditing(null);setNote('');},onSettled:()=>{qc.invalidateQueries({queryKey:['ai-case',caseId]});qc.invalidateQueries({queryKey:['ai-cases']});}});
  if(!events.length)return null;
  return <section className="space-y-3 rounded-lg border p-3" aria-label={t('Comunicação ao cliente')}>
    <h3 className="text-sm font-semibold">{t('Comunicação ao cliente')}</h3>
    <p className="text-xs text-muted-foreground">{t('A conclusão do Caso e o envio da mensagem são estados separados.')}</p>
    {events.map(e=><div key={e.event_id} className="space-y-2 border-t pt-2" data-state={e.state}>
      <p className="text-sm font-medium">{t(labels[e.state])}</p>
      <p className="text-xs">{t(e.reason)} {t(e.next_step)}</p>
      {e.partial?<p className="text-xs">{t('Houve envio parcial; confira a conversa antes de retificar.')}</p>:null}
      {e.delivery?<p className="text-xs">{t(e.delivery==='read'?'Mensagem lida':e.delivery==='delivered'?'Mensagem entregue':'Enviada; entrega e leitura não confirmadas')}</p>:null}
      <div className="flex flex-wrap gap-2">
        {canWrite&&e.can_retry?<Button size="sm" variant="outline" disabled={mutation.isPending} onClick={()=>mutation.mutate({event_id:e.event_id,action:'retry'})}>{t('Reavaliar comunicação')}</Button>:null}
        {canWrite&&e.can_rectify?<Button size="sm" variant="outline" disabled={mutation.isPending} onClick={()=>{setEditing(e.event_id);setNote('');}}>{t('Retificar no mesmo Caso')}</Button>:null}
      </div>
      {editing===e.event_id?<div className="space-y-2">
        <label className="block text-xs">{t('Decisão retificada')}<textarea className="mt-1 w-full rounded-md border p-2" value={note} maxLength={4000} onChange={ev=>setNote(ev.target.value)}/></label>
        <p className="text-xs">{t('O histórico será preservado. A nova nota será reavaliada antes de qualquer envio.')}</p>
        <Button size="sm" disabled={mutation.isPending||!note.trim()} onClick={()=>mutation.mutate({event_id:e.event_id,action:'rectify',body:note})}>{t('Registrar retificação')}</Button>
      </div>:null}
    </div>)}
    {mutation.error?<p role="alert" className="text-xs text-destructive">{t('Não foi possível recuperar a comunicação. Releia o Caso e confira a fila.')}</p>:null}
  </section>;
}
