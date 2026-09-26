import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { conversaoDeQualificacaoHandler } from "@/lib/conversoes/qualificacao.handler";
import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";

const mocks = vi.hoisted(() => ({
  enviar: vi.fn(),
  consultar: vi.fn(),
  admin: vi.fn(),
  atribuicao: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/conversoes/leitura-da-atribuicao", () => ({ lerAtribuicao: mocks.atribuicao }));
vi.mock("@/lib/plataformas-de-anuncio/credenciais", () => ({
  lerCredencial: async () => ({
    ok: true,
    credencial: {
      testEventCode: null,
      google: { conversionActionId: "compra", api: "data_manager" },
    },
  }),
}));
vi.mock("@/lib/plataformas-de-anuncio/registry", () => ({
  ehPlataformaConhecida: (p: string) => ["google_ads", "meta_ads"].includes(p),
  transporteDe: () => ({ enviar: mocks.enviar, consultar: mocks.consultar }),
}));

const ETAPA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ocorridoEm = "2026-09-24T02:00:00.000Z";
const row: EventRow = {
  id: "e",
  entity_id: "lead",
  entity_kind: "crm_lead",
  organization_id: "org",
  event_type: "lead.stage_changed",
  payload: { to_stage_id: ETAPA },
  metadata: {},
  attempts: 0,
  consumed_by: [],
  created_at: ocorridoEm,
};
let registros: Record<string, Record<string, unknown>>;
let consultas: Array<{ tabela: string; filtros: Record<string, unknown> }>;
let config: Record<string, unknown> | null;
let erroLeitura: boolean;
let etapaExiste: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  registros = {};
  consultas = [];
  erroLeitura = false;
  etapaExiste = true;
  config = {
    google_qualification_stage_id: ETAPA,
    google_qualification_action_id: "42",
    google_qualification_configured_at: "2026-09-24T01:00:00Z",
  };
  mocks.enviar.mockResolvedValue({ tipo: "ok" });
  mocks.consultar.mockResolvedValue({ tipo: "ok" });
  mocks.atribuicao.mockResolvedValue({
    temAtribuicao: true,
    atribuicao: {
      plataforma: "google_ads",
      cliqueDeOrigem: "braid",
      telefone: null,
      identificadoresGoogle: { wbraid: "braid" },
    },
  });
  mocks.admin.mockReturnValue({
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      consultas.push({ tabela, filtros });
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return q;
        },
        maybeSingle: async () => {
          if (erroLeitura) return { data: null, error: { message: "offline" } };
          const data =
            tabela === "ad_conversion_dispatches"
              ? (registros[String(filtros.event_name)] ?? null)
              : tabela === "ad_platform_connections"
                ? config
                : tabela === "crm_stages"
                  ? etapaExiste
                    ? { id: ETAPA }
                    : null
                  : {
                      id: "lead",
                      status: "open",
                      contact_id: "contato",
                      value_cents: null,
                      currency: "BRL",
                      closed_at: null,
                    };
          return { data, error: null };
        },
        upsert: async (dado: Record<string, unknown>) => {
          registros[String(dado.event_name)] = { ...registros[String(dado.event_name)], ...dado };
          return { error: null };
        },
      };
      return q;
    },
  });
});

describe("qualificação por etapa", () => {
  it("envia sem valor na ação própria e preserva data, tipo de clique e organização", async () => {
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      consumer_key: "conversoes.qualificacao",
      status: "ok",
    });
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ google: expect.objectContaining({ conversionActionId: "42" }) }),
      expect.objectContaining({
        evento: "QualifiedLead",
        eventoId: "lead:QualifiedLead",
        valorCentavos: null,
        ocorridoEm: new Date(ocorridoEm),
        identificadoresGoogle: { wbraid: "braid" },
      }),
    );
    expect(registros.QualifiedLead).toMatchObject({
      event_occurred_at: ocorridoEm,
      google_action_id: "42",
      status: "sent",
    });
    expect(
      consultas.every(
        (q) =>
          (q.tabela === "ad_conversion_dispatches" && !Object.keys(q.filtros).length) ||
          q.filtros.organization_id === "org",
      ),
    ).toBe(true);
  });
  it("a mesma qualificação não é reenviada ao sair e voltar à etapa", async () => {
    await conversaoDeQualificacaoHandler.handle(row);
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "ja_enviada",
    });
    expect(mocks.enviar).toHaveBeenCalledOnce();
  });
  it("etapa não escolhida não qualifica", async () => {
    await conversaoDeQualificacaoHandler.handle({ ...row, payload: { to_stage_id: OUTRA } });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("etapa de outra organização não é aceita", async () => {
    etapaExiste = false;
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "etapa_invalida",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("não envia movimento anterior à ativação nem inventa horário ausente", async () => {
    expect(
      await conversaoDeQualificacaoHandler.handle({ ...row, created_at: "2026-09-23T00:00:00Z" }),
    ).toMatchObject({ detail: "anterior_a_configuracao" });
    expect(
      await conversaoDeQualificacaoHandler.handle({ ...row, created_at: undefined }),
    ).toMatchObject({ detail: "sem_etapa_ou_data" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("consulta protocolo na ação original mesmo depois de mudar a regra", async () => {
    mocks.enviar.mockResolvedValue({ tipo: "processando", protocolo: "p", detalhe: "aguardando" });
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    config = null;
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledOnce();
    expect(mocks.consultar).toHaveBeenCalledWith(
      expect.objectContaining({ google: expect.objectContaining({ conversionActionId: "42" }) }),
      "p",
    );
  });
  it("uma qualificação não aciona o consumidor de compra e vice-versa", async () => {
    expect(
      await conversaoDeVendaHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ detail: "outro_evento" });
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: {},
      }),
    ).toMatchObject({ detail: "outro_evento" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("não envia qualificação de origem Meta ao Google", async () => {
    mocks.atribuicao.mockResolvedValue({
      temAtribuicao: true,
      atribuicao: { plataforma: "meta_ads", cliqueDeOrigem: "ctwa", telefone: null },
    });
    await conversaoDeQualificacaoHandler.handle(row);
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("erro de leitura agenda nova tentativa em vez de autorizar envio", async () => {
    erroLeitura = true;
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
});
