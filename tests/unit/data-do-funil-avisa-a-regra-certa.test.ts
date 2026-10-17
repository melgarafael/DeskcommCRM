/**
 * A DATA DO FUNIL AVISA A REGRA CERTA — E SÓ ELA (issue #989).
 *
 * ═══ A COSTURA QUE ESTE ARQUIVO MEDE ═══
 *
 * A parte pura do gatilho (`lib/automation/gatilho-de-data-do-funil.ts`) já
 * responde "esta data cai hoje, para este N?". O que ela não sabe é o que o
 * produto FAZ com a resposta: quem varre os negócios, como o evento nasce no
 * `event_log`, qual das regras irmãs ele acorda, e o que impede a mesma
 * mensagem de sair de novo na rodada seguinte. É a costura varredura →
 * `event_log` → motor que aqui é exercitada: o mundo é de mentira (nenhum
 * Postgres, nenhum PostgREST), e o código que corre por cima dele é o de
 * verdade — a rota do cron e o motor.
 *
 * ═══ AS QUATRO MANEIRAS DE O GATILHO NASCER MORTO ═══
 *
 *  1. a varredura não existe (ou não está agendada): a regra é salva, o
 *     operador espera, e nada acontece — sem erro e sem log;
 *  2. ela varre todo negócio em vez de só o que casa com o dia → mensagem
 *     para quem não devia receber;
 *  3. a marca de "já disparei" fica só na função pura: a rodada horária
 *     manda a mesma cobrança de novo, nove vezes no mesmo dia;
 *  4. o evento não diz PARA QUAL regra ele vale: duas regras do mesmo gatilho
 *     com `dias` diferentes — `240` e `-60`, o caso do ateliê inteiro — e o
 *     motor roda as duas, porque só conhece o `event_type`. A confirmação de
 *     entrega sairia 300 dias antes do casamento.
 *
 * A 4 é a que nenhum teste da parte pura alcança: ela não está na conta de
 * datas, está no desenho do evento. Por isso o payload leva `rule_id` e por
 * isso o motor o respeita — e as duas pontas são medidas aqui.
 *
 * ═══ O QUE É CÓPIA E O QUE É MEDIÇÃO ═══
 *
 * O `p_entity_kind` NÃO é digitado neste arquivo: sai lido do fonte da rota,
 * como em `tests/unit/aniversario-oferece-condicao-que-funciona.test.ts`, e é
 * comparado com `ENTIDADE_ESPERADA_POR_GATILHO`. Se o emissor e o registro
 * divergirem, o motor larga o evento antes de avaliar qualquer condição — a
 * regra é salva, o dia chega, e nada roda.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/data-do-funil-avisa-a-regra-certa.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";

const CRON = path.join(process.cwd(), "app/api/v1/cron/lead-date-field-due/route.ts");

/** Os dublês que os módulos reais recebem — declarados antes dos `vi.mock`. */
const dubles = vi.hoisted(() => ({
  auditar: vi.fn(async () => undefined),
  adminAtual: { valor: null as unknown },
}));

vi.mock("@/lib/audit", () => ({ audit: dubles.auditar }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => dubles.adminAtual.valor,
}));

// O registro das ações é side-effect: o motor precisa do `add_tag` de verdade
// para executar a regra que ele decidir que vale.
import "@/lib/automation/actions/register-all";
import { runAutomationForEvent } from "@/lib/automation/engine";
import {
  GATILHO_DE_DATA_DO_FUNIL,
  chaveDeDisparo,
} from "@/lib/automation/gatilho-de-data-do-funil";
import { env } from "@/lib/env";
import { ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";

import { GET } from "@/app/api/v1/cron/lead-date-field-due/route";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_SEM_REGRA = "bbbbbbbb-0000-4000-8000-00000000000b";
const FUNIL = "ffffffff-0000-4000-8000-00000000000f";
const REGRA_240 = "11111111-0000-4000-8000-000000000001";
const REGRA_60 = "22222222-0000-4000-8000-000000000002";
const LEAD_ATELIE = "dddddddd-0000-4000-8000-000000000001";

const CAMPO = "data_do_casamento";
const CASAMENTO = "2026-10-10";
/** 09:00 em São Paulo (o Brasil não tem mais horário de verão) — a hora da varredura. */
const NOVE_DA_ORG = new Date("2026-02-12T12:00:00Z");
const DEZ_DA_ORG = new Date("2026-02-12T13:00:00Z");

type Linha = Record<string, unknown>;

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
 * Um banco de mentira com a gramática que estas duas rotas usam.
 *
 * Não é um PostgREST: é o recorte dele que o código chama — filtros de
 * igualdade, `in`, o `or` com wildcard `*` do `like`, lote e ordem. Um `or`
 * desonesto aqui (que devolvesse tudo) deixaria a varredura verde sobre um
 * filtro quebrado, então ele casa de verdade.
 */
class MundoFalso {
  readonly eventos: Linha[] = [];
  readonly consultas: Array<{ tabela: string; caminho: string; valor: unknown }> = [];
  readonly escritas: Array<{ tabela: string; acao: string; dados: Linha }> = [];
  private proximo = 0;

  constructor(readonly tabelas: Record<string, Linha[]>) {}

  from(tabela: string): ConsultaFalsa {
    return new ConsultaFalsa(this, tabela);
  }

  async rpc(nome: string, args: Linha): Promise<{ data: null; error: null }> {
    if (nome === "emit_event") this.eventos.push(args);
    return { data: null, error: null };
  }

  linhas(tabela: string): Linha[] {
    if (!this.tabelas[tabela]) this.tabelas[tabela] = [];
    return this.tabelas[tabela]!;
  }

  novoId(): string {
    this.proximo += 1;
    return `00000000-0000-4000-8000-0000000000${String(this.proximo).padStart(2, "0")}`;
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
    this.filtros.push((l) =>
      op === "is" && valor === null ? valorNoCaminho(l, caminho) != null : true,
    );
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
      this.mundo.escritas.push({ tabela: this.tabela, acao: "insert", dados: nova });
      return { data: [nova], error: null };
    }
    const casam = linhas.filter((l) => this.filtros.every((f) => f(l)));
    if (this.acao === "update") {
      for (const linha of casam) Object.assign(linha, this.dados);
      this.mundo.escritas.push({ tabela: this.tabela, acao: "update", dados: this.dados ?? {} });
    }
    return { data: this.teto === null ? casam : casam.slice(0, this.teto), error: null };
  }
}

/** Os eventos emitidos pelo CRON (as ações do motor também usam `emit_event`). */
function emitidosPeloCron(mundo: MundoFalso): Linha[] {
  return mundo.eventos.filter((e) => e.p_event_type === GATILHO_DE_DATA_DO_FUNIL);
}

function regraDoFunil(over: Linha = {}): Linha {
  return {
    id: REGRA_240,
    organization_id: ORG,
    name: "Começar o vestido",
    trigger_event: GATILHO_DE_DATA_DO_FUNIL,
    is_active: true,
    conditions: [],
    actions: [{ type: "add_tag", config: { tags: ["ateliê"] } }],
    trigger_config: { pipeline_id: FUNIL, campo: CAMPO, dias: 240 },
    run_count: 0,
    ...over,
  };
}

function leadDoFunil(id: string, valorDaData: string, over: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: "55555555-0000-4000-8000-000000000005",
    status: "open",
    title: "Casamento da Marina",
    tags: [],
    contact_id: null,
    custom_fields: { [CAMPO]: valorDaData },
    ...over,
  };
}

interface MundoDeTeste extends Record<string, Linha[]> {
  automation_rules: Linha[];
  organizations: Linha[];
  crm_leads: Linha[];
  event_log: Linha[];
}

function mundoCom(over: Partial<MundoDeTeste> = {}): MundoFalso {
  const base: MundoDeTeste = {
    automation_rules: [regraDoFunil()],
    organizations: [
      { id: ORG, timezone: "America/Sao_Paulo" },
      { id: ORG_SEM_REGRA, timezone: "America/Sao_Paulo" },
    ],
    crm_leads: [leadDoFunil(LEAD_ATELIE, CASAMENTO)],
    event_log: [],
    ...over,
  };
  return new MundoFalso(base);
}

let mundo: MundoFalso;

beforeEach(() => {
  vi.restoreAllMocks();
  dubles.auditar.mockClear();
  (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = "segredo_do_cron";
  mundo = mundoCom();
  dubles.adminAtual.valor = mundo;
});

afterEach(() => {
  vi.useRealTimers();
});

/** "Hoje" é o que o servidor acha que é — o teste escolhe o instante. */
async function varrer(
  quando: Date = NOVE_DA_ORG,
): Promise<{ status: number; data: Record<string, unknown> }> {
  vi.useFakeTimers();
  vi.setSystemTime(quando);
  const req = new NextRequest("http://localhost/api/v1/cron/lead-date-field-due", {
    headers: { authorization: "Bearer segredo_do_cron" },
  });
  const res = await GET(req);
  const corpo = (await res.json()) as { data: Record<string, unknown> };
  vi.useRealTimers();
  return { status: res.status, data: corpo.data };
}

/** O `p_entity_kind` que a rota REALMENTE passa ao `emit_event`, lido do fonte. */
function entidadeQueOCronEmite(): string | null {
  const m = /p_entity_kind:\s*"([^"]+)"/.exec(readFileSync(CRON, "utf8"));
  return m === null ? null : m[1]!;
}

function eventoDoCron(emitido: Linha): EventRow {
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

describe("a varredura da data do funil", () => {
  it("o aparato enxerga o mundo (controle positivo)", () => {
    // Sem isto, um mundo vazio faria todo "não emitiu" abaixo passar por
    // vacuidade — o instrumento cego devolvendo verde.
    expect(mundo.linhas("automation_rules")).toHaveLength(1);
    expect(mundo.linhas("crm_leads")).toHaveLength(1);
    expect(entidadeQueOCronEmite()).not.toBeNull();
  });

  it("⭐ emite UMA vez para o negócio que casa com o dia, e nada para o vizinho", async () => {
    mundo.linhas("crm_leads").push(
      leadDoFunil("dddddddd-0000-4000-8000-000000000002", "2026-10-11"),
    );

    const resposta = await varrer();
    const emitidos = emitidosPeloCron(mundo);

    expect(
      emitidos.map((e) => e.p_entity_id),
      "a varredura emitiu para quem não casa com o dia (240 dias antes de 10/10/2026 é 12/02/2026)",
    ).toEqual([LEAD_ATELIE]);
    expect(resposta.data.emitidos).toBe(1);
  });

  it("⭐ o evento leva a ENTIDADE do registro, o gatilho da tela e a REGRA a que vale", async () => {
    await varrer();
    const [emitido] = emitidosPeloCron(mundo);

    expect(
      gatilhoDoEmissor(),
      "a rota emite um event_type que não é o gatilho registrado",
    ).toBe(GATILHO_DE_DATA_DO_FUNIL);
    expect(
      emitido!.p_entity_kind,
      "o motor compara a entidade do evento com ENTIDADE_ESPERADA_POR_GATILHO e descarta o evento calado quando divergem",
    ).toBe(ENTIDADE_ESPERADA_POR_GATILHO[GATILHO_DE_DATA_DO_FUNIL]);
    expect(emitido!.p_entity_kind).toBe("crm_lead");
    expect(
      (emitido!.p_payload as Linha).rule_id,
      "o evento não diz para qual regra ele vale: as regras irmãs do mesmo gatilho rodariam todas",
    ).toBe(REGRA_240);
    expect(emitido!.p_organization_id).toBe(ORG);
  });

  it("⭐ quem já disparou esta regra não dispara de novo — e o vizinho que não disparou, dispara", async () => {
    const LEAD_NOVO = "dddddddd-0000-4000-8000-000000000003";
    mundo.linhas("crm_leads").push(leadDoFunil(LEAD_NOVO, CASAMENTO));
    mundo.linhas("event_log").push({
      organization_id: ORG,
      event_type: GATILHO_DE_DATA_DO_FUNIL,
      entity_id: LEAD_ATELIE,
      payload: { rule_id: REGRA_240, local_date: "2026-02-12" },
    });

    await varrer();

    expect(
      emitidosPeloCron(mundo).map((e) => e.p_entity_id),
      "a marca de já disparado não é consultada: a cobrança sai de novo a cada rodada horária",
    ).toEqual([LEAD_NOVO]);
  });

  it("⭐ a mesma data escrita à brasileira (importação/CSV) também casa", async () => {
    mundo.linhas("crm_leads").push(
      leadDoFunil("dddddddd-0000-4000-8000-000000000004", "10/10/2026"),
    );

    await varrer();

    expect(
      emitidosPeloCron(mundo).map((e) => e.p_entity_id),
      "a data que entrou à brasileira não casa: a regra existe, o operador espera, e nada acontece",
    ).toEqual([LEAD_ATELIE, "dddddddd-0000-4000-8000-000000000004"]);
  });

  it("a varredura só age na hora da ORGANIZAÇÃO — 09:00 em São Paulo, não em UTC", async () => {
    const resposta = await varrer(DEZ_DA_ORG);

    expect(emitidosPeloCron(mundo)).toEqual([]);
    expect(resposta.status).toBe(200);
  });

  it("regra com configuração torta é pulada, e não derruba a varredura das irmãs", async () => {
    mundo.linhas("automation_rules").unshift(
      regraDoFunil({
        id: REGRA_60,
        trigger_config: { pipeline_id: FUNIL, campo: CAMPO, dias: "240" },
      }),
    );

    const resposta = await varrer();

    expect(emitidosPeloCron(mundo).map((e) => e.p_entity_id)).toEqual([LEAD_ATELIE]);
    expect(resposta.data.pulados).toEqual({ config_invalida: 1 });
  });

  it("sem regra ativa deste gatilho, nenhum funil é varrido", async () => {
    mundo.linhas("automation_rules").length = 0;

    await varrer();

    expect(
      mundo.consultas.filter((c) => c.tabela === "crm_leads"),
      "instalação que não pediu a automação foi varrida: evento sem consumer é linha no event_log de quem não usa",
    ).toEqual([]);
  });

  it("só a organização dona da regra é varrida", async () => {
    await varrer();

    const varridas = new Set(
      mundo.consultas
        .filter((c) => c.tabela === "crm_leads" && c.caminho === "organization_id")
        .map((c) => c.valor),
    );
    expect([...varridas]).toEqual([ORG]);
  });

  it("a varredura só lê o NEGÓCIO: a data num campo do contato (#2791) nunca dispara", async () => {
    // O defeito que motivou `camposDeDataDoNegocio` e a recusa do servidor
    // (`lib/automation/campo-do-gatilho-de-data.ts`): um campo de escopo
    // `contato` guarda o valor em `contacts.custom_fields`, e o negócio fica sem
    // a chave. Se um dia a varredura passar a ler o contato, este caso fica
    // vermelho — e a recusa pode ser revista.
    const CONTATO = "cccccccc-0000-4000-8000-00000000000c";
    mundo.linhas("crm_leads").length = 0;
    mundo.linhas("crm_leads").push(
      leadDoFunil(LEAD_ATELIE, CASAMENTO, { contact_id: CONTATO, custom_fields: {} }),
    );
    mundo.linhas("contacts").push({
      id: CONTATO,
      organization_id: ORG,
      custom_fields: { [CAMPO]: CASAMENTO },
    });

    const resposta = await varrer();

    expect(emitidosPeloCron(mundo)).toEqual([]);
    expect(resposta.data.emitidos).toBe(0);
    expect(mundo.consultas.filter((c) => c.tabela === "contacts")).toEqual([]);
  });

  it("sem segredo de cron, não varre nada", async () => {
    const req = new NextRequest("http://localhost/api/v1/cron/lead-date-field-due");
    const res = await GET(req);

    expect(res.status).toBe(403);
    expect(emitidosPeloCron(mundo)).toEqual([]);
  });
});

/**
 * O `p_event_type` que a rota realmente passa, pelo mesmo motivo da entidade.
 *
 * A rota pode nomear o gatilho de duas formas, e as duas entram na medição: o
 * literal digitado (`"lead.date_field_due"`, o estilo do cron do aniversário) ou
 * a CONSTANTE importada do módulo que registra o gatilho. Na segunda forma o que
 * ainda sobra para medir — e o que este teste pega — é o import: se a rota
 * referenciar um nome que não vem de `gatilho-de-data-do-funil`, a sonda devolve
 * `null` e a regra salva pelo operador nunca acorda.
 */
function gatilhoDoEmissor(): string | null {
  const fonte = readFileSync(CRON, "utf8");

  const literal = /p_event_type:\s*"([^"]+)"/.exec(fonte);
  if (literal !== null) return literal[1]!;

  const referencia = /p_event_type:\s*([A-Za-z_$][\w$]*)/.exec(fonte);
  if (referencia === null) return null;
  if (referencia[1] !== "GATILHO_DE_DATA_DO_FUNIL") return null;

  const doModulo = new RegExp(
    'import\\s*\\{([^}]*)\\}\\s*from\\s*"@/lib/automation/gatilho-de-data-do-funil"',
  ).exec(fonte);
  const importados = (doModulo?.[1] ?? "")
    .split(",")
    .map((nome) => nome.trim().split(/\s+as\s+/).pop()!)
    .filter(Boolean);

  return importados.includes("GATILHO_DE_DATA_DO_FUNIL")
    ? GATILHO_DE_DATA_DO_FUNIL
    : null;
}

describe("o motor respeita o evento dirigido", () => {
  it("⭐ com `rule_id` no payload, só a regra apontada roda", async () => {
    // A regra de 60 dias DEPOIS do casamento — o segundo pedido do ateliê.
    mundo.linhas("automation_rules").push(
      regraDoFunil({
        id: REGRA_60,
        name: "Confirmar a entrega",
        trigger_config: { pipeline_id: FUNIL, campo: CAMPO, dias: -60 },
      }),
    );

    await varrer();
    const [emitido] = emitidosPeloCron(mundo);
    expect(emitido).toBeDefined();

    const desfecho = await runAutomationForEvent(
      dubles.adminAtual.valor as SupabaseClient,
      eventoDoCron(emitido!),
    );

    const corridas = mundo.linhas("automation_rule_runs");
    expect(
      corridas.map((r) => r.rule_id),
      "o evento acordou as duas regras irmãs: a confirmação de entrega saiu junto com o aviso de 240 dias",
    ).toEqual([REGRA_240]);
    expect(desfecho.status).toBe("ok");
  });

  it("controle: sem `rule_id`, o mesmo evento acorda as duas (a marca não é vacuidade)", async () => {
    mundo.linhas("automation_rules").push(
      regraDoFunil({
        id: REGRA_60,
        name: "Confirmar a entrega",
        trigger_config: { pipeline_id: FUNIL, campo: CAMPO, dias: -60 },
      }),
    );

    await varrer();
    const [emitido] = emitidosPeloCron(mundo);
    const semRegra = { ...eventoDoCron(emitido!) };
    semRegra.payload = { local_date: "2026-02-12" };

    await runAutomationForEvent(dubles.adminAtual.valor as SupabaseClient, semRegra);

    expect(
      mundo.linhas("automation_rule_runs").map((r) => r.rule_id).sort(),
      "o recorte por `rule_id` não é o que separa as regras — então o caso acima passa por outro motivo",
    ).toEqual([REGRA_240, REGRA_60].sort());
  });

  it("a chave da trava é regra+lead, e não só o lead", () => {
    expect(chaveDeDisparo(REGRA_240, LEAD_ATELIE)).toBe(`${REGRA_240}:${LEAD_ATELIE}`);
  });
});
