/**
 * A RÉGUA POR ETAPA PASSA A SER OBEDECIDA (#3603, fatia 4).
 *
 * A tela de Configurações → Entrada e follow-up grava, por etapa,
 * `settings.followup_por_etapa[stage_id] = { ativa, prazo_horas, mensagem }`.
 * Até esta fatia nenhum motor lia essa chave: quem decidia follow-up de etapa
 * parada era só `automation_rules.trigger_config.dias`. O que este arquivo mede
 * é o encontro dos dois — regra e régua — na varredura
 * `app/api/v1/cron/lead-time-triggers`, com o código de verdade e banco de
 * mentira (um recorte honesto do PostgREST: `eq`, `in`, `not`, `gt`, `lte`,
 * `order`, `limit`).
 *
 * ─── A PRECEDÊNCIA QUE SE PROVA AQUI ───
 *
 *   1. régua ATIVA na etapa do negócio → `prazo_horas` da régua vence os `dias`
 *      da regra, para MAIS e para MENOS; a `mensagem` da régua viaja no payload;
 *   2. régua INATIVA → cai na regra, como se a chave não existisse;
 *   3. etapa SEM régua → comportamento de hoje, byte a byte (as chaves do
 *      payload são as de hoje);
 *   4. régua ativa com `prazo_horas` nulo é configuração incompleta (a action
 *      recusa): cai na regra e o motivo aparece em `pulados`.
 *
 * ─── POR QUE O PAYLOAD É CONFERIDO CHAVE A CHAVE ───
 *
 * "Byte a byte igual onde não há régua" é o critério de retrocompatibilidade.
 * `toEqual` sobre o payload inteiro é o que impede um campo novo de nascer em
 * toda emissão sem ninguém notar — o consumidor (motor) lê esse objeto.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dubles = vi.hoisted(() => ({
  auditar: vi.fn(async () => undefined),
  adminAtual: { valor: null as unknown },
  protecao: vi.fn(async () => new Map<string, { adiar: boolean }>()),
}));

vi.mock("@/lib/audit", () => ({ audit: dubles.auditar }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dubles.adminAtual.valor }));
vi.mock("@/lib/agenda/protecao-followup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agenda/protecao-followup")>()),
  protecaoAgendaSupabase: dubles.protecao,
}));

import { GET as varrerTempo } from "@/app/api/v1/cron/lead-time-triggers/route";
import { GATILHO_ETAPA_PARADA } from "@/lib/automation/gatilhos-de-tempo";
import { env } from "@/lib/env";

type Linha = Record<string, unknown>;

const ORG = "bbbbbbbb-0000-4000-8000-00000000000b";
const REGRA = "22222222-0000-4000-8000-000000000002";
const FUNIL = "ffffffff-0000-4000-8000-0000000000f1";
const OUTRO_FUNIL = "ffffffff-0000-4000-8000-0000000000f2";
const ETAPA_COM_REGUA = "55555555-0000-4000-8000-000000000051";
const ETAPA_SEM_REGUA = "55555555-0000-4000-8000-000000000052";
const DONO = "99999999-0000-4000-8000-000000000009";
const MENSAGEM = "Oi! Podemos tirar suas dúvidas por aqui?";

const HORA = 3_600_000;
const DIA = 86_400_000;

function idDe(prefixo: string, n: number): string {
  return `${prefixo}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** O caminho do PostgREST: `payload->>rule_id`. */
function valorNoCaminho(linha: Linha, caminho: string): unknown {
  let atual: unknown = linha;
  for (const parte of caminho.split("->>")) {
    if (atual === null || typeof atual !== "object") return undefined;
    atual = (atual as Linha)[parte];
  }
  return atual;
}

class MundoFalso {
  readonly eventos: Linha[] = [];

  constructor(readonly tabelas: Record<string, Linha[]>) {}

  from(tabela: string): ConsultaFalsa {
    return new ConsultaFalsa(this, tabela);
  }

  async rpc(nome: string, args: Linha): Promise<{ data: null; error: null }> {
    if (nome === "emit_event") {
      this.eventos.push(args);
      // O RPC de verdade grava no `event_log`: a trava mora lá.
      this.linhas("event_log").push({
        organization_id: args.p_organization_id,
        event_type: args.p_event_type,
        entity_id: args.p_entity_id,
        payload: args.p_payload,
      });
    }
    return { data: null, error: null };
  }

  linhas(tabela: string): Linha[] {
    if (!this.tabelas[tabela]) this.tabelas[tabela] = [];
    return this.tabelas[tabela]!;
  }
}

class ConsultaFalsa implements PromiseLike<{ data: Linha[] | null; error: null }> {
  private filtros: Array<(l: Linha) => boolean> = [];
  private teto: number | null = null;

  constructor(
    private readonly mundo: MundoFalso,
    private readonly tabela: string,
  ) {}

  select(): this {
    return this;
  }

  eq(caminho: string, valor: unknown): this {
    this.filtros.push((l) => valorNoCaminho(l, caminho) === valor);
    return this;
  }

  in(caminho: string, valores: readonly unknown[]): this {
    this.filtros.push((l) => valores.includes(valorNoCaminho(l, caminho)));
    return this;
  }

  not(caminho: string, op: string, valor: unknown): this {
    this.filtros.push((l) => (op === "is" && valor === null ? valorNoCaminho(l, caminho) != null : true));
    return this;
  }

  gt(caminho: string, valor: unknown): this {
    this.filtros.push((l) => String(valorNoCaminho(l, caminho)) > String(valor));
    return this;
  }

  /** O corte: `stage_changed_at <= agora - N`. */
  lte(caminho: string, valor: unknown): this {
    this.filtros.push((l) => {
      const atual = valorNoCaminho(l, caminho);
      return typeof atual === "string" && typeof valor === "string" && atual <= valor;
    });
    return this;
  }

  order(): this {
    return this;
  }

  limit(n: number): this {
    this.teto = n;
    return this;
  }

  then<TResult>(
    onfulfilled?: ((v: { data: Linha[] | null; error: null }) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    const casam = this.mundo.linhas(this.tabela).filter((l) => this.filtros.every((f) => f(l)));
    const data = this.teto === null ? casam : casam.slice(0, this.teto);
    return Promise.resolve({ data, error: null }).then(
      onfulfilled ?? ((v) => v as unknown as TResult),
    );
  }
}

let mundo: MundoFalso;

function regraDe(trigger_config: Linha): Linha {
  return {
    id: REGRA,
    organization_id: ORG,
    trigger_event: GATILHO_ETAPA_PARADA,
    is_active: true,
    trigger_config,
  };
}

/** Negócio parado há N HORAS na etapa dada. */
function leadParado(n: number, etapa: string, horas: number, over: Linha = {}): Linha {
  const paradoDesde = new Date(Date.now() - horas * HORA).toISOString();
  return {
    id: idDe("eeeeeeee", n),
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: etapa,
    status: "open",
    title: `Negócio ${n}`,
    tags: [],
    contact_id: idDe("dddddddd", n),
    owner_user_id: DONO,
    created_at: new Date(Date.now() - 20 * DIA).toISOString(),
    stage_changed_at: paradoDesde,
    custom_fields: {},
    ...over,
  };
}

function mapaDaRegua(entradas: Record<string, Linha>): Linha {
  return entradas;
}

async function varrer(): Promise<{ status: number; data: Linha }> {
  const req = new NextRequest("http://localhost/api/v1/cron/lead-time-triggers", {
    headers: { authorization: "Bearer segredo_do_cron" },
  });
  const res = await varrerTempo(req);
  const corpo = (await res.json()) as { data: Linha };
  return { status: res.status, data: corpo.data ?? {} };
}

const emitidos = () => mundo.eventos.filter((e) => e.p_event_type === GATILHO_ETAPA_PARADA);

beforeEach(() => {
  vi.restoreAllMocks();
  dubles.auditar.mockClear();
  dubles.protecao.mockReset();
  dubles.protecao.mockResolvedValue(new Map());
  (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = "segredo_do_cron";
  mundo = new MundoFalso({
    automation_rules: [regraDe({ dias: 7, pipeline_id: null, stage_id: null, proteger_pela_agenda: false })],
    organizations: [{ id: ORG, settings: {} }],
    crm_leads: [],
    contacts: [],
    conversations: [],
    calendar_appointments: [],
    event_log: [],
  });
  dubles.adminAtual.valor = mundo;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("⭐ a régua ativa vence os dias da regra", () => {
  it("etapa com régua de 6 h dispara em 7 h — e não depois de 7 dias", async () => {
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM },
      }),
    };
    const lead = leadParado(1, ETAPA_COM_REGUA, 7);
    mundo.linhas("crm_leads").push(lead);

    const resposta = await varrer();

    expect(
      emitidos().map((e) => e.p_entity_id),
      "a etapa tem régua ativa de 6 h e o card está parado há 7 h; a varredura continuou esperando os 7 DIAS da regra — a tela grava e nada obedece",
    ).toEqual([lead.id]);
    expect(resposta.status).toBe(200);
    expect(resposta.data.emitidos).toBe(1);

    // O payload diz por que saiu agora: prazo e texto da régua.
    const payload = emitidos()[0]!.p_payload as Linha;
    expect(payload.prazo_horas, "o evento não carrega o prazo que o governou").toBe(6);
    expect(payload.mensagem, "o texto da régua não chegou ao evento").toBe(MENSAGEM);
    expect(payload.ancora, "a âncora continua sendo o carimbo da etapa").toBe(lead.stage_changed_at);
  });

  it("a janela de 6 h é a da régua, não 'qualquer card daquela etapa'", async () => {
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM },
      }),
    };
    mundo.linhas("crm_leads").push(leadParado(1, ETAPA_COM_REGUA, 3));

    const resposta = await varrer();

    expect(
      emitidos(),
      "card parado há 3 h disparou com régua de 6 h: a régua virou um 'liga/desliga' e não um prazo",
    ).toEqual([]);
    expect(resposta.data.emitidos).toBe(0);
  });

  it("régua MAIOR que a regra também vence: 720 h seguram um card de 2 dias numa regra de 1 dia", async () => {
    mundo.linhas("automation_rules").length = 0;
    mundo.linhas("automation_rules").push(
      regraDe({ dias: 1, pipeline_id: null, stage_id: null, proteger_pela_agenda: false }),
    );
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: 720, mensagem: MENSAGEM },
      }),
    };
    const lead = leadParado(1, ETAPA_COM_REGUA, 48);
    mundo.linhas("crm_leads").push(lead);

    await varrer();

    expect(
      emitidos(),
      "a régua de 720 h foi tratada como 'encurtar no máximo até a regra': a régua substitui o prazo, não o limita por baixo",
    ).toEqual([]);

    // E no dia 31 (720 h) ele sai, com o prazo da régua no payload.
    (mundo.linhas("crm_leads")[0] as Linha).stage_changed_at = new Date(Date.now() - 721 * HORA).toISOString();
    await varrer();
    expect(emitidos().map((e) => e.p_entity_id)).toEqual([lead.id]);
    expect((emitidos()[0]!.p_payload as Linha).prazo_horas).toBe(720);
  });
});

describe("⭐ régua inativa e etapa sem régua caem no comportamento de hoje", () => {
  it("régua inativa: 7 h não dispara, 8 dias dispara — e o payload é o de hoje", async () => {
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: false, prazo_horas: 6, mensagem: MENSAGEM },
      }),
    };
    const cedo = leadParado(1, ETAPA_COM_REGUA, 7);
    mundo.linhas("crm_leads").push(cedo);

    await varrer();
    expect(emitidos(), "régua desligada encurtou o prazo: a decisão da tela foi ignorada").toEqual([]);

    cedo.stage_changed_at = new Date(Date.now() - 8 * DIA).toISOString();
    await varrer();

    expect(emitidos().map((e) => e.p_entity_id)).toEqual([cedo.id]);
    expect(
      emitidos()[0]!.p_payload,
      "com a régua desligada o evento ganhou campo novo: o payload de hoje é o contrato com o motor",
    ).toEqual({
      rule_id: REGRA,
      dias: 7,
      ancora: cedo.stage_changed_at,
      etapa_desde: cedo.stage_changed_at,
    });
  });

  it("etapa sem régua nenhuma: a janela de dias é byte a byte a de hoje", async () => {
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM },
      }),
    };
    const parado = leadParado(1, ETAPA_SEM_REGUA, 6.9 * 24);
    mundo.linhas("crm_leads").push(parado);

    await varrer();
    expect(emitidos(), "6,9 dias virou disparo: a janela de 7 dias da regra encolheu").toEqual([]);

    parado.stage_changed_at = new Date(Date.now() - 7.5 * DIA).toISOString();
    await varrer();
    expect(emitidos().map((e) => e.p_entity_id)).toEqual([parado.id]);
    expect(emitidos()[0]!.p_payload).toEqual({
      rule_id: REGRA,
      dias: 7,
      ancora: parado.stage_changed_at,
      etapa_desde: parado.stage_changed_at,
    });
  });

  it("precedência no MESMO lote: só o card da etapa com régua sai; o da etapa sem régua espera", async () => {
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM },
      }),
    };
    const comRegua = leadParado(1, ETAPA_COM_REGUA, 7);
    const semRegua = leadParado(2, ETAPA_SEM_REGUA, 7, { pipeline_id: OUTRO_FUNIL });
    mundo.linhas("crm_leads").push(comRegua, semRegua);

    await varrer();

    expect(
      emitidos().map((e) => e.p_entity_id),
      "a régua de uma etapa vazou para a irmã: o prazo é POR ETAPA, não por organização",
    ).toEqual([comRegua.id]);
  });

  it("regra com stage_id explícito continua recortando — e obedece a régua daquela etapa", async () => {
    mundo.linhas("automation_rules").length = 0;
    mundo.linhas("automation_rules").push(
      regraDe({ dias: 7, pipeline_id: FUNIL, stage_id: ETAPA_COM_REGUA, proteger_pela_agenda: false }),
    );
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM },
      }),
    };
    const daEtapa = leadParado(1, ETAPA_COM_REGUA, 7);
    const deOutra = leadParado(2, ETAPA_SEM_REGUA, 7);
    mundo.linhas("crm_leads").push(daEtapa, deOutra);

    await varrer();

    expect(emitidos().map((e) => e.p_entity_id)).toEqual([daEtapa.id]);
  });
});

describe("⭐ configuração incompleta cai na regra e diz o motivo", () => {
  it("ativa com prazo nulo: 8 dias dispara pela regra, sem prazo no payload, e o motivo aparece", async () => {
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: null, mensagem: MENSAGEM },
      }),
    };
    const lead = leadParado(1, ETAPA_COM_REGUA, 8 * 24);
    mundo.linhas("crm_leads").push(lead);

    const resposta = await varrer();

    expect(
      emitidos().map((e) => e.p_entity_id),
      "a régua sem prazo derrubou a varredura em vez de cair na regra",
    ).toEqual([lead.id]);
    const payload = emitidos()[0]!.p_payload as Linha;
    expect(payload.prazo_horas).toBeUndefined();
    expect(payload.dias).toBe(7);
    expect(resposta.data.pulados, "o motivo da queda não foi registrado").toMatchObject({
      regua_incompleta: 1,
    });
  });

  it("jsonb torto não derruba a varredura: prazo em texto cai na regra", async () => {
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: { [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: "6", mensagem: 42 } },
    };
    const lead = leadParado(1, ETAPA_COM_REGUA, 7);
    mundo.linhas("crm_leads").push(lead);

    const resposta = await varrer();

    expect(resposta.status, "jsonb torto derrubou a rota").toBe(200);
    expect(emitidos(), "prazo em texto virou prazo: a leitura não é a mesma do contrato").toEqual([]);
  });
});

describe("proteção de agenda continua valendo no caminho da régua", () => {
  it("compromisso futuro adia o lembrete mesmo com régua ativa", async () => {
    mundo.linhas("automation_rules").length = 0;
    mundo.linhas("automation_rules").push(
      regraDe({ dias: 7, pipeline_id: null, stage_id: null, proteger_pela_agenda: true }),
    );
    mundo.linhas("organizations")[0]!.settings = {
      followup_por_etapa: mapaDaRegua({
        [ETAPA_COM_REGUA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM },
      }),
    };
    const lead = leadParado(1, ETAPA_COM_REGUA, 7);
    mundo.linhas("crm_leads").push(lead);
    dubles.protecao.mockResolvedValue(new Map([[lead.contact_id as string, { adiar: true }]]));

    const resposta = await varrer();

    expect(emitidos(), "a régua atropelou a proteção de agenda").toEqual([]);
    expect(resposta.data.pulados).toMatchObject({ agenda: 1 });
  });
});
