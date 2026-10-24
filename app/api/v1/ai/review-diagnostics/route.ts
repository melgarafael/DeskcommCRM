import {randomUUID} from 'node:crypto';
import {type NextRequest} from 'next/server';
import {z} from 'zod';
import {requireRole} from '@/lib/auth/require-role';
import {requireSupportWrite} from '@/lib/impersonate/support';
import {createAdminClient} from '@/lib/supabase/admin';
import {ok,fail} from '@/lib/api/wrappers';

export const dynamic='force-dynamic';
const schema=z.discriminatedUnion('action',[
  z.object({action:z.literal('enable'),scope_kind:z.enum(['job','test_contact']),scope_id:z.string().uuid(),test_contact_confirmed:z.literal(true)}).strict(),
  z.object({action:z.literal('revoke'),session_id:z.string().uuid()}).strict(),
]);
async function execute(req:NextRequest,write:boolean):Promise<Response>{
  const requestId=randomUUID();const auth=await requireRole('admin',{requestId,resource:'review_capture'});
  if(!auth.ok)return auth.response;
  let input:{action:string;scope_kind?:string;scope_id?:string;session_id?:string}={action:'status'};
  if(write){let body:unknown;try{body=await req.json();}catch{return fail('invalid_request','Body inválido.',400,{requestId});}
    const p=schema.safeParse(body);if(!p.success)return fail('validation_failed','Escopo e confirmação explícita são obrigatórios.',422,{requestId});input=p.data;
  }else{const session=req.nextUrl.searchParams.get('session_id');
    if(session){if(!z.string().uuid().safeParse(session).success)return fail('not_found','Captura não encontrada.',404,{requestId});input={action:'read',session_id:session};}}
  try {
  const {data,error}=await createAdminClient().rpc('fn_review_capture_manage',{
    p_org:auth.org.orgId,p_actor:auth.user.id,p_action:input.action,p_scope:input.scope_id??null,
    p_kind:input.scope_kind??null,p_session:input.session_id??null,
    p_support:auth.user.support?{session_id:auth.user.support.id,access_mode:auth.user.support.access_mode}:null,
  });
  if(error)return fail('unavailable','Diagnóstico privado indisponível; nenhuma coleta foi habilitada por esta resposta.',503,{requestId});
  if(data===null)return fail('not_found','Escopo ou captura não encontrado nesta organização.',404,{requestId});
  const response=ok(data,{requestId});response.headers.set('Cache-Control','private, no-store');return response;
  } catch {return fail('unavailable','Diagnóstico privado indisponível.',503,{requestId});}
}
export function GET(req:NextRequest){return execute(req,false);}
export async function POST(req:NextRequest):Promise<Response>{
  const denied=await requireSupportWrite();if(denied)return denied;
  return execute(req,true);
}
