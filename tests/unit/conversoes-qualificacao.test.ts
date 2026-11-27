import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { conversaoDeQualificacaoHandler } from "@/lib/conversoes/qualificacao.handler";
import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";

const mocks = vi.hoisted(() => ({
  enviar: vi.fn(),
  consultar: vi.fn(),
  admin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/plataformas-de-anuncio/credenciais", () => ({
  lerCredencial: async (
    _admin: unknown,
    _org: string,
    _plataforma: string,
    opcoes: {
      destinoGoogle?: { customerId: string; loginCustomerId: string | null };
    },
  ) =>
    motivoSemCredencial
      ? { ok: false, motivo: motivoSemCredencial }
      : {
          ok: true,
          credencial: {
            testEventCode: null,
            google: {
              customerId: opcoes.destinoGoogle?.customerId ?? contaGlobal,
              loginCustomerId: opcoes.destinoGoogle
                ? opcoes.destinoGoogle.loginCustomerId
                : "9876543210",
              conversionActionId: "compra",
              api: apiGlobal,
            },
          },
        },
}));
vi.mock("@/lib/plataformas-de-anuncio/registry", () => ({
  ehPlataformaConhecida: (p: string) => ["google_ads", "meta_ads"].includes(p),
  transporteDe: () => ({
    enviar: mocks.enviar,
    consultar: permiteConsultar ? mocks.consultar : undefined,
  }),
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
let regrasExtras: Array<Record<string, unknown>>;
let contaGlobal: string;
let apiGlobal: "google_ads" | "data_manager";
let falhaAoRegistrar: boolean;
let motivoSemCredencial: "sem_conexao" | null;
let erroLeitura: boolean;
let erroLeituraContas: boolean;
let contasDeRelatorio: Array<{ organization_id: string; customer_id: string }>;
let etapaExiste: boolean;
let links: Array<{ id: string }>;
let origemDoNegocio: Record<string, unknown>;
let origemDoContato: Record<string, unknown>;
let origensDosNegocios: Record<
  string,
  { source: string; source_metadata: Record<string, unknown> }
>;
let permiteConsultar: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  registros = {};
  consultas = [];
  erroLeitura = false;
  erroLeituraContas = false;
  contasDeRelatorio = [];
  etapaExiste = true;
  links = [];
  permiteConsultar = true;
  regrasExtras = [];
  contaGlobal = "1234567890";
  apiGlobal = "data_manager";
  falhaAoRegistrar = false;
  motivoSemCredencial = null;
  origemDoNegocio = {
    ad_platform: "google_ads",
    ad_source_id: "braid",
    ad_raw: { click_identifiers: { wbraid: "braid" } },
    google_customer_id: "123-456-7890",
  };
  origensDosNegocios = { lead: { source: "google_ads", source_metadata: origemDoNegocio } };
  origemDoContato = { ...origemDoNegocio };
  config = {
    id: "regra",
    stage_id: ETAPA,
    event_name: "QualifiedLead",
    label: "Lead qualificado",
    google_action_id: "42",
    category: "QUALIFIED_LEAD",
    included_in_conversions: true,
    channel: "todos",
    enabled: true,
    configured_at: "2026-09-24T01:00:00Z",
  };
  mocks.enviar.mockResolvedValue({ tipo: "ok" });
  mocks.consultar.mockResolvedValue({ tipo: "ok" });
  mocks.admin.mockReturnValue({
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      consultas.push({ tabela, filtros });
      let campos: string[] = [];
      const q = {
        select: (colunas: string) => {
          campos = colunas.split(",").map((campo) => campo.trim());
          return q;
        },
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return q;
        },
        neq: (k: string, v: unknown) => {
          filtros[`neq.${k}`] = v;
          return q;
        },
        limit: () =>
          tabela === "google_ads_reporting_accounts" || tabela === "google_ads_conversion_rules"
            ? q
            : { data: tabela === "crm_lead_links" ? links : [], error: null },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({
            data: [config, ...regrasExtras].filter((r) => r && r.stage_id === filtros.stage_id),
            error: erroLeitura ? { message: "offline" } : null,
          }).then(resolve),
        maybeSingle: async () => {
          if (erroLeitura) return { data: null, error: { message: "offline" } };
          if (tabela === "google_ads_reporting_accounts") {
            if (erroLeituraContas) return { data: null, error: { message: "offline" } };
            const data = contasDeRelatorio.find(
              (conta) =>
                (!filtros.organization_id || conta.organization_id === filtros.organization_id) &&
                conta.customer_id !== filtros["neq.customer_id"],
            );
            return { data: data ?? null, error: null };
          }
          if (tabela === "contacts")
            return { data: { phone_number: null, source_metadata: origemDoContato }, error: null };
          const data =
            tabela === "ad_conversion_dispatches"
              ? (registros[`${filtros.lead_id}:${filtros.event_name}`] ?? null)
              : tabela === "google_ads_conversion_rules"
                ? filtros["neq.google_customer_id"]
                  ? ([config, ...regrasExtras].find(
                      (r) =>
                        r &&
                        (!Object.hasOwn(filtros, "enabled") || r.enabled === filtros.enabled) &&
                        r.google_customer_id &&
                        r.google_customer_id !== filtros["neq.google_customer_id"],
                    ) ?? null)
                  : config && filtros.stage_id === config.stage_id
                    ? config
                    : null
                : tabela === "crm_stages"
                  ? etapaExiste
                    ? { id: ETAPA }
                    : null
                  : {
                      id: filtros.id,
                      ...(campos.includes("source_metadata") &&
                        origensDosNegocios[String(filtros.id)]),
                      status: "open",
                      contact_id: "contato",
                      value_cents: null,
                      currency: "BRL",
                      closed_at: null,
                    };
          return { data, error: null };
        },
        upsert: async (dado: Record<string, unknown>) => {
          if (falhaAoRegistrar) return { error: { message: "offline" } };
          const chave = `${dado.lead_id}:${dado.event_name}`;
          registros[chave] = { ...registros[chave], ...dado };
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
    expect(registros["lead:QualifiedLead"]).toMatchObject({
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
  it.each([
    { caso: "ausente", id: undefined },
    { caso: "inválido", id: "conta-1234567890" },
    { caso: "de uma conta filha diferente da conta de destino", id: "1112223333" },
  ])(
    "com uma conta cadastrada, envia ao destino configurado mesmo com o ID do clique $caso",
    async ({ id }) => {
      if (id === undefined) delete origemDoNegocio.google_customer_id;
      else origemDoNegocio.google_customer_id = id;
      contasDeRelatorio = [
        { organization_id: "org", customer_id: "1234567890" },
        { organization_id: "outra-org", customer_id: "1112223333" },
      ];
      expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "ok" });
      expect(mocks.enviar).toHaveBeenCalledOnce();
      expect(mocks.enviar).toHaveBeenCalledWith(
        expect.objectContaining({ google: expect.objectContaining({ customerId: "1234567890" }) }),
        expect.objectContaining({ identificadoresGoogle: { wbraid: "braid" } }),
      );
      expect(registros["lead:QualifiedLead"]).toMatchObject({ status: "sent" });
    },
  );
  it.each([undefined, "1112223333"])(
    "repete a leitura das contas antes de enviar se o banco estava indisponível (ID %s)",
    async (id) => {
      if (id === undefined) delete origemDoNegocio.google_customer_id;
      else origemDoNegocio.google_customer_id = id;
      erroLeituraContas = true;
      expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
      expect(mocks.enviar).not.toHaveBeenCalled();
      erroLeituraContas = false;
      expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "ok" });
      expect(mocks.enviar).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { caso: "ausente", conta: undefined, motivo: "conta_google_do_clique_ausente" },
    { caso: "inválida", conta: "conta-1234567890", motivo: "conta_google_do_clique_ausente" },
    {
      caso: "de outro anunciante",
      conta: "1112223333",
      motivo: "conta_google_do_clique_divergente",
    },
    {
      caso: "do gerente da conexão",
      conta: "9876543210",
      motivo: "conta_google_do_clique_divergente",
    },
  ])(
    "com duas contas cadastradas, registra o motivo e não envia quando a do clique é $caso",
    async ({ conta, motivo }) => {
      contasDeRelatorio = [{ organization_id: "org", customer_id: "1112223333" }];
      if (conta === undefined) delete origemDoNegocio.google_customer_id;
      else origemDoNegocio.google_customer_id = conta;
      origemDoNegocio.utm_campaign = "1234567890";
      expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
        status: "skipped",
        detail: motivo,
      });
      expect(mocks.enviar).not.toHaveBeenCalled();
      expect(registros["lead:QualifiedLead"]).toMatchObject({ status: "skipped", reason: motivo });
    },
  );
  it("dois negócios do mesmo contato enviam apenas o clique do negócio da conta de destino", async () => {
    contasDeRelatorio = [{ organization_id: "org", customer_id: "1112223333" }];
    origemDoContato.google_customer_id = "1112223333";
    origensDosNegocios = {
      externo: {
        source: "google_ads",
        source_metadata: {
          ad_platform: "google_ads",
          ad_source_id: "clique-externo",
          google_customer_id: "1112223333",
        },
      },
      local: {
        source: "google_ads",
        source_metadata: {
          ad_platform: "google_ads",
          ad_source_id: "clique-local",
          google_customer_id: "1234567890",
          ad_raw: { click_identifiers: { gbraid: "clique-local" } },
        },
      },
    };
    expect(
      await conversaoDeQualificacaoHandler.handle({ ...row, entity_id: "externo" }),
    ).toMatchObject({
      detail: "conta_google_do_clique_divergente",
    });
    expect(
      await conversaoDeQualificacaoHandler.handle({ ...row, entity_id: "local" }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledOnce();
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leadId: "local",
        cliqueDeOrigem: "clique-local",
        identificadoresGoogle: { gbraid: "clique-local" },
      }),
    );
  });
  it("o primeiro clique do contato não completa a origem do negócio com conta, mas sem clique", async () => {
    origensDosNegocios.lead = {
      source: "google_ads",
      source_metadata: { ad_platform: "google_ads", google_customer_id: "1234567890" },
    };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "skipped" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("um negócio sem clique próprio não herda o clique compatível do contato", async () => {
    origensDosNegocios.lead = { source: "whatsapp", source_metadata: {} };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "skipped" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("não envia se o clique do negócio diverge dos identificadores registrados nele", async () => {
    origemDoNegocio.ad_raw = { click_identifiers: { gclid: "outro-clique" } };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      status: "skipped",
      detail: "sem_atribuicao",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("reconfere a conta no reenvio de uma etapa com ação registrada e sem protocolo", async () => {
    contasDeRelatorio = [{ organization_id: "org", customer_id: "1112223333" }];
    const evento = `Etapa:${ETAPA}`;
    registros[`lead:${evento}`] = {
      platform: "google_ads",
      status: "error",
      google_action_id: "42",
      event_occurred_at: ocorridoEm,
    };
    origensDosNegocios.lead = {
      source: "google_ads",
      source_metadata: {
        ad_platform: "google_ads",
        ad_source_id: "outro-clique",
        google_customer_id: "1112223333",
      },
    };
    const tentativa = {
      ...row,
      event_type: "ad_conversion.retry_requested",
      payload: { event_name: evento },
    };
    expect(await conversaoDeQualificacaoHandler.handle(tentativa)).toMatchObject({
      status: "skipped",
      detail: "conta_google_do_clique_divergente",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(mocks.consultar).not.toHaveBeenCalled();
    expect(registros[`lead:${evento}`]).toMatchObject({
      status: "skipped",
      google_action_id: "42",
      event_occurred_at: ocorridoEm,
    });
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
    delete origemDoNegocio.google_customer_id;
    erroLeituraContas = true;
    consultas = [];
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledOnce();
    expect(consultas.some((q) => q.tabela === "google_ads_reporting_accounts")).toBe(false);
    expect(mocks.consultar).toHaveBeenCalledWith(
      expect.objectContaining({ google: expect.objectContaining({ conversionActionId: "42" }) }),
      "p",
    );
  });
  it("protocolo pendente nunca vira novo envio se o transporte não permite consultar", async () => {
    mocks.enviar.mockResolvedValue({ tipo: "processando", protocolo: "p", detalhe: "aguardando" });
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    permiteConsultar = false;
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ status: "retry" });
    expect(mocks.enviar).toHaveBeenCalledOnce();
    expect(mocks.consultar).not.toHaveBeenCalled();
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
    origensDosNegocios.lead = {
      source: "meta_ads",
      source_metadata: { ad_platform: "meta_ads", ad_source_id: "ctwa" },
    };
    await conversaoDeQualificacaoHandler.handle(row);
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(consultas.some((q) => q.tabela === "google_ads_reporting_accounts")).toBe(false);
  });
  it("erro de leitura agenda nova tentativa em vez de autorizar envio", async () => {
    erroLeitura = true;
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  it("regra nova de etapa usa o próprio nome de evento e a própria ação", async () => {
    config = { ...config!, event_name: `Etapa:${ETAPA}`, google_action_id: "77" };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ google: expect.objectContaining({ conversionActionId: "77" }) }),
      expect.objectContaining({ evento: `Etapa:${ETAPA}`, eventoId: `lead:Etapa:${ETAPA}` }),
    );
    expect(registros[`lead:Etapa:${ETAPA}`]).toMatchObject({
      status: "sent",
      google_action_id: "77",
    });
  });
  it("regra desligada não envia", async () => {
    config = { ...config!, enabled: false };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "etapa_sem_qualificacao",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("filtro de canal: só WhatsApp não envia negócio sem conversa vinculada", async () => {
    config = { ...config!, channel: "whatsapp" };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "canal_fora_da_regra",
    });
    links = [{ id: "vinculo" }];
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledOnce();
  });
  it("não faz POST quando não consegue persistir o destino antes da tentativa", async () => {
    config = { ...config!, google_customer_id: "1234567890", google_login_customer_id: null };
    falhaAoRegistrar = true;
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  it("duas contas na mesma etapa escolhem uma ação por clique sem fanout", async () => {
    config = { ...config!, google_customer_id: "1234567890", google_login_customer_id: null };
    regrasExtras = [
      { ...config, id: "segunda", google_customer_id: "1112223333", google_action_id: "77" },
    ];
    origensDosNegocios.outro = {
      source: "google_ads",
      source_metadata: {
        ad_platform: "google_ads",
        ad_source_id: "clique-outro",
        google_customer_id: "1112223333",
      },
    };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "ok" });
    expect(
      await conversaoDeQualificacaoHandler.handle({ ...row, entity_id: "outro" }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledTimes(2);
    expect(
      mocks.enviar.mock.calls.map(([credencial]) => [
        credencial.google.customerId,
        credencial.google.conversionActionId,
        credencial.google.loginCustomerId,
      ]),
    ).toEqual([
      ["1234567890", "42", null],
      ["1112223333", "77", null],
    ]);
    expect(registros["lead:QualifiedLead"]).toMatchObject({
      google_customer_id: "1234567890",
      google_login_customer_id: null,
      google_api: "data_manager",
      google_destination_explicit: true,
    });
    origemDoNegocio.google_customer_id = "1112223333";
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "ja_enviada",
    });
    expect(mocks.enviar).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "1112223333"])(
    "um destino explícito nunca aceita clique de outra conta ou sem conta (%s)",
    async (conta) => {
      config = { ...config!, google_customer_id: "1234567890", google_login_customer_id: null };
      origemDoNegocio.google_customer_id = conta;
      expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
        status: "skipped",
        detail: conta ? "conta_google_do_clique_divergente" : "conta_google_do_clique_ausente",
      });
      expect(mocks.enviar).not.toHaveBeenCalled();
      expect(registros["lead:QualifiedLead"]!.google_action_id).toBeUndefined();
    },
  );

  it("regras explícitas não criam pendências Google para origem orgânica ou Meta", async () => {
    config = { ...config!, google_customer_id: "1234567890" };
    origensDosNegocios.lead = { source: "whatsapp", source_metadata: {} };
    await conversaoDeQualificacaoHandler.handle(row);
    origensDosNegocios.lead = {
      source: "meta_ads",
      source_metadata: { ad_platform: "meta_ads", ad_source_id: "ctwa" },
    };
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "qualificacao_sem_origem_google",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(registros).toEqual({});
  });

  it("uma regra global não contorna outro destino de envio sem conta de relatório", async () => {
    regrasExtras = [
      { ...config!, id: "segunda", google_customer_id: "1112223333", google_action_id: "77" },
    ];
    delete origemDoNegocio.google_customer_id;
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      status: "skipped",
      detail: "conta_google_do_clique_ausente",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  // Revisão do @webtecnica no #5286 (achado 1): na etapa mista, o clique de uma
  // terceira conta cai na regra global em `selecionarRegraGoogle`. Quem recusa é o
  // envio (`motivoDeContaDaEtapaGoogle`), não a seleção — este caso prova isso.
  it("etapa mista: clique de uma terceira conta não sai pela global e fica registrado", async () => {
    regrasExtras = [
      { ...config!, id: "segunda", google_customer_id: "1112223333", google_action_id: "77" },
    ];
    origemDoNegocio.google_customer_id = "5556667777";
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      status: "skipped",
      detail: "conta_google_do_clique_divergente",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(registros["lead:QualifiedLead"]).toMatchObject({
      status: "skipped",
      reason: "conta_google_do_clique_divergente",
      google_destination_explicit: false,
    });
  });

  it("etapa mista: o clique da própria conta da conexão segue saindo pela global", async () => {
    regrasExtras = [
      { ...config!, id: "segunda", google_customer_id: "1112223333", google_action_id: "77" },
    ];
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.objectContaining({
        google: expect.objectContaining({ customerId: "1234567890", conversionActionId: "42" }),
      }),
      expect.anything(),
    );
    expect(registros["lead:QualifiedLead"]).toMatchObject({
      status: "sent",
      google_destination_explicit: false,
    });
  });

  // Achado 2 da mesma revisão: a etapa só com a global também não envia nem grava
  // linha para negócio sem clique ou vindo da Meta (`envio.handler.ts`, "Sai sem
  // linha no livro-razão"). Ganhar uma regra explícita não pode mudar isso.
  it.each([
    {
      caso: "sem atribuição",
      origem: { source: "whatsapp", source_metadata: {} },
      motivo: "sem_atribuicao",
    },
    {
      caso: "vindo da Meta",
      origem: {
        source: "meta_ads",
        source_metadata: { ad_platform: "meta_ads", ad_source_id: "ctwa" },
      },
      motivo: "qualificacao_sem_origem_google",
    },
  ])(
    "negócio $caso: a etapa mista tem o mesmo desfecho da etapa só com a global",
    async ({ origem, motivo }) => {
      origensDosNegocios.lead = origem;
      origemDoContato = { ...origem.source_metadata };
      const soGlobal = await conversaoDeQualificacaoHandler.handle(row);
      regrasExtras = [
        { ...config!, id: "segunda", google_customer_id: "1112223333", google_action_id: "77" },
      ];
      const mista = await conversaoDeQualificacaoHandler.handle(row);
      expect(soGlobal).toMatchObject({ status: "skipped", detail: motivo });
      expect(mista).toMatchObject({ status: "skipped", detail: motivo });
      expect(mocks.enviar).not.toHaveBeenCalled();
      expect(registros).toEqual({});
    },
  );

  it.each([undefined, "1112223333"])(
    "pausar a conta B não torna seu clique ou a conta ausente elegível para a global A (%s)",
    async (conta) => {
      regrasExtras = [
        {
          ...config!,
          id: "segunda",
          enabled: false,
          google_customer_id: "1112223333",
          google_action_id: "77",
        },
      ];
      origemDoNegocio.google_customer_id = conta;
      expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
        status: "skipped",
        detail: conta ? "conta_google_do_clique_divergente" : "conta_google_do_clique_ausente",
      });
      expect(mocks.enviar).not.toHaveBeenCalled();
      expect(registros["lead:QualifiedLead"]).toMatchObject({ status: "skipped" });
    },
  );

  it("retry conserva conta, MCC direto, API e ação mesmo após mudar regra e conta global", async () => {
    config = { ...config!, google_customer_id: "1234567890", google_login_customer_id: null };
    mocks.enviar.mockResolvedValueOnce({ tipo: "transitorio", detalhe: "rede" });
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    contaGlobal = "9999999999";
    apiGlobal = "google_ads";
    config = { ...config, google_customer_id: "1112223333", google_action_id: "777" };
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenLastCalledWith(
      expect.objectContaining({
        google: expect.objectContaining({
          customerId: "1234567890",
          loginCustomerId: null,
          conversionActionId: "42",
          api: "data_manager",
        }),
      }),
      expect.anything(),
    );
  });

  it("um movimento novo não envia o snapshot A pausado só porque a regra B está ativa", async () => {
    config = { ...config!, google_customer_id: "1234567890", google_login_customer_id: null };
    mocks.enviar.mockResolvedValueOnce({ tipo: "transitorio", detalhe: "rede" });
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    config = { ...config, enabled: false };
    regrasExtras = [
      {
        ...config,
        id: "B",
        google_customer_id: "1112223333",
        enabled: true,
        google_action_id: "77",
      },
    ];
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "etapa_sem_qualificacao",
    });
    expect(mocks.enviar).toHaveBeenCalledOnce();
    expect(mocks.consultar).not.toHaveBeenCalled();
  });

  it("um protocolo de A pausada continua só em consulta quando B está ativa", async () => {
    config = { ...config!, google_customer_id: "1234567890", google_login_customer_id: null };
    mocks.enviar.mockResolvedValueOnce({
      tipo: "processando",
      protocolo: "A",
      detalhe: "aguardando",
    });
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "retry" });
    config = { ...config, enabled: false };
    regrasExtras = [
      {
        ...config,
        id: "B",
        google_customer_id: "1112223333",
        enabled: true,
        google_action_id: "77",
      },
    ];
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledOnce();
    expect(mocks.consultar).toHaveBeenCalledWith(
      expect.objectContaining({ google: expect.objectContaining({ customerId: "1234567890" }) }),
      "A",
    );
  });

  it("o snapshot explícito mantém a igualdade de conta mesmo no retry de um único destino", async () => {
    config = { ...config!, google_customer_id: "1234567890", google_login_customer_id: null };
    mocks.enviar.mockResolvedValueOnce({ tipo: "transitorio", detalhe: "rede" });
    await conversaoDeQualificacaoHandler.handle(row);
    origemDoNegocio.google_customer_id = "1112223333";
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ detail: "conta_google_do_clique_divergente" });
    expect(mocks.enviar).toHaveBeenCalledOnce();
  });

  it("o snapshot global preserva o caso legado de conta filha no retry", async () => {
    origemDoNegocio.google_customer_id = "1112223333";
    mocks.enviar.mockResolvedValueOnce({ tipo: "transitorio", detalhe: "rede" });
    await conversaoDeQualificacaoHandler.handle(row);
    expect(registros["lead:QualifiedLead"]!.google_destination_explicit).toBe(false);
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledTimes(2);
  });

  it("retry resolve o transporte depois de conectar, preservando a identidade explícita conhecida", async () => {
    config = {
      ...config!,
      google_customer_id: "1112223333",
      google_login_customer_id: null,
      google_action_id: "77",
    };
    origemDoNegocio.google_customer_id = "1112223333";
    motivoSemCredencial = "sem_conexao";
    expect(await conversaoDeQualificacaoHandler.handle(row)).toMatchObject({
      detail: "sem_conexao",
    });
    expect(registros["lead:QualifiedLead"]).toMatchObject({
      google_customer_id: "1112223333",
      google_login_customer_id: null,
      google_destination_explicit: true,
      google_api: null,
      google_action_id: "77",
    });
    expect(mocks.enviar).not.toHaveBeenCalled();
    config = null;
    motivoSemCredencial = null;
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.objectContaining({
        google: expect.objectContaining({
          customerId: "1112223333",
          loginCustomerId: null,
          conversionActionId: "77",
          api: "data_manager",
        }),
      }),
      expect.anything(),
    );
    expect(registros["lead:QualifiedLead"]!.google_api).toBe("data_manager");
  });

  it("um protocolo legado sem destino registrado só é consultado na conexão global", async () => {
    registros["lead:QualifiedLead"] = {
      status: "skipped",
      platform: "google_ads",
      google_action_id: "42",
      event_occurred_at: ocorridoEm,
      remote_request_id: "legado",
      remote_requested_at: new Date().toISOString(),
    };
    config = null;
    expect(
      await conversaoDeQualificacaoHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: "QualifiedLead" },
      }),
    ).toMatchObject({ status: "ok" });
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(mocks.consultar).toHaveBeenCalledWith(
      expect.objectContaining({
        google: expect.objectContaining({ customerId: "1234567890" }),
      }),
      "legado",
    );
    expect(registros["lead:QualifiedLead"]!.google_customer_id).toBeUndefined();
  });

  it("o reenvio de etapa nova não aciona o consumidor de compra", async () => {
    expect(
      await conversaoDeVendaHandler.handle({
        ...row,
        event_type: "ad_conversion.retry_requested",
        payload: { event_name: `Etapa:${ETAPA}` },
      }),
    ).toMatchObject({ detail: "outro_evento" });
  });
});
