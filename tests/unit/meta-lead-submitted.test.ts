import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { conversaoDeNascimentoMetaHandler } from "@/lib/conversoes/nascimento-meta.handler";
import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import { conversaoDeQualificacaoHandler } from "@/lib/conversoes/qualificacao.handler";
import { conversaoDeEtapaMetaHandler } from "@/lib/conversoes/etapa-meta.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/plataformas-de-anuncio/credenciais", () => ({ lerCredencial: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const BIRTH = "2026-10-04T01:00:00.000Z";
const AGORA = "2026-10-04T01:01:00.000Z";
const ATIVACAO = "2026-10-03T01:00:00.000Z";

const proof = {
  platform: "meta_ads",
  source_type: "ad",
  ctwa_clid: "clique-desta-mensagem",
  message_id: MESSAGE,
  conversation_id: CONVERSATION,
  captured_at: BIRTH,
};

const row = (extra: Partial<EventRow> = {}): EventRow => ({
  id: "event-1",
  organization_id: ORG,
  event_type: "lead.created",
  entity_kind: "crm_lead",
  entity_id: LEAD,
  payload: { pipeline_id: "p", stage_id: "s", conversation_id: CONVERSATION },
  metadata: { source: "nascimento-da-conversa" },
  consumed_by: [],
  attempts: 0,
  created_at: AGORA,
  ...extra,
});

function admin(
  sourceMetadata: Record<string, unknown>,
  options: {
    ativacoes?: Array<string | null>;
    erroNaLeitura?: number;
    cliqueJaRegistrado?: boolean;
  } = {},
) {
  const rpc = vi.fn(async (name: string): Promise<{ data: unknown; error: null }> => {
    if (name === "fn_claim_meta_lead_submitted")
      return {
        data: {
          acquired: true,
          token: "66666666-6666-4666-8666-666666666666",
          status: "processing",
        },
        error: null,
      };
    return { data: true, error: null };
  });
  const filters: Array<[string, string, unknown]> = [];
  let leituraDaOrg = 0;
  const from = vi.fn((table: string) => {
    let orgConsultada: unknown;
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push([table, column, value]);
        if (table === "organizations" && column === "id") orgConsultada = value;
        return query;
      },
      maybeSingle: async () =>
        table === "organizations"
          ? (() => {
              leituraDaOrg++;
              if (options.erroNaLeitura === leituraDaOrg)
                return { data: null, error: { message: "falha sintética" } };
              if (orgConsultada !== ORG) return { data: null, error: null };
              const ativadaEm =
                options.ativacoes?.[Math.min(leituraDaOrg - 1, options.ativacoes.length - 1)] ??
                (options.ativacoes ? null : ATIVACAO);
              return { data: { meta_lead_birth_enabled_at: ativadaEm }, error: null };
            })()
          : {
              data:
                table === "meta_ctwa_click_dispatches"
                  ? options.cliqueJaRegistrado
                    ? { id: "clique-ja-registrado" }
                    : null
                  : table === "crm_leads"
                    ? {
                        id: LEAD,
                        contact_id: CONTACT,
                        created_at: BIRTH,
                        source_metadata: sourceMetadata,
                      }
                    : table === "contacts"
                      ? { phone_number: "+5511988887777" }
                      : table === "messages"
                        ? {
                            direction: "inbound",
                            contact_id: CONTACT,
                            conversation_id: CONVERSATION,
                            created_at: BIRTH,
                            metadata: {
                              meta_ctwa_message_v1: {
                                platform: "meta_ads",
                                source_type: "ad",
                                ctwa_clid: proof.ctwa_clid,
                              },
                            },
                          }
                        : null,
              error: null,
            },
    };
    return query;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as never);
  return { rpc, filters };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ now: new Date(AGORA), toFake: ["Date"] });
  vi.mocked(lerCredencial).mockResolvedValue({
    ok: true,
    credencial: {
      datasetId: "1234567890",
      accessToken: "token-do-teste",
      testEventCode: "TESTE-1",
      meta: { pageId: "9876543210", whatsappBusinessAccountId: null },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LeadSubmitted do nascimento causal", () => {
  it("nao reenvia o mesmo clique pelo consumidor legado de outro lead", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof }, { cliqueJaRegistrado: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "skipped",
      detail: "clique_assumido_pelo_novo_consumidor",
    });
    expect(db.filters).toContainEqual(["meta_ctwa_click_dispatches", "ctwa_clid", proof.ctwa_clid]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("organização sem ativação não cria claim nem POST", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof }, { ativacoes: [null] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "skipped",
      detail: "lead_submitted_desativado",
    });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ativação vale apenas para leads posteriores e não traz antigos de volta", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof }, { ativacoes: ["2026-10-04T02:00:00Z"] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "skipped",
      detail: "anterior_ativacao",
    });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("desativação após claim bloqueia o POST e assenta o ledger", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof }, { ativacoes: [ATIVACAO, null] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "skipped",
      detail: "lead_submitted_desativado",
    });
    expect(db.rpc).toHaveBeenCalledWith("fn_claim_meta_lead_submitted", expect.anything());
    expect(db.rpc).toHaveBeenCalledWith(
      "fn_settle_meta_lead_submitted",
      expect.objectContaining({ p_status: "skipped", p_reason: "lead_submitted_desativado" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reativação não recupera lead nascido antes do novo corte", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof }, { ativacoes: ["2026-10-04T01:00:30Z"] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(
      await conversaoDeNascimentoMetaHandler.handle(
        row({
          event_type: "ad_conversion.retry_requested",
          payload: { event_name: "LeadSubmitted" },
        }),
      ),
    ).toMatchObject({
      status: "skipped",
      detail: "anterior_ativacao",
    });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("erro de leitura da configuração agenda retry, sem tratar como desativação", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof }, { erroNaLeitura: 1 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "retry",
      detail: "leitura_da_ativacao",
    });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falha de leitura depois do claim libera lease e agenda retry", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof }, { erroNaLeitura: 2 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "retry",
      detail: "leitura_da_ativacao",
    });
    expect(db.rpc).toHaveBeenCalledWith(
      "fn_settle_meta_lead_submitted",
      expect.objectContaining({ p_status: "skipped", p_reason: "nova_tentativa_agendada" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("não usa ativação de outra organização", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outraOrg = "77777777-7777-4777-8777-777777777777";
    expect(
      await conversaoDeNascimentoMetaHandler.handle(row({ organization_id: outraOrg })),
    ).toMatchObject({
      status: "skipped",
      detail: "lead_submitted_desativado",
    });
    expect(db.filters).toContainEqual(["organizations", "id", outraOrg]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("usa o clique do lead, a data de nascimento e nenhum valor financeiro", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"events_received":1}', { status: 200 }));

    const result = await conversaoDeNascimentoMetaHandler.handle(row());

    expect(result.status).toBe("skipped"); // evento de teste não equivale a envio real
    expect(fetchSpy).toHaveBeenCalledOnce();
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    const event = body.data[0];
    expect(event).toMatchObject({
      event_name: "LeadSubmitted",
      event_id: `${LEAD}:LeadSubmitted`,
      event_time: Date.parse(BIRTH) / 1000,
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: { ctwa_clid: proof.ctwa_clid, page_id: "9876543210" },
    });
    expect(event.custom_data).toBeUndefined();
    expect(body.test_event_code).toBe("TESTE-1");
    expect(db.filters).toContainEqual(["crm_leads", "organization_id", ORG]);
    expect(db.filters).toContainEqual(["messages", "organization_id", ORG]);
    expect(db.filters).toContainEqual(["contacts", "organization_id", ORG]);
    expect(db.rpc).toHaveBeenCalledWith(
      "fn_settle_meta_lead_submitted",
      expect.objectContaining({
        p_org: ORG,
        p_lead: LEAD,
        p_status: "skipped",
        p_reason: "evento_de_teste",
      }),
    );
  });

  it("recusa evento com mais de sete dias sem chamar a Meta", async () => {
    vi.setSystemTime(new Date(Date.parse(BIRTH) + 8 * 24 * 60 * 60 * 1000));
    const db = admin({ meta_capi_lead_birth_v1: proof });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "error",
      detail: "recusado_pela_plataforma",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledWith(
      "fn_settle_meta_lead_submitted",
      expect.objectContaining({
        p_status: "error",
        p_reason: "recusado_pela_plataforma",
        p_detail: expect.stringContaining("evento com 8 dias"),
      }),
    );
  });

  it.each([
    ["sem prova", {}],
    ["first-touch antigo", { ad_platform: "meta_ads", ad_source_id: "clique-antigo" }],
    ["UTM/site", { ad_platform: "site", utm_source: "instagram" }],
    ["só ad_id", { ad_id: "anuncio-123", source_id: "anuncio-123" }],
  ])("%s não chama Meta", async (_name, metadata) => {
    const db = admin(metadata);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await conversaoDeNascimentoMetaHandler.handle(row());
    expect(result).toMatchObject({ status: "skipped", detail: "sem_prova_causal" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("fn_claim_meta_lead_submitted", expect.anything());
  });

  it("prova com clique diferente da mensagem persistida falha fechada", async () => {
    const db = admin({ meta_capi_lead_birth_v1: { ...proof, ctwa_clid: "outro-clique" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "skipped",
      detail: "prova_nao_confere_com_mensagem",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("prova com horário diferente da mensagem persistida falha fechada", async () => {
    const db = admin({
      meta_capi_lead_birth_v1: { ...proof, captured_at: "2026-10-03T01:00:00.000Z" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "skipped",
      detail: "prova_nao_confere_com_mensagem",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("linha do ledger com plataforma ou event_id incompatível é erro explícito, sem HTTP", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof });
    db.rpc.mockResolvedValue({
      data: { acquired: false, status: "invalid_ledger" },
      error: null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await conversaoDeNascimentoMetaHandler.handle(row())).toMatchObject({
      status: "error",
      detail: "ledger_invalido",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falha transitória libera lease e reusa o mesmo event_id na tentativa seguinte", async () => {
    const db = admin({ meta_capi_lead_birth_v1: proof });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("indisponível", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"events_received":1}', { status: 200 }));
    expect((await conversaoDeNascimentoMetaHandler.handle(row())).status).toBe("retry");
    expect((await conversaoDeNascimentoMetaHandler.handle(row())).status).toBe("skipped");
    const ids = fetchSpy.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)).data[0].event_id,
    );
    expect(ids).toEqual([`${LEAD}:LeadSubmitted`, `${LEAD}:LeadSubmitted`]);
    expect(db.rpc).toHaveBeenCalledWith(
      "fn_settle_meta_lead_submitted",
      expect.objectContaining({ p_status: "skipped", p_reason: "nova_tentativa_agendada" }),
    );
  });

  it("ignora entity_kind legado e reenvio de outro evento", async () => {
    admin({ meta_capi_lead_birth_v1: proof });
    expect(
      (await conversaoDeNascimentoMetaHandler.handle(row({ entity_kind: "lead" }))).status,
    ).toBe("skipped");
    expect(
      (
        await conversaoDeNascimentoMetaHandler.handle(
          row({
            event_type: "ad_conversion.retry_requested",
            payload: { event_name: `MetaEtapa:${MESSAGE}` },
          }),
        )
      ).status,
    ).toBe("skipped");
  });

  it("reenvio do nascimento não aciona Purchase, QualifiedLead ou MetaEtapa", async () => {
    admin({});
    const retry = row({
      event_type: "ad_conversion.retry_requested",
      payload: { event_name: "LeadSubmitted" },
    });
    expect((await conversaoDeVendaHandler.handle(retry)).detail).toBe("outro_evento");
    expect((await conversaoDeQualificacaoHandler.handle(retry)).detail).toBe("outro_evento");
    expect((await conversaoDeEtapaMetaHandler.handle(retry)).detail).toBe("outro_evento");
  });
});
