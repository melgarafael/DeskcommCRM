import { describe, expect, it } from "vitest";
import { classificarErroDoGoogle } from "@/lib/agenda/google/erros";
import { googlePublication } from "@/lib/agenda/google/publication";

const published = { status: "confirmed", google_event_id: "native-event", google_local_revision: "2", google_synced_local_revision: 2, needs_google_push: false };
describe("current Google publication proof", () => {
  it.each(["AbortError", "TimeoutError"])("%s preserves recovery without pretending the Google server returned HTTP", name => {
    const error = new DOMException("Controlled publication deadline", name);
    for (const operation of ["criar", "atualizar", "apagar", "disponibilidade"] as const)
      expect(classificarErroDoGoogle(error, operation)).toMatchObject({ desfecho: "transitorio", status: null });
  });
  it("a real permission refusal remains human-dependent, while server/cota failures remain recoverable", () => {
    expect(classificarErroDoGoogle({ status: 403, error: { errors: [{ reason: "insufficientPermissions" }] } }, "criar").desfecho).toBe("sem_permissao");
    expect(classificarErroDoGoogle({ status: 429 }, "criar").desfecho).toBe("recuar");
    expect(classificarErroDoGoogle({ status: 503 }, "criar").desfecho).toBe("transitorio");
  });
  it("requires an event, current revision and no outstanding push", () => {
    expect(googlePublication(published)).toBe("synced");
    expect(googlePublication({ ...published, google_event_id: null })).toBe("pending");
    expect(googlePublication({ ...published, google_local_revision: 3 })).toBe("pending");
    expect(googlePublication({ ...published, needs_google_push: true })).toBe("pending");
    expect(googlePublication({ ...published, needs_google_push: undefined })).toBe("pending");
  });
  it("separates recoverable waiting from human-dependent failure", () => {
    expect(googlePublication({ ...published, google_sync_error: "Temporary failure", google_sync_failure_kind: "transient" })).toBe("retrying");
    expect(googlePublication({ ...published, google_sync_error: "Reconnect required", google_sync_failure_kind: "human_required" })).toBe("failed");
    expect(googlePublication({ ...published, google_conflict: { kind: "shared" } })).toBe("conflict");
  });
  it("preserves service opt-out, traditional Google publication and cancellation evidence", () => {
    expect(googlePublication({ ...published, service_occurrence_id: "occurrence", service_publication_mode: "none" })).toBe("not_configured");
    expect(googlePublication({ ...published, service_occurrence_id: null, service_publication_mode: "none" })).toBe("synced");
    expect(googlePublication({ ...published, status: "cancelled" })).toBe("removed");
    expect(googlePublication({ ...published, status: "cancelled", google_synced_local_revision: 1 })).toBe("pending");
  });
});


import {vi,beforeEach} from 'vitest';
import {createGooglePublicationTurnHandler} from '@/lib/agent-engine/agent/google-publication-turn';
const retomada=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('@/lib/agent-engine/agent/inbound-turn',()=>({runAgentTurn:retomada.run,ritualBlocks:()=>[]}));
beforeEach(()=>retomada.run.mockClear());
describe('contexto da retomada: handler transporta somente comprovação nativa',()=>{
 const job={id:'job-native',organization_id:'org-native',contact_id:'contact-native',kind:'google_publication_turn',locked_by:'worker-native',claim_acquired_at:'2030-07-03T10:00:00.000001Z',payload:{publication:{reservaId:'FORJADO',revisao:999}}};
 it.each([1,2,3])('agente recebe publicação da revisão %s vinda da consulta, nunca do payload',async revision=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{receipt:{conversation_id:'conv-native',channel_session_id:'channel-native',outcome:'synced'},publication:{reservaId:'reserva-native',revisao:String(revision)}}]}).mockResolvedValueOnce({rows:[{recorded:true}]});
  await createGooglePublicationTurnHandler({} as never)(job as never,{query} as never,{workerId:'worker-native'});
  expect(retomada.run).toHaveBeenCalledOnce();const input=retomada.run.mock.calls[0]![4];
  expect(input.googlePublicationObservation).toEqual({reservaId:'reserva-native',revisao:revision});
  expect(JSON.stringify(input)).not.toContain('FORJADO');
  expect(query.mock.calls[0]![0]).toContain('fn_google_continuation_current');
  expect(query.mock.calls[0]![0]).toContain('a.organization_id=c.organization_id');
  expect(query.mock.calls[0]![0]).toContain('c.contact_id=$5');
 });
 it('lease/fronteira revogada encerra sem chamar agente nem usar payload',async()=>{
  const query=vi.fn(async()=>({rows:[{receipt:null,publication:{reservaId:'FORJADO',revisao:999}}]}));
  await createGooglePublicationTurnHandler({} as never)(job as never,{query} as never,{workerId:'worker-native'});
  expect(retomada.run).not.toHaveBeenCalled();expect(query).toHaveBeenCalledOnce();
 });
 it('falha humana real não recebe comprovação de publicação positiva',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{receipt:{conversation_id:'conv-native',channel_session_id:'channel-native',outcome:'human_required'},publication:{reservaId:'FORJADO',revisao:999}}]}).mockResolvedValueOnce({rows:[{recorded:true}]});
  await createGooglePublicationTurnHandler({} as never)(job as never,{query} as never,{workerId:'worker-native'});
  expect(retomada.run.mock.calls[0]![4].googlePublicationObservation).toBeUndefined();
 });
});
