import {type NextRequest} from 'next/server';
import {autorizaCron} from '@/lib/auth/cron-auth';
import {createAdminClient} from '@/lib/supabase/admin';
import {audit} from '@/lib/audit';
import {ok,fail} from '@/lib/api/wrappers';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest):Promise<Response>{
  if(!autorizaCron(req))return fail('unauthorized','Não autorizado.',401);
  const db=createAdminClient();
  try {
  const {data,error}=await db.rpc('fn_review_capture_purge',{p_org:null});
  if(error){
    // A guarda de heartbeat impede novas coletas mesmo se o banco impedir este desligamento.
    await db.rpc('fn_review_capture_stop_for_purge_error');
    return fail('unavailable','Expurgo da captura falhou; confira a interrupção da coleta.',503);
  }
  const row=Array.isArray(data)?data[0]:data;
  if(Number(row?.deleted)>0)await audit({action:'ai.review_capture_purged',resourceType:'review_capture',metadata:{records:Number(row.deleted),lag_ms:Number(row.lag_ms)}});
  return ok({deleted:Number(row?.deleted??0),lag_ms:Number(row?.lag_ms??0)});
  }catch{
    try{await db.rpc('fn_review_capture_stop_for_purge_error');}catch{/* Heartbeat da captura falha fechado. */}
    return fail('unavailable','Não foi possível comprovar o expurgo físico.',503);
  }
}
export const POST=GET;
