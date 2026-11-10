/**
 * O CORPO que sai para a Meta quando a venda é de um lead de FORMULÁRIO (#2317).
 *
 * Os testes do PR provavam a GRAVAÇÃO da atribuição no contato; este prova o
 * ENVIO — a lacuna que o mantenedor mediu no CR do #2832. A corrente é a de
 * produção, sem atalho: `mapInboundPayload` + `extrairAtribuicaoDoInbound` →
 * `estamparAtribuicaoDoContato` (é dela que sai o `source_metadata` real) →
 * `lerAtribuicao` → `transporteMeta.enviar` com `fetch` dublado.
 *
 * O defeito vigiado: o clique da landing page (`fbclid`, ou a string `fb.1.…`
 * inteira quando só vem o `fbc`) ia como `user_data.ctwa_clid` com
 * `action_source: business_messaging` — o formato do anúncio
 * clique-pro-WhatsApp. A venda não fica atribuída, e a resposta pode ser 200.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { lerAtribuicao } from "@/lib/conversoes/leitura-da-atribuicao";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { INTERNOS, transporteMeta } from "@/lib/plataformas-de-anuncio/meta/conversions";
import type { ConversaoOffline } from "@/lib/plataformas-de-anuncio/types";
import { extrairAtribuicaoDoInbound, mapInboundPayload } from "@/lib/webhooks/inbound";

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";
const CONTATO = "33333333-3333-3333-3333-333333333333";

const credencial = { datasetId: "123456789012345", accessToken: "tok", testEventCode: null };

interface EventoNoFio {
  event_name: string;
  action_source: string;
  messaging_channel?: string;
  user_data: { ctwa_clid?: string; fbc?: string; fbp?: string; ph?: string[] };
  custom_data?: { value: number; currency: string };
}

const TELEFONE_DO_FORMULARIO = "+55 (11) 98888-7777";
const PHONE = "5511988887777";

/** O `contacts` que o worker leria, com o metadata que a estampa gravou. */
function adminDeContato(contato: { phone_number: string; source_metadata: unknown }) {
  const construtor = {
    select: () => construtor,
    eq: () => construtor,
    maybeSingle: async () => ({ data: contato, error: null }),
  };
  return { from: () => construtor };
}

/** Corre a corrente inteira de produção e devolve o evento que chegou ao fio. */
async function eventoDoFormulario(payload: Record<string, unknown>): Promise<EventoNoFio> {
  // O mapa do formulário é o primeiro passo real: as chaves de anúncio têm de
  // sair de `custom_fields` para `source_metadata`, senão não há o que estampar.
  const entrada = mapInboundPayload(payload);
  const atribuicao = extrairAtribuicaoDoInbound(payload);
  expect(atribuicao).not.toBeNull();

  const rpc = vi.fn().mockResolvedValue({ error: null });
  await estamparAtribuicaoDoContato({ rpc } as never, ORG, CONTATO, atribuicao!);

  // O metadata REAL que a função do banco recebe — não uma cópia à mão do
  // formato, que envelheceria calada no dia em que a estampa mudasse.
  const metadata = (rpc.mock.calls[0]?.[1] as { p_metadata: Record<string, unknown> }).p_metadata;

  const leitura = await lerAtribuicao(
    adminDeContato({
      phone_number: `+${entrada.phone ?? PHONE}`,
      source_metadata: metadata,
    }) as never,
    ORG,
    CONTATO,
  );
  expect(leitura.temAtribuicao).toBe(true);
  if (!leitura.temAtribuicao) throw new Error("sem atribuição");

  const conversao: ConversaoOffline = {
    organizationId: ORG,
    leadId: LEAD,
    evento: "Purchase",
    eventoId: `${LEAD}:Purchase`,
    ocorridoEm: new Date(),
    cliqueDeOrigem: leitura.atribuicao.cliqueDeOrigem,
    identidadeDoNavegador: leitura.atribuicao.identidadeDoNavegador,
    telefone: leitura.atribuicao.telefone,
    valorCentavos: 497_00,
    moeda: "BRL",
  };

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response('{"events_received":1}', { status: 200 }));

  const resultado = await transporteMeta.enviar(credencial, conversao);
  expect(resultado.tipo).toBe("ok");

  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return (JSON.parse(String(init.body)) as { data: EventoNoFio[] }).data[0]!;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("a venda do lead de formulário sai com a identidade da PÁGINA", () => {
  it("só `fbclid`: sai `system_generated`, com `fbc` remontado, sem `ctwa_clid`", async () => {
    const ev = await eventoDoFormulario({
      name: "Ana",
      phone: TELEFONE_DO_FORMULARIO,
      fbclid: "IwAR_FORMULARIO",
      utm_source: "facebook",
    });

    expect(ev.action_source).toBe("system_generated");
    expect(ev.messaging_channel).toBeUndefined();
    // O defeito: o clique da página virando `ctwa_clid`.
    expect(ev.user_data.ctwa_clid).toBeUndefined();
    // Sem `fbc` no formulário, ele é remontado a partir do `fbclid` — é a
    // ÚNICA identidade de navegador que a Meta tem para casar esta venda.
    expect(ev.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR_FORMULARIO$/);
    expect(ev.user_data.fbp).toBeUndefined();
    expect(ev.user_data.ph).toEqual([INTERNOS.hash(PHONE)]);
    expect(ev.custom_data).toEqual({ value: 497, currency: "BRL" });
  });

  it("só `fbc`: o valor recebido vai inteiro no corpo, e não como `ctwa_clid`", async () => {
    const FBC = "fb.1.1770000000000.IwAR_FORMULARIO";
    const ev = await eventoDoFormulario({
      name: "Ana",
      phone: TELEFONE_DO_FORMULARIO,
      fbc: FBC,
      utm_source: "facebook",
    });

    expect(ev.action_source).toBe("system_generated");
    expect(ev.user_data.ctwa_clid).toBeUndefined();
    expect(ev.user_data.fbc).toBe(FBC);
    expect(ev.user_data.ph).toEqual([INTERNOS.hash(PHONE)]);
  });

  it("com `fbc` e `fbp`, os dois identificadores vão no corpo", async () => {
    const ev = await eventoDoFormulario({
      name: "Ana",
      phone: TELEFONE_DO_FORMULARIO,
      fbc: "fb.1.1770000000000.IwAR_FORMULARIO",
      fbp: "fb.1.1770000000000.987654321",
    });

    expect(ev.user_data.ctwa_clid).toBeUndefined();
    expect(ev.user_data.fbc).toBe("fb.1.1770000000000.IwAR_FORMULARIO");
    expect(ev.user_data.fbp).toBe("fb.1.1770000000000.987654321");
  });

  it("o `gclid` do Google continua no caminho de sempre — não vira identidade de página", async () => {
    const r = extrairAtribuicaoDoInbound({ gclid: "Cj0KCQjw-gclid", utm_source: "google" });
    expect(r).toMatchObject({ plataforma: "google_ads", sourceId: "Cj0KCQjw-gclid" });
    // Sem `identidadeDoNavegador`: é ela que marca a captura na página, e o
    // Google não tem cookie da Meta para mandar.
    expect(r?.identidadeDoNavegador).toBeUndefined();
  });
});
