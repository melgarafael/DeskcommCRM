/**
 * "MENSAGEM PARA A EQUIPE" PELO NÚMERO QUE SÓ MANDA MODELO (migration 9094).
 *
 * O caso real que motivou: uma organização cujo único número estável é o
 * oficial quer, a cada lead novo do formulário, um WhatsApp no celular da
 * equipe. Antes, a ação pulava com `canal_nao_aceita_texto_livre` em TODO
 * disparo — e não havia configuração que a fizesse sair.
 *
 * O que este arquivo prova:
 *  - sem modelo escolhido em Avisos, o pulo continua com o MESMO motivo de
 *    antes (nada mudou para quem não configurou);
 *  - com o modelo escolhido e aprovado, o resumo sai pelo transporte de
 *    sempre, DENTRO do modelo;
 *  - o modelo que deixou de servir (a regra única diz "não") volta a pular —
 *    a pergunta é feita no disparo, não só ao salvar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const transporte = vi.hoisted(() => ({
  configurado: vi.fn(async () => true),
  resolveDestino: vi.fn(async (_org: string, _canal: unknown, telefone: string) => telefone),
  envia: vi.fn(async () => ({ externalId: "modelo.TESTE" })),
}));
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: vi.fn(async () => transporte),
}));
const pacing = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ liberado: true })),
  registraEnvio: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: vi.fn(async () => pacing),
}));
// O número da equipe é o oficial: fora da janela, só modelo.
vi.mock("@/lib/channels/capabilities", () => ({
  capabilitiesOf: vi.fn(() => ({ freeformOutsideWindow: false })),
}));
const carregarModeloDoAviso = vi.hoisted(() => vi.fn());
vi.mock("@/lib/escalacao/modelo-do-aviso", () => ({ carregarModeloDoAviso }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/notify-team";
import type { ActionCtx } from "@/lib/automation/types";
import type { ModeloDoAviso } from "@/lib/escalacao/modelo-do-aviso";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CANAL = "55555555-5555-4555-8555-555555555555";
const MODELO_ID = "66666666-6666-4666-8666-666666666666";
const DESTINO = "+5531900000001";

const MODELO: ModeloDoAviso = {
  id: MODELO_ID,
  name: "aviso_da_equipe",
  language: "pt_BR",
  chave: "1",
  corpo: "🔔 Aviso\n\n{{1}}\n\nAbra o CRM.",
};

function adminFake(tabelas: Record<string, Array<Record<string, unknown>>>): ActionCtx["admin"] {
  function builder(nome: string) {
    const filtros: Array<[string, unknown]> = [];
    const consulta = {
      select: () => consulta,
      eq: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return consulta;
      },
      is: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return consulta;
      },
      order: () => consulta,
      limit: () => consulta,
      maybeSingle: async () => {
        const acha = (tabelas[nome] ?? []).find((linha) => filtros.every(([c, v]) => linha[c] === v));
        return { data: acha ?? null, error: null };
      },
    };
    return consulta;
  }
  return { from: (nome: string) => builder(nome) } as unknown as ActionCtx["admin"];
}

function tabelas(config: Record<string, unknown>) {
  return {
    organizations: [{ id: ORG, locale: "pt-BR" }],
    config_aviso_de_caso: [
      { organization_id: ORG, channel_session_id: CANAL, telefone_destino: DESTINO, ligado: true, ...config },
    ],
    channel_sessions: [
      { id: CANAL, organization_id: ORG, status: "WORKING", archived_at: null, provider: "oficial-do-teste", metadata: {} },
    ],
  };
}

function ctx(admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "rule-1",
    ruleName: "Formulário: aviso à equipe",
    event: {} as ActionCtx["event"],
    context: {
      lead: { id: LEAD, title: "Teste", status: "open", contact_id: CONTATO },
      contact: { name: "Ana Teste", display_name: "Ana Teste", phone_number: "+5531900000002" },
    },
    requestId: "req-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transporte.configurado.mockResolvedValue(true);
  transporte.envia.mockResolvedValue({ externalId: "modelo.TESTE" });
});

describe("notify_team — número oficial", () => {
  it("sem modelo escolhido, pula com o MESMO motivo de antes, sem tocar a rede", async () => {
    const r = await getAction("notify_team")!.execute(ctx(adminFake(tabelas({ modelo_id: null }))), {
      canal: "whatsapp",
    });
    expect(r).toMatchObject({ status: "skipped", detail: { reason: "canal_nao_aceita_texto_livre" } });
    expect(carregarModeloDoAviso).not.toHaveBeenCalled();
    expect(transporte.envia).not.toHaveBeenCalled();
  });

  it("com o modelo aprovado escolhido em Avisos, o resumo sai DENTRO do modelo", async () => {
    carregarModeloDoAviso.mockResolvedValue({ ok: true, modelo: MODELO });
    const r = await getAction("notify_team")!.execute(ctx(adminFake(tabelas({ modelo_id: MODELO_ID }))), {
      canal: "whatsapp",
    });
    expect(r).toMatchObject({
      status: "success",
      detail: { reason: "whatsapp_enviado", canal: "whatsapp", modelo: "aviso_da_equipe" },
    });
    // A regra única conferiu o modelo DESTA conexão, desta organização.
    expect(carregarModeloDoAviso).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      channelSessionId: CANAL,
      modeloId: MODELO_ID,
    });
    expect(transporte.envia).toHaveBeenCalledTimes(1);
    const [, , destino, corpo, opcoes] = transporte.envia.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string,
      { modelo: ModeloDoAviso },
    ];
    expect(destino).toBe(DESTINO);
    expect(corpo).toContain("Ana");
    expect(opcoes).toEqual({ modelo: MODELO });
    // O envio entra no ledger como qualquer aviso: teto diário e espaçamento.
    expect(pacing.registraEnvio).toHaveBeenCalledTimes(1);
  });

  it("o modelo que deixou de servir volta a pular — conferido no disparo", async () => {
    carregarModeloDoAviso.mockResolvedValue({ ok: false, motivo: "nao_aprovado" });
    const r = await getAction("notify_team")!.execute(ctx(adminFake(tabelas({ modelo_id: MODELO_ID }))), {
      canal: "whatsapp",
    });
    expect(r).toMatchObject({ status: "skipped", detail: { reason: "canal_nao_aceita_texto_livre" } });
    expect(transporte.envia).not.toHaveBeenCalled();
  });
});
