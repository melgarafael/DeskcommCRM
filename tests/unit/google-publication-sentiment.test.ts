import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({rpc:vi.fn(),message:{body:"Is the same reservation ready?",media_derived_text:null as string|null},handoff:vi.fn()}));
const ORG="22222222-2222-4222-8222-222222222222",CONV="44444444-4444-4444-8444-444444444444",MSG="66666666-6666-4666-8666-666666666666";
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>({
  rpc:mocks.rpc,
  from:(table:string)=>{
    const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,
      maybeSingle:async()=>({data:table==="messages"?mocks.message:null,error:null})};
    return chain;
  },
})}));
vi.mock("@/lib/atendimento/origem-mensagem",()=>({serviceFromMessage:async()=>({organization_id:ORG,conversation_id:CONV,contact_id:MSG,service_revision:1})}));
vi.mock("@/lib/ai/handoff/orchestrator",()=>({triggerHandoff:mocks.handoff}));
vi.mock("@/lib/logger",()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
const event={id:MSG,organization_id:ORG,event_type:"ai.sentiment_alert",entity_kind:"message",entity_id:MSG,
  payload:{message_id:MSG,conversation_id:CONV,sentiment_score:-0.9},metadata:{},consumed_by:[],attempts:0} as EventRow;
beforeEach(()=>{
  vi.clearAllMocks();mocks.message.body="Is the same reservation ready?";mocks.message.media_derived_text=null;
  mocks.handoff.mockResolvedValue({triggered:true,reason:"low_sentiment"});
});
describe("native sentiment worker coordinates publication without hiding human requests",()=>{
  it("retries the existing event briefly without sending a notice or changing ownership",async()=>{
    mocks.rpc.mockResolvedValue({data:{owned:false,wait_until:new Date(Date.now()+60000).toISOString()},error:null});
    const result=await aiHandoffFromSentimentHandler.handle(event);
    expect(result).toMatchObject({status:"retry",detail:"publication_waiting_current_turn"});
    expect(result.retry_at).toBeDefined();expect(mocks.handoff).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("fn_google_publication_sentiment_context",{p_org:ORG,p_conversation:CONV,p_message:MSG});
  });
  it("skips only this alert when the current native turn adopted the same reservation",async()=>{
    mocks.rpc.mockResolvedValue({data:{owned:true},error:null});
    expect(await aiHandoffFromSentimentHandler.handle(event)).toMatchObject({status:"skipped",detail:"native_publication_recovery"});
    expect(mocks.handoff).not.toHaveBeenCalled();
  });
  it.each([null,{owned:false,wait_until:"2000-01-01T00:00:00Z"}])("keeps ordinary handoff when no valid current recovery remains (%j)",async(context)=>{
    mocks.rpc.mockResolvedValue({data:context,error:null});
    expect(await aiHandoffFromSentimentHandler.handle(event)).toMatchObject({status:"ok"});
    expect(mocks.handoff).toHaveBeenCalledOnce();
    expect(mocks.handoff).toHaveBeenCalledWith(expect.objectContaining({reason:"low_sentiment",conversationId:CONV,organizationId:ORG}));
  });
  it("an explicit human request retains the original handoff even with publication pending",async()=>{
    mocks.message.body="Quero falar com um atendente";mocks.rpc.mockResolvedValue({data:{owned:true},error:null});
    expect(await aiHandoffFromSentimentHandler.handle(event)).toMatchObject({status:"ok"});
    expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.handoff).toHaveBeenCalledOnce();
  });
  it("a failed context read cannot fabricate an exemption or send a generic human notice",async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:{code:"57014",message:"Fictitious timeout"}});
    await expect(aiHandoffFromSentimentHandler.handle(event)).rejects.toMatchObject({code:"57014"});
    expect(mocks.handoff).not.toHaveBeenCalled();
  });
});
