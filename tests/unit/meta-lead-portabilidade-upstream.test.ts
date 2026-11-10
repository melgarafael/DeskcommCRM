import { describe, expect, it } from "vitest";

import { extrairAtribuicaoMeta } from "@/lib/channels/atribuicao-de-anuncio-oficial";
import { extrairAtribuicaoWaha } from "@/lib/waha/atribuicao-de-anuncio";
import { montaPayloadDoClone } from "@/lib/leads/clonar-para-funil";
import { buildContext } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  ancoraCtwaDaMensagem,
  ocultarProvaMetaNaResposta,
  removerProvaMetaLeadSubmitted,
} from "@/lib/leads/prova-meta-lead-submitted";

const clique = "ctwa-atual";
const prova = { platform: "meta_ads", source_type: "ad", ctwa_clid: clique };

describe("Feature A portada para a main oficial", () => {
  it("ancora somente o ctwa_clid explícito do referral inbound atual", () => {
    expect(
      ancoraCtwaDaMensagem(
        extrairAtribuicaoMeta({
          source_type: "ad",
          source_id: "anuncio-1",
          ctwa_clid: clique,
        }),
      ),
    ).toEqual({ meta_ctwa_message_v1: prova });
    expect(
      ancoraCtwaDaMensagem(
        extrairAtribuicaoMeta({
          source_type: "ad",
          source_id: "anuncio-1",
        }),
      ),
    ).toEqual({});
    expect(
      ancoraCtwaDaMensagem(
        extrairAtribuicaoMeta({
          source_type: "post",
          ctwa_clid: clique,
        }),
      ),
    ).toEqual({});
  });

  it("WAHA separa ctwaClid de sourceId", () => {
    const mensagem = (ad: Record<string, unknown>) => ({
      extendedTextMessage: { contextInfo: { externalAdReply: ad } },
    });
    expect(
      ancoraCtwaDaMensagem(
        extrairAtribuicaoWaha(
          mensagem({
            sourceType: "ad",
            sourceId: "anuncio-1",
            ctwaClid: clique,
          }),
        ),
      ),
    ).toEqual({ meta_ctwa_message_v1: prova });
    expect(
      ancoraCtwaDaMensagem(
        extrairAtribuicaoWaha(
          mensagem({
            sourceType: "ad",
            sourceId: "anuncio-1",
          }),
        ),
      ),
    ).toEqual({});
  });

  it("o clone usado pelo roteador e pela automação mantém origem comum e remove a prova", () => {
    const payload = montaPayloadDoClone(
      {
        id: "11111111-1111-4111-8111-111111111111",
        pipeline_id: "22222222-2222-4222-8222-222222222222",
        status: "open",
        title: "Negócio de origem",
        source_metadata: { campanha: "ads", meta_capi_lead_birth_v1: prova },
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        pipeline_id: "44444444-4444-4444-8444-444444444444",
        position: 0,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
    );
    expect(payload.source_metadata).toEqual({
      campanha: "ads",
      clonado_de: {
        lead_id: "11111111-1111-4111-8111-111111111111",
        pipeline_id: "22222222-2222-4222-8222-222222222222",
      },
    });
  });

  it("inputs genéricos perdem somente a chave reservada", () => {
    expect(
      removerProvaMetaLeadSubmitted({ campanha: "ads", meta_capi_lead_birth_v1: prova }),
    ).toEqual({ campanha: "ads" });
  });

  it("respostas de negócio omitem a prova sem alterar a linha interna", () => {
    const lead = {
      id: "11111111-1111-4111-8111-111111111111",
      source_metadata: { campanha: "ads", meta_capi_lead_birth_v1: prova },
    };
    expect(ocultarProvaMetaNaResposta(lead).source_metadata).toEqual({ campanha: "ads" });
    expect(lead.source_metadata).toHaveProperty("meta_capi_lead_birth_v1");
  });

  it("o contexto das automações não entrega a prova reservada às ações", async () => {
    const lead = {
      id: "11111111-1111-4111-8111-111111111111",
      contact_id: null,
      source_metadata: { campanha: "ads", meta_capi_lead_birth_v1: prova },
    };
    const filtros: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return query;
      },
      maybeSingle: async () => ({ data: lead }),
    };
    const admin = { from: () => query };
    const evento = {
      organization_id: "22222222-2222-4222-8222-222222222222",
      entity_kind: "crm_lead",
      entity_id: lead.id,
      event_type: "lead.created",
      payload: {},
    } as EventRow;

    const contexto = await buildContext(admin as never, evento);
    expect(contexto.lead).toMatchObject({ source_metadata: { campanha: "ads" } });
    expect(filtros).toContainEqual(["organization_id", evento.organization_id]);
    expect(lead.source_metadata).toHaveProperty("meta_capi_lead_birth_v1");
  });
});
