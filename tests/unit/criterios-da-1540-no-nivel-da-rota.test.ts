/**
 * OS CRITÉRIOS DE ACEITE DA #1540 NO NÍVEL DA ROTA — e a janela de 200.
 *
 * O que a parte pura não alcança: quem varre, como o evento nasce, o que a
 * trava impede e o que a regra FAZ com o evento. Aqui o código que roda é o de
 * verdade — as duas rotas do cron e o motor — e o banco é de mentira (o mesmo
 * recorte do PostgREST que `data-do-funil-avisa-a-regra-certa.test.ts` usa, com
 * `gt`/`lte` porque os dois crons da #1540 filtram por cursor e por corte).
 *
 * ─── O DEFEITO DA JANELA (item 1) ───
 *
 * `limit(200)` sem cursor varre os 200 mais ANTIGOS e para ali. Com 201
 * negócios em silêncio, os 200 mais antigos voltam a ocupar a janela a cada
 * rodada como `ja_emitido` — e o mais novo nunca recebe o evento, sem erro e
 * sem log. Os dois testes marcados com ⭐ ficam VERMELHOS sem o conserto.
 *
 * ─── OS TRÊS CASOS PEDIDOS (item 4) ───
 *
 *  (a) uma tarefa por episódio de silêncio — rota → evento → motor → `crm_tasks`,
 *       e a segunda rodada não cria a segunda tarefa;
 *  (b) a agenda ligada bloqueando — `proteger_pela_agenda` recusa o lembrete;
 *  (c) `date_field_due` rearmando quando a data muda, e NÃO rearmando no legado
 *       do event_log que foi gravado antes da #1540, sem `valor`.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/criterios-da-1540-no-nivel-da-rota.test.ts
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Db } from "@/lib/db";
import type { EventRow } from "@/lib/event-log/dispatcher";

const dubles = vi.hoisted(() => ({
  auditar: vi.fn(async () => undefined),
  adminAtual: { valor: null as unknown },
  protecao: vi.fn(async () => new Map<string, { adiar: boolean }>()),
}));

vi.mock("@/lib/audit", () => ({ audit: dubles.auditar }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dubles.adminAtual.valor }));
// Só a proteção é dublê: o resto do módulo (as outras portas) é o de verdade,
// porque `register-all` importa as ações de mensagem, que importam ele.
vi.mock("@/lib/agenda/protecao-followup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agenda/protecao-followup")>()),
  protecaoAgendaSupabase: dubles.protecao,
}));
// Push de verdade gravaria em `web_push_subscriptions` no meio do teste.
vi.mock("@/lib/notifications/web_push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/web_push")>()),
  enviarPushAoUsuario: vi.fn(async () => undefined),
}));
// A tarefa automática passou a gravar por `lib/db` (#3715): a porta é dublada
// sobre o MESMO `MundoFalso`, então o caminho medido continua sendo
// rota → evento → motor → `crm_tasks` (e não um INSERT de mentira no vazio).
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  portaDaAplicacao: () => portaDoMundo(dubles.adminAtual.valor as MundoFalso),
}));

import "@/lib/automation/actions/register-all";
import { GET as varrerDataDoFunil } from "@/app/api/v1/cron/lead-date-field-due/route";
import { GET as varrerTempo } from "@/app/api/v1/cron/lead-time-triggers/route";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { GATILHO_DE_DATA_DO_FUNIL } from "@/lib/automation/gatilho-de-data-do-funil";
import { GATILHO_ETAPA_PARADA, GATILHO_SILENCIO } from "@/lib/automation/gatilhos-de-tempo";
import { env } from "@/lib/env";

type Linha = Record<string, unknown>;

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const REGRA = "11111111-0000-4000-8000-000000000001";
const FUNIL = "ffffffff-0000-4000-8000-00000000000f";
const ETAPA = "55555555-0000-4000-8000-000000000005";
const DONO = "99999999-0000-4000-8000-000000000009";
const CAMPO = "data_do_casamento";
/** 09:00 em São Paulo — a hora em que a `lead-date-field-due` age. */
const NOVE_DA_ORG = new Date("2026-02-12T12:00:00Z");

/** Ids ordenáveis: o cursor do PostgREST compara string, não número. */
function idDe(prefixo: string, n: number): string {
  return `${prefixo}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** O caminho do PostgREST: `custom_fields->>campo`, `payload->>rule_id`. */
function valorNoCaminho(linha: Linha, caminho: string): unknown {
  let atual: unknown = linha;
  for (const parte of caminho.split("->>")) {
    if (atual === null || typeof atual !== "object") return undefined;
    atual = (atual as Linha)[parte];
  }
  return atual;
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Um banco de mentira com a gramática que ESTAS rotas usam: igualdade, `in`,
 * `not … is`, `gt` (cursor), `lte` (corte), o `or` com wildcard do `like`,
 * lote e ordem. O `or` desonesto aqui deixaria a varredura verde sobre um
 * filtro quebrado, então ele casa de verdade.
 */
class MundoFalso {
  readonly eventos: Linha[] = [];
  readonly consultas: Array<{ tabela: string; caminho: string; valor: unknown }> = [];
  private proximo = 0;

  constructor(readonly tabelas: Record<string, Linha[]>) {}

  from(tabela: string): ConsultaFalsa {
    return new ConsultaFalsa(this, tabela);
  }

  async rpc(nome: string, args: Linha): Promise<{ data: null; error: null }> {
    if (nome === "emit_event") {
      this.eventos.push(args);
      // O RPC de verdade GRAVA no `event_log` — é lá que a trava mora. Sem
      // esta linha, a rodada seguinte não enxergaria a emissão anterior e todo
      // "só uma vez" do teste passaria por motivo falso.
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

  novoId(): string {
    this.proximo += 1;
    return `00000000-0000-4000-8000-${this.proximo.toString(16).padStart(12, "0")}`;
  }
}

class ConsultaFalsa implements PromiseLike<{ data: Linha[] | null; error: null }> {
  private filtros: Array<(l: Linha) => boolean> = [];
  private teto: number | null = null;
  private acao: "select" | "insert" | "update" = "select";
  private dados: Linha | null = null;

  constructor(
    private readonly mundo: MundoFalso,
    private readonly tabela: string,
  ) {}

  select(): this {
    return this;
  }

  insert(dados: Linha): this {
    this.acao = "insert";
    this.dados = dados;
    return this;
  }

  update(dados: Linha): this {
    this.acao = "update";
    this.dados = dados;
    return this;
  }

  eq(caminho: string, valor: unknown): this {
    this.mundo.consultas.push({ tabela: this.tabela, caminho, valor });
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

  /** O CURSOR do item 1: `id > último`. */
  gt(caminho: string, valor: unknown): this {
    this.filtros.push((l) => String(valorNoCaminho(l, caminho)) > String(valor));
    return this;
  }

  /** O corte da etapa parada: `stage_changed_at <= agora - N dias`. */
  lte(caminho: string, valor: unknown): this {
    this.filtros.push((l) => {
      const atual = valorNoCaminho(l, caminho);
      return typeof atual === "string" && typeof valor === "string" && atual <= valor;
    });
    return this;
  }

  or(expressao: string): this {
    const termos = expressao
      .split(",")
      .map((t) => /^([\w>-]+)\.(eq|like|ilike)\.(.*)$/.exec(t.trim()))
      .filter((m): m is RegExpExecArray => m !== null);
    this.filtros.push((l) =>
      termos.some((m) => {
        const valor = valorNoCaminho(l, m[1]!);
        if (typeof valor !== "string") return false;
        if (m[2] === "eq") return valor === m[3];
        const padrao = `^${m[3]!.split("*").map(escaparRegex).join(".*")}$`;
        return new RegExp(padrao).test(valor);
      }),
    );
    return this;
  }

  order(): this {
    return this;
  }

  limit(n: number): this {
    this.teto = n;
    return this;
  }

  async maybeSingle(): Promise<{ data: Linha | null; error: null }> {
    const { data } = await this.executar();
    return { data: data?.[0] ?? null, error: null };
  }

  then<TResult>(
    onfulfilled?: ((v: { data: Linha[] | null; error: null }) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    return this.executar().then(onfulfilled ?? ((v) => v as unknown as TResult));
  }

  private async executar(): Promise<{ data: Linha[] | null; error: null }> {
    const linhas = this.mundo.linhas(this.tabela);
    if (this.acao === "insert") {
      const nova = { id: this.mundo.novoId(), ...this.dados };
      linhas.push(nova);
      return { data: [nova], error: null };
    }
    const casam = linhas.filter((l) => this.filtros.every((f) => f(l)));
    if (this.acao === "update") for (const linha of casam) Object.assign(linha, this.dados);
    return { data: this.teto === null ? casam : casam.slice(0, this.teto), error: null };
  }
}

let mundo: MundoFalso;

/**
 * A PORTA de `lib/db` sobre o MESMO `MundoFalso`.
 *
 * `lib/tarefas` não fala mais PostgREST (#3715): a tarefa e a linha da timeline
 * saem por SQL. Em vez de deixar o teste medir um banco de mentira diferente do
 * que a rota usa, esta porta traduz as DUAS formas de instrução que o módulo
 * emite hoje — `select … where id = $1 [and organization_id = $2] limit 1` e
 * `insert into … (colunas) values ($1…$n) returning id` — para as tabelas do
 * `MundoFalso`. Se o SQL mudar de forma, o caso falha aqui em vez de passar por
 * motivo falso.
 */
function portaDoMundo(m: MundoFalso): Db {
  async function executar(sql: string, parametros: readonly unknown[]): Promise<Linha[]> {
    if (/^\s*insert into/i.test(sql)) {
      const tabela = /insert into\s+(\w+)/i.exec(sql)![1]!;
      const colunas = /\(([\s\S]*?)\)\s*values/i
        .exec(sql)![1]!
        .split(",")
        .map((c) => c.trim());
      const linha: Linha = {};
      colunas.forEach((coluna, i) => {
        linha[coluna] = parametros[i] ?? null;
      });
      if (tabela === "crm_tasks") linha.id = m.novoId();
      m.linhas(tabela).push(linha);
      return [linha];
    }

    const tabela = /from\s+(\w+)/i.exec(sql)![1]!;
    const [id, organizacao] = parametros;
    const achada = m
      .linhas(tabela)
      .filter((l) => l.id === id)
      .filter((l) => organizacao === undefined || l.organization_id === organizacao);
    return achada.slice(0, 1);
  }

  return {
    query: <T>(sql: string, parametros: readonly unknown[] = []) =>
      executar(sql, parametros) as Promise<T[]>,
    async queryOne(sql, parametros = []) {
      const [linha] = await executar(sql, parametros);
      return (linha ?? null) as never;
    },
  };
}

function regraDe(
  trigger_event: string,
  trigger_config: Linha,
  over: Linha = {},
): Linha {
  return {
    id: REGRA,
    organization_id: ORG,
    name: "Lembrete do ateliê",
    trigger_event,
    is_active: true,
    conditions: [],
    actions: [{ type: "create_task", config: { titulo: "Ligar para {{contact.name}}", vence_em_dias: 1, atribuir_a: "dono_do_lead", prioridade: "high" } }],
    trigger_config,
    run_count: 0,
    ...over,
  };
}

function leadSilencioso(n: number, agoraMs: number, over: Linha = {}): Linha {
  const nascido = new Date(agoraMs - 10 * 86_400_000 - n * 1000).toISOString();
  return {
    id: idDe("cccccccc", n),
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    status: "open",
    title: `Negócio ${n}`,
    tags: [],
    contact_id: idDe("dddddddd", n),
    owner_user_id: DONO,
    created_at: nascido,
    stage_changed_at: nascido,
    custom_fields: {},
    ...over,
  };
}

function contatoDe(n: number): Linha {
  return { id: idDe("dddddddd", n), organization_id: ORG, name: `Cliente ${n}`, display_name: null };
}

function eventosDoCron(tipo: string): Linha[] {
  return mundo.eventos.filter((e) => e.p_event_type === tipo);
}

function eventoComoRow(emitido: Linha): EventRow {
  return {
    id: "eeeeeeee-0000-4000-8000-00000000000e",
    organization_id: emitido.p_organization_id,
    event_type: emitido.p_event_type,
    entity_kind: emitido.p_entity_kind,
    entity_id: emitido.p_entity_id,
    payload: emitido.p_payload,
    metadata: emitido.p_metadata,
  } as unknown as EventRow;
}

async function rodarRota(
  rota: (req: NextRequest) => Promise<Response>,
  caminho: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = new NextRequest(`http://localhost${caminho}`, {
    headers: { authorization: "Bearer segredo_do_cron" },
  });
  const res = await rota(req);
  const corpo = (await res.json()) as { data: Record<string, unknown> };
  return { status: res.status, data: corpo.data ?? {} };
}

const varrerSilencio = () =>
  rodarRota(varrerTempo, "/api/v1/cron/lead-time-triggers");

/** A `lead-date-field-due` só age na hora da organização — o teste escolhe o dia. */
async function varrerData(quando: Date): Promise<{ status: number; data: Record<string, unknown> }> {
  vi.useFakeTimers();
  vi.setSystemTime(quando);
  try {
    return await rodarRota(varrerDataDoFunil, "/api/v1/cron/lead-date-field-due");
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  dubles.auditar.mockClear();
  dubles.protecao.mockReset();
  dubles.protecao.mockResolvedValue(new Map());
  (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = "segredo_do_cron";
  mundo = new MundoFalso({
    automation_rules: [regraDe(GATILHO_SILENCIO, { dias: 7, direcao: "qualquer", pipeline_id: null, proteger_pela_agenda: false })],
    organizations: [{ id: ORG, timezone: "America/Sao_Paulo" }],
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

describe("a janela de 200 dos gatilhos por tempo (item 1)", () => {
  it("⭐ silêncio: o 201º negócio recebe o evento mesmo com os 200 mais antigos já emitidos", async () => {
    const agora = Date.now();
    const leads = Array.from({ length: 201 }, (_, i) => leadSilencioso(i + 1, agora));
    mundo.linhas("crm_leads").push(...leads);
    for (const lead of leads.slice(0, 200)) {
      mundo.linhas("event_log").push({
        organization_id: ORG,
        event_type: GATILHO_SILENCIO,
        entity_id: lead.id,
        payload: { rule_id: REGRA, ancora: lead.created_at },
      });
    }

    const resposta = await varrerSilencio();

    expect(
      eventosDoCron(GATILHO_SILENCIO).map((e) => e.p_entity_id),
      "os 200 mais antigos (já emitidos) ocuparam a janela inteira e o mais novo ficou de fora — sem cursor, a varredura só enxerga os 200 primeiros",
    ).toEqual([leads[200]!.id]);
    expect(resposta.status).toBe(200);
    expect(resposta.data.emitidos).toBe(1);
  });

  it("⭐ etapa parada: o mesmo corte, no outro gatilho do par", async () => {
    mundo.linhas("automation_rules").length = 0;
    mundo.linhas("automation_rules").push(
      regraDe(GATILHO_ETAPA_PARADA, { dias: 7, pipeline_id: null, stage_id: null, proteger_pela_agenda: false }),
    );
    const agora = Date.now();
    const leads = Array.from({ length: 201 }, (_, i) => leadSilencioso(i + 1, agora));
    mundo.linhas("crm_leads").push(...leads);
    for (const lead of leads.slice(0, 200)) {
      mundo.linhas("event_log").push({
        organization_id: ORG,
        event_type: GATILHO_ETAPA_PARADA,
        entity_id: lead.id,
        payload: { rule_id: REGRA, ancora: lead.stage_changed_at },
      });
    }

    const resposta = await varrerSilencio();

    expect(
      eventosDoCron(GATILHO_ETAPA_PARADA).map((e) => e.p_entity_id),
      "a etapa parada tem o mesmo `limit` sem cursor: o card parado há mais tempo no fim da fila nunca sai",
    ).toEqual([leads[200]!.id]);
    expect(resposta.data.emitidos).toBe(1);
  });

  it("controle: sem trava nenhuma, o conjunto inteiro é examinado numa rodada só", async () => {
    const agora = Date.now();
    const leads = Array.from({ length: 205 }, (_, i) => leadSilencioso(i + 1, agora));
    mundo.linhas("crm_leads").push(...leads);

    const resposta = await varrerSilencio();

    expect(eventosDoCron(GATILHO_SILENCIO)).toHaveLength(205);
    expect(resposta.data.examinados).toBe(205);
  });
});

describe("os critérios de aceite da #1540 no nível da rota (item 4)", () => {
  it("⭐ (a) UMA tarefa por episódio de silêncio — e a tarefa entra na linha do tempo do lead", async () => {
    const agora = Date.now();
    const lead = leadSilencioso(1, agora);
    mundo.linhas("crm_leads").push(lead);
    mundo.linhas("contacts").push(contatoDe(1));

    await varrerSilencio();
    const [emitido] = eventosDoCron(GATILHO_SILENCIO);
    expect(emitido, "a varredura não emitiu o evento que a regra pediu").toBeDefined();

    await runAutomationForEvent(dubles.adminAtual.valor as SupabaseClient, eventoComoRow(emitido!));

    // Rodada seguinte: a trava (regra + negócio + ÂNCORA) segura o segundo aviso.
    await varrerSilencio();
    expect(
      eventosDoCron(GATILHO_SILENCIO),
      "a segunda rodada emitiu de novo: sem a âncora na chave, a mesma regra criaria tarefa a cada hora",
    ).toHaveLength(1);

    expect(
      mundo.linhas("crm_tasks").map((t) => t.title),
      "uma tarefa por episódio de silêncio — nem zero (o lembrete some), nem duas (vira ruído que ensina o time a ignorar)",
    ).toEqual(["Ligar para Cliente 1"]);

    expect(
      mundo.linhas("crm_lead_activities").map((a) => ({
        type: a.type,
        actor_kind: a.actor_kind,
        lead_id: a.lead_id,
      })),
      "a tarefa automática não aparece na linha do tempo do lead (item 3): o card do negócio ficaria parado sem sinal de que o sistema marcou um retorno",
    ).toEqual([{ type: "task_created", actor_kind: "system", lead_id: lead.id }]);
  });

  it("(b) a agenda ligada bloqueia o lembrete", async () => {
    const lead = leadSilencioso(1, Date.now());
    mundo.linhas("crm_leads").push(lead);
    mundo.linhas("automation_rules").length = 0;
    mundo.linhas("automation_rules").push(
      regraDe(GATILHO_SILENCIO, { dias: 7, direcao: "qualquer", pipeline_id: null, proteger_pela_agenda: true }),
    );
    dubles.protecao.mockResolvedValue(new Map([[lead.contact_id as string, { adiar: true }]]));

    const resposta = await varrerSilencio();

    expect(
      eventosDoCron(GATILHO_SILENCIO),
      "o negócio tem compromisso marcado e mesmo assim o lembrete saiu — `proteger_pela_agenda` é opt-in e estava ligado",
    ).toEqual([]);
    expect(resposta.data.emitidos).toBe(0);
    expect(resposta.data.pulados).toMatchObject({ agenda: 1 });
  });

  it("(c) `date_field_due` rearma quando a data muda", async () => {
    mundo.linhas("automation_rules").length = 0;
    mundo.linhas("automation_rules").push(
      regraDe(GATILHO_DE_DATA_DO_FUNIL, { pipeline_id: FUNIL, campo: CAMPO, dias: 240 }),
    );
    const lead = leadSilencioso(1, Date.now(), { custom_fields: { [CAMPO]: "2026-10-10" } });
    mundo.linhas("crm_leads").push(lead);

    await varrerData(NOVE_DA_ORG);
    expect(eventosDoCron(GATILHO_DE_DATA_DO_FUNIL)).toHaveLength(1);

    // Remarcou o casamento: a data nova também cai a 240 dias, no dia seguinte.
    (lead.custom_fields as Linha)[CAMPO] = "2026-10-11";
    const segunda = await varrerData(new Date("2026-02-13T12:00:00Z"));

    expect(
      eventosDoCron(GATILHO_DE_DATA_DO_FUNIL).map((e) => (e.p_payload as Linha).valor),
      "a data mudou e o aviso não rearma: a trava antiga (regra+negócio) era para sempre, e a cobrança remarcada nunca saía",
    ).toEqual(["2026-10-10", "2026-10-11"]);
    expect(segunda.data.emitidos).toBe(1);
  });

  it("(c) `date_field_due` NÃO rearma no legado do event_log, gravado sem `valor`", async () => {
    mundo.linhas("automation_rules").length = 0;
    mundo.linhas("automation_rules").push(
      regraDe(GATILHO_DE_DATA_DO_FUNIL, { pipeline_id: FUNIL, campo: CAMPO, dias: 240 }),
    );
    const lead = leadSilencioso(1, Date.now(), { custom_fields: { [CAMPO]: "2026-10-11" } });
    mundo.linhas("crm_leads").push(lead);
    // Linha anterior à #1540: sem `valor` não há como rearmar, e deserdí-la
    // reemitiria o aviso de todo par já avisado no primeiro deploy.
    mundo.linhas("event_log").push({
      organization_id: ORG,
      event_type: GATILHO_DE_DATA_DO_FUNIL,
      entity_id: lead.id,
      payload: { rule_id: REGRA, local_date: "2026-02-13" },
    });

    const resposta = await varrerData(new Date("2026-02-13T12:00:00Z"));

    expect(
      eventosDoCron(GATILHO_DE_DATA_DO_FUNIL),
      "a trava antiga sem `valor` foi deserdida e o aviso saiu de novo para quem já tinha sido avisado",
    ).toEqual([]);
    expect(resposta.data.emitidos).toBe(0);
  });
});
