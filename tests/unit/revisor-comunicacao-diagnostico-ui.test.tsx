import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup,act} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CaseCommunication} from '@/app/app/ai/cases/_components/CaseCommunication';
import {ReviewDiagnostics} from '@/app/app/ai/runs/_components/ReviewDiagnostics';
import {projetarComunicacao} from '@/lib/escalacao/comunicacao-do-caso';
const m=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),allowed:true,readonly:false}));
vi.mock('@/lib/api/client',()=>({apiClient:{get:m.get,post:m.post}}));
vi.mock('@/hooks/i18n/useT',()=>({useT:()=>(s:string)=>s}));
vi.mock('@/hooks/auth/AuthProvider',()=>({usePermission:()=>m.allowed,useAuth:()=>({user:{support:m.readonly?{status:'active',access_mode:'support_readonly'}:null}})}));
function wrap(ui:React.ReactNode){const qc=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return{qc,...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)};}
const base={event_id:'event',job_id:'job',authenticated:true,invalidated:false,job_status:'done',deferred:false,manual_retries:0,trace_id:'trace',vetoed_code:null,ledger:[]};
beforeEach(()=>{vi.clearAllMocks();m.allowed=true;m.readonly=false;m.get.mockResolvedValue({data:{sessions:[]}});m.post.mockResolvedValue({data:{}});});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('Comunicação no Caso real',()=>{
  it('Caso resolvido sem envio mostra pendência e permite revisão, sem afirmar entrega',async()=>{
    wrap(<CaseCommunication caseId="case" events={[projetarComunicacao(base)]}/>);expect(screen.getByText('Comunicação pendente')).toBeTruthy();expect(screen.queryByText('Mensagem entregue')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Reavaliar comunicação'}));await waitFor(()=>expect(m.post).toHaveBeenCalledWith('/api/v1/ai/cases/case/communication',{event_id:'event',action:'retry'}));
  });
  it('retificação exige nota, mantém mesmo Caso/evento original como referência',async()=>{
    wrap(<CaseCommunication caseId="case" events={[projetarComunicacao({...base,vetoed_code:'case_promise'})]}/>);
    fireEvent.click(screen.getByRole('button',{name:'Retificar no mesmo Caso'}));const save=screen.getByRole('button',{name:'Registrar retificação'});expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Decisão retificada'),{target:{value:'Condição corrigida'}});fireEvent.click(save);
    await waitFor(()=>expect(m.post).toHaveBeenCalledWith('/api/v1/ai/cases/case/communication',{event_id:'event',action:'rectify',body:'Condição corrigida'}));
  });
  it('sent não afirma delivered/read; decisão stale não oferece reutilização',()=>{
    wrap(<CaseCommunication caseId="case" events={[projetarComunicacao({...base,ledger:[{status:'accepted',message_status:'sent',message_id:'message'}]})]}/>);
    expect(screen.getByText('Enviada; entrega e leitura não confirmadas')).toBeTruthy();expect(screen.queryByRole('button',{name:'Reavaliar comunicação'})).toBeNull();cleanup();
    wrap(<CaseCommunication caseId="case" events={[projetarComunicacao({...base,invalidated:true})]}/>);expect(screen.getByText('Decisão fora de vigência')).toBeTruthy();expect(screen.queryByRole('button')).toBeNull();
  });
  it.each(['viewer','support_readonly'])('%s não vê botões de efeito',mode=>{m.allowed=mode!=='viewer';m.readonly=mode==='support_readonly';wrap(<CaseCommunication caseId="case" events={[projetarComunicacao(base)]}/>);expect(screen.queryByRole('button')).toBeNull();});
});
describe('Diagnóstico privado na superfície existente de execuções',()=>{
  it('não habilita por abrir a tela, sem confirmação; pede escopo explícito',async()=>{
    wrap(<ReviewDiagnostics/>);await screen.findByText('Diagnóstico privado da revisão');fireEvent.click(screen.getByText('Diagnóstico privado da revisão'));expect(m.post).not.toHaveBeenCalled();expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('button',{name:'Habilitar captura limitada'})).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Identificador do escopo'),{target:{value:'job-test'}});fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Habilitar captura limitada'}));
    await waitFor(()=>expect(m.post).toHaveBeenCalledWith('/api/v1/ai/review-diagnostics',{action:'enable',scope_kind:'job',scope_id:'job-test',test_contact_confirmed:true}));
  });
  it('falha de autorização não oferece habilitação nem conteúdo',async()=>{m.get.mockRejectedValue(new Error('403'));wrap(<ReviewDiagnostics/>);await screen.findByRole('status');expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();});
  it('conteúdo aberto é removido da tela/cache ao vencer, sem renovar TTL',async()=>{
    vi.useFakeTimers();const expires=new Date(Date.now()+30000).toISOString();
    m.get.mockImplementation(async(url:string)=>({data:url.includes('session_id')?{records:[{expires_at:expires,caminho:'reserva',payload:{candidate:'CAPTURA_TESTE_TEMPORARIA'}}]}:{sessions:[{id:'session',enabled:true,collect_until:new Date(Date.now()+7200000).toISOString(),reviews:1,bytes:100,last_purged_at:new Date().toISOString(),stopped_reason:null}]}}));
    const {qc}=wrap(<ReviewDiagnostics/>);await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
    fireEvent.click(screen.getByText('Diagnóstico privado da revisão'));fireEvent.click(screen.getByRole('button',{name:'Ler captura privada'}));await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(screen.getByText(/CAPTURA_TESTE_TEMPORARIA/)).toBeTruthy();
    await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});expect(screen.queryByText(/CAPTURA_TESTE_TEMPORARIA/)).toBeNull();expect(qc.getQueryData(['review-diagnostics-records','session'])).toBeUndefined();expect(qc.getQueriesData({queryKey:['review-diagnostics-records']}).every(([,data])=>data===undefined)).toBe(true);
  });
});
