"use client";
import {useState,useEffect} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {apiClient} from '@/lib/api/client';
import {useT} from '@/hooks/i18n/useT';
const reasons:Record<string,string>={quota:'Limite da sessão atingido',purge_late:'Expurgo atrasado',purge_failed:'Expurgo não comprovado',revoked:'Coleta revogada',anonymized:'Contato anonimizado',replaced:'Sessão substituída',collection_ended:'Janela de coleta encerrada'};
interface CaptureRecord{expires_at:string;payload:unknown;caminho:string;}
interface Session{id:string;enabled:boolean;collect_until:string;reviews:number;bytes:number;last_purged_at:string|null;stopped_reason:string|null;}
export function ReviewDiagnostics(){
  const t=useT(),qc=useQueryClient(),[scope,setScope]=useState(''),[kind,setKind]=useState<'job'|'test_contact'>('job'),
    [confirmed,setConfirmed]=useState(false),[opened,setOpened]=useState<string|null>(null);
  const state=useQuery({queryKey:['review-diagnostics'],refetchInterval:60000,
    queryFn:()=>apiClient.get<{data:{sessions:Session[]}}>('/api/v1/ai/review-diagnostics').then(r=>r.data)});
  const records=useQuery({queryKey:['review-diagnostics-records',opened],enabled:opened!==null,staleTime:0,gcTime:0,
    queryFn:()=>apiClient.get<{data:{records:CaptureRecord[]}}>(`/api/v1/ai/review-diagnostics?session_id=${opened}`).then(r=>r.data)});
  const mutation=useMutation({mutationFn:(body:unknown)=>apiClient.post('/api/v1/ai/review-diagnostics',body),
    onSuccess:()=>{setOpened(null);setConfirmed(false);qc.removeQueries({queryKey:['review-diagnostics-records']});},
    onSettled:()=>qc.invalidateQueries({queryKey:['review-diagnostics']})});
  useEffect(()=>()=>{qc.removeQueries({queryKey:['review-diagnostics-records']});},[qc]);
  useEffect(()=>{
    if(!opened||!records.data?.records.length)return;
    const until=Math.min(...records.data.records.map(r=>Date.parse(r.expires_at)));
    const timer=setTimeout(()=>{setOpened(null);qc.removeQueries({queryKey:['review-diagnostics-records']});},Math.max(0,until-Date.now()));
    return()=>clearTimeout(timer);
  },[opened,records.data,qc]);
  useEffect(()=>{
    if(opened&&state.data&&!state.data.sessions.some(s=>s.id===opened&&!['revoked','anonymized','replaced'].includes(s.stopped_reason??''))){
      setOpened(null);qc.removeQueries({queryKey:['review-diagnostics-records']});
    }
  },[opened,state.data,qc]);
  if(state.isPending)return null;
  if(state.error)return <p className="my-4 text-sm" role="status">{t('Diagnóstico privado restrito ao administrador ou indisponível.')}</p>;
  return <details className="my-4 rounded-md border p-3" onToggle={ev=>{if(!ev.currentTarget.open){setOpened(null);qc.removeQueries({queryKey:['review-diagnostics-records']});}}}>
    <summary className="cursor-pointer text-sm font-medium">{t('Diagnóstico privado da revisão')}</summary>
    <div className="mt-3 space-y-3 text-sm">
      <p>{t('Desligado por padrão. Colete somente uma execução ou um contato de teste identificado nesta instalação. Até 2 horas, 100 capturas e 10 MiB por sessão. Conteúdo acessível por até 72 horas, com expurgo físico e leitura auditada.')}</p>
      <label className="block">{t('Escopo')} <select value={kind} onChange={e=>setKind(e.target.value as typeof kind)} className="rounded-md border p-1"><option value="job">{t('Execução')}</option><option value="test_contact">{t('Contato de teste')}</option></select></label>
      <label className="block">{t('Identificador do escopo')}<input className="ml-2 max-w-full rounded-md border p-1" value={scope} onChange={e=>setScope(e.target.value)}/></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t('Confirmo o escopo de teste e autorizo a captura privada limitada de conteúdo sanitizado.')}</label>
      <Button size="sm" disabled={!confirmed||!scope||mutation.isPending} onClick={()=>mutation.mutate({action:'enable',scope_kind:kind,scope_id:scope,test_contact_confirmed:true})}>{t('Habilitar captura limitada')}</Button>
      {state.data?.sessions.map(s=><div className="space-y-1 border-t pt-2" key={s.id}>
        <p>{t(s.enabled?'Coleta ativa':'Coleta encerrada')}: {s.reviews}/100 · {(s.bytes/1024).toFixed(1)} KiB</p>
        <p className="text-xs">{t('Fim da coleta')}: {new Date(s.collect_until).toLocaleString()} · {t('Último expurgo físico')}: {s.last_purged_at?new Date(s.last_purged_at).toLocaleString():t('Ainda não comprovado')}</p>
        {s.stopped_reason?<p className="text-xs">{t('Motivo')}: {t(reasons[s.stopped_reason]??'Expurgo não comprovado')}</p>:null}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={()=>setOpened(s.id)}>{t('Ler captura privada')}</Button>
          <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={()=>mutation.mutate({action:'revoke',session_id:s.id})}>{t('Revogar e expurgar')}</Button></div>
      </div>)}
      {opened?<div><Button size="sm" variant="outline" onClick={()=>{setOpened(null);qc.removeQueries({queryKey:['review-diagnostics-records']});}}>{t('Fechar conteúdo')}</Button>
        {records.error?<p role="alert">{t('Não foi possível ler a captura privada.')}</p>:<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(records.data?.records??[],null,2)}</pre>}</div>:null}
      {mutation.error?<p role="alert">{t('A operação não foi confirmada. Releia o estado do diagnóstico.')}</p>:null}
    </div>
  </details>;
}
