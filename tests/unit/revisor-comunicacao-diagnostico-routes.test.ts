import {beforeEach,describe,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({role:'admin',rpc:vi.fn(),recover:vi.fn(),visible:vi.fn(),detail:vi.fn(),denied:null as Response|null,cron:true,audit:vi.fn()}));
vi.mock('@/lib/auth/require-role',()=>({requireRole:vi.fn(async(min:string)=>{
  const ranks:Record<string,number>={viewer:0,agent:1,manager:2,admin:3};
  return ranks[m.role]!<ranks[min]! ?{ok:false,response:new Response('{}',{status:403})}:
    {ok:true,user:{id:'00000000-0000-4000-8000-000000000001'},org:{orgId:'00000000-0000-4000-8000-000000000002',role:m.role}};
})}));
vi.mock('@/lib/impersonate/support',()=>({requireSupportWrite:()=>m.denied}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:m.rpc})}));
vi.mock('@/lib/supabase/server',()=>({createClient:()=>({session:true})}));
vi.mock('@/lib/escalacao/chamados',()=>({conversasVisiveisDosCasos:m.visible,lerChamado:m.detail}));
vi.mock('@/lib/agent-engine/db/request-pool',()=>({getRequestPool:()=>({owned:true})}));
vi.mock('@/lib/escalacao/recuperar-comunicacao',()=>({recuperarComunicacao:m.recover,ComunicacaoConflict:class extends Error{}}));
vi.mock('@/lib/auth/cron-auth',()=>({autorizaCron:()=>m.cron}));
vi.mock('@/lib/audit',()=>({audit:m.audit}));
import {GET as purge} from '@/app/api/v1/cron/review-capture-purge/route';
import {GET as status,POST as capture} from '@/app/api/v1/ai/review-diagnostics/route';
import {POST as recover} from '@/app/api/v1/ai/cases/[id]/communication/route';
const ID='00000000-0000-4000-8000-000000000003',EVENT='00000000-0000-4000-8000-000000000004';
const post=(body:unknown)=>new NextRequest('https://example.test/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();m.role='admin';m.denied=null;m.cron=true;m.audit.mockResolvedValue(undefined);m.rpc.mockResolvedValue({data:{default_enabled:false,sessions:[]},error:null});m.visible.mockResolvedValue(new Set([ID]));m.detail.mockResolvedValue({id:ID});m.recover.mockResolvedValue({job_id:ID,event_id:EVENT,reused:true});});
describe('Rotas de diagnóstico: autorização antes da RPC privada',()=>{
  it.each(['viewer','agent','manager'])('%s não lê nem habilita conteúdo privado',async(role)=>{
    m.role=role;expect((await status(new NextRequest('https://example.test/api'))).status).toBe(403);
    expect((await capture(post({action:'enable',scope_kind:'job',scope_id:ID,test_contact_confirmed:true}))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
  });
  it('status default-off não habilita; leitura não é cacheável',async()=>{
    const response=await status(new NextRequest('https://example.test/api'));expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(m.rpc).toHaveBeenCalledWith('fn_review_capture_manage',expect.objectContaining({p_action:'status',p_org:'00000000-0000-4000-8000-000000000002',p_actor:'00000000-0000-4000-8000-000000000001'}));
  });
  it('confirmação e escopo são explícitos; body não define org ou ator',async()=>{
    for(const body of [{action:'enable',scope_kind:'job',scope_id:ID},{action:'enable',scope_kind:'job',scope_id:ID,test_contact_confirmed:true,organization_id:ID},{action:'enable',scope_kind:'organization',scope_id:ID,test_contact_confirmed:true}])expect((await capture(post(body))).status).toBe(422);
    expect(m.rpc).not.toHaveBeenCalled();
    expect((await capture(post({action:'enable',scope_kind:'test_contact',scope_id:ID,test_contact_confirmed:true}))).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('fn_review_capture_manage',expect.objectContaining({p_scope:ID,p_kind:'test_contact',p_action:'enable'}));
  });
  it('suporte somente leitura não muda coleta nem revoga',async()=>{m.denied=new Response('{}',{status:403});expect((await capture(post({action:'revoke',session_id:ID}))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();});
  it('ausência e outro tenant são 404; erro de audit/RPC não retorna conteúdo',async()=>{
    m.rpc.mockResolvedValueOnce({data:null,error:null});expect((await status(new NextRequest(`https://example.test/api?session_id=${ID}`))).status).toBe(404);
    m.rpc.mockResolvedValueOnce({data:{records:['SEGREDO_INACESSIVEL']},error:{message:'erro privado'}});const r=await status(new NextRequest(`https://example.test/api?session_id=${ID}`));expect(r.status).toBe(503);expect(await r.text()).not.toContain('SEGREDO_INACESSIVEL');
    m.rpc.mockRejectedValueOnce(new Error('erro privado'));expect((await status(new NextRequest('https://example.test/api'))).status).toBe(503);
  });
});
describe('Recuperação do mesmo Caso: RBAC, visibilidade e body fechado',()=>{
  const params={params:Promise.resolve({id:ID})};
  it('viewer e acompanhamento readonly não chegam ao efeito',async()=>{m.role='viewer';expect((await recover(post({event_id:EVENT,action:'retry'}),params)).status).toBe(403);m.role='admin';m.denied=new Response('{}',{status:403});expect((await recover(post({event_id:EVENT,action:'retry'}),params)).status).toBe(403);expect(m.recover).not.toHaveBeenCalled();});
  it('Caso invisível ou estrangeiro não é confirmado pelo cliente admin',async()=>{m.detail.mockResolvedValue(null);expect((await recover(post({event_id:EVENT,action:'retry'}),params)).status).toBe(404);expect(m.recover).not.toHaveBeenCalled();});
  it('retificação exige nota; retry não aceita nova nota nem autoridade fabricada',async()=>{
    for(const body of [{event_id:EVENT,action:'rectify'},{event_id:EVENT,action:'retry',body:'concessão'},{event_id:EVENT,action:'retry',actor:ID},{event_id:EVENT,action:'retry',role:'admin'}])expect((await recover(post(body),params)).status).toBe(422);expect(m.recover).not.toHaveBeenCalled();
  });
  it('identidade/role vêm da sessão, nota vai somente para a ação de retificação',async()=>{
    m.role='agent';expect((await recover(post({event_id:EVENT,action:'rectify',body:'Conclusão revisada'}),params)).status).toBe(200);
    expect(m.recover).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({caseId:ID,eventId:EVENT,actor:'00000000-0000-4000-8000-000000000001',org:'00000000-0000-4000-8000-000000000002',role:'agent'}),'rectify','Conclusão revisada');
  });
});


describe('expurgo: autenticação, atraso real e interrupção em falha',()=>{
  it('sem segredo do cron não consulta nem purga',async()=>{m.cron=false;expect((await purge(new NextRequest('https://example.test/api'))).status).toBe(401);expect(m.rpc).not.toHaveBeenCalled();});
  it('resultado registra contagem e atraso físico, sem conteúdo',async()=>{m.rpc.mockResolvedValue({data:[{deleted:2,lag_ms:3600000}],error:null});const r=await purge(new NextRequest('https://example.test/api'));expect(r.status).toBe(200);expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({metadata:{records:2,lag_ms:3600000}}));});
  it('falha de purga pede desligamento; resposta não inventa sucesso físico',async()=>{m.rpc.mockResolvedValueOnce({data:null,error:{message:'erro privado'}}).mockResolvedValueOnce({data:1,error:null});expect((await purge(new NextRequest('https://example.test/api'))).status).toBe(503);expect(m.rpc).toHaveBeenLastCalledWith('fn_review_capture_stop_for_purge_error');});
});
