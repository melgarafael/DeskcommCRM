import {type NextRequest} from 'next/server';
import {autorizaCron} from '@/lib/auth/cron-auth';
import {getRequestPool} from '@/lib/agent-engine/db/request-pool';
import {reconciliarComunicacoesPendentes} from '@/lib/escalacao/comunicacao-do-caso';
import {ok,fail} from '@/lib/api/wrappers';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest):Promise<Response>{
  if(!autorizaCron(req))return fail('unauthorized','Não autorizado.',401);
  try{return ok({examined:await reconciliarComunicacoesPendentes(getRequestPool())});}
  catch{return fail('unavailable','A comunicação pendente não pôde ser reconciliada.',503);}
}
export const POST=GET;
