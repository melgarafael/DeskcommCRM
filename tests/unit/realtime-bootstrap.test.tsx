import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({prepare:vi.fn(),channel:vi.fn(),remove:vi.fn(),subscribe:vi.fn()}));
vi.mock("@/lib/supabase/browser",()=>({prepareRealtimeAuthentication:mock.prepare,createClient:()=>({channel:mock.channel,removeChannel:mock.remove})}));
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
beforeEach(()=>{vi.clearAllMocks();mock.prepare.mockResolvedValue(undefined);const channel={on:vi.fn(),subscribe:mock.subscribe};channel.on.mockReturnValue(channel);mock.channel.mockReturnValue(channel);});
afterEach(()=>vi.useRealTimers());
it("nenhum canal nasce antes de o token estar pronto",async()=>{
 let release!:()=>void;mock.prepare.mockReturnValue(new Promise<void>(r=>{release=r;}));
 const {unmount}=renderHook(()=>useRealtimeChannel({name:"org-B",onChange:()=>{}}));
 expect(mock.channel).not.toHaveBeenCalled();
 await act(async()=>release());expect(mock.channel).toHaveBeenCalledTimes(1);expect(mock.subscribe).toHaveBeenCalledTimes(1);unmount();
});
it("token tardio de tela desmontada nunca assina",async()=>{
 let release!:()=>void;mock.prepare.mockReturnValue(new Promise<void>(r=>{release=r;}));
 const {unmount}=renderHook(()=>useRealtimeChannel({name:"org-A",onChange:()=>{}}));unmount();
 await act(async()=>release());expect(mock.channel).not.toHaveBeenCalled();
});
it("falta de token falha sem join anon e tenta novamente com backoff",async()=>{
 vi.useFakeTimers();mock.prepare.mockRejectedValueOnce(new Error("sem token")).mockResolvedValue(undefined);
 const {result,unmount}=renderHook(()=>useRealtimeChannel({name:"org-B",onChange:()=>{}}));
 await act(async()=>{});expect(result.current.status).toBe("channel_error");expect(mock.channel).not.toHaveBeenCalled();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(mock.channel).toHaveBeenCalledTimes(1);unmount();
});
it("trocar topologia descarta promessa A e só assina B",async()=>{
 let release!:()=>void;mock.prepare.mockReturnValueOnce(new Promise<void>(r=>{release=r;})).mockResolvedValue(undefined);
 const {rerender,unmount}=renderHook(({name})=>useRealtimeChannel({name,onChange:()=>{}}),{initialProps:{name:"org-A"}});
 rerender({name:"org-B"});await waitFor(()=>expect(mock.channel).toHaveBeenCalledTimes(1));
 await act(async()=>release());expect(mock.channel).toHaveBeenCalledTimes(1);expect(mock.channel.mock.calls[0]?.[0]).toContain("org-B");unmount();
});
