import {randomUUID} from 'node:crypto';
import {type NextRequest} from 'next/server';
import {z} from 'zod';
import {requireRole} from '@/lib/auth/require-role';
import {requireSupportWrite} from '@/lib/impersonate/support';
import {createClient} from '@/lib/supabase/server';
import {createAdminClient} from '@/lib/supabase/admin';
import {conversasVisiveisDosCasos,lerChamado} from '@/lib/escalacao/chamados';
import {recuperarComunicacao,ComunicacaoConflict} from '@/lib/escalacao/recuperar-comunicacao';
import {getRequestPool} from '@/lib/agent-engine/db/request-pool';
import {StaleServiceBoundaryError} from '@/lib/atendimento/fronteira';
import {ok,fail} from '@/lib/api/wrappers';

export const dynamic='force-dynamic';
const schema=z.discriminatedUnion('action',[
  z.object({event_id:z.string().uuid(),action:z.literal('retry')}).strict(),
  z.object({event_id:z.string().uuid(),action:z.literal('rectify'),body:z.string().trim().min(1).max(4000)}).strict(),
]);
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}):Promise<Response>{
  const denied=await requireSupportWrite();if(denied)return denied;
  const requestId=randomUUID();const auth=await requireRole('agent',{requestId,resource:'agent_cases'});
  if(!auth.ok)return auth.response;
  const {id}=await params;if(!z.string().uuid().safeParse(id).success)return fail('not_found','Caso não encontrado.',404,{requestId});
  let input:unknown;try{input=await req.json();}catch{return fail('invalid_request','Body inválido.',400,{requestId});}
  const parsed=schema.safeParse(input);if(!parsed.success)return fail('validation_failed','Body inválido.',422,{requestId});
  try {
  const visible=await conversasVisiveisDosCasos(await createClient(),auth.org.orgId,{caseId:id});
  if(!await lerChamado(createAdminClient(),auth.org.orgId,id,{visiveisPara:visible}))return fail('not_found','Caso não encontrado.',404,{requestId});
    const result=await recuperarComunicacao(getRequestPool(),{org:auth.org.orgId,caseId:id,eventId:parsed.data.event_id,
      actor:auth.user.id,role:z.enum(['agent','manager','admin']).parse(auth.org.role),
      support:auth.user.support?{session_id:auth.user.support.id,access_mode:auth.user.support.access_mode}:null},parsed.data.action,parsed.data.action==='rectify'?parsed.data.body:undefined);
    return ok(result,{requestId});
  }catch(e){
    if(e instanceof ComunicacaoConflict)return fail('invalid_state',e.message,409,{requestId});
    if(e instanceof StaleServiceBoundaryError)return fail('invalid_state','O atendimento mudou; não reutilize esta decisão.',409,{requestId});
    return fail('unavailable','Não foi possível recuperar a comunicação. Releia o Caso.',503,{requestId});
  }
}
