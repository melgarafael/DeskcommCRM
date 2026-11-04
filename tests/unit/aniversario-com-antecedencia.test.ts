/**
 * O ANIVERSÁRIO AVISA N DIAS ANTES — E NÃO AVISA DUAS VEZES (issue #3726).
 *
 * ─── O defeito que este arquivo prende ──────────────────────────────────────
 *
 * O gatilho `contact.birthday` só sabia disparar no próprio dia, às 9h locais.
 * Clínica e salão avisam no começo do mês que o benefício vale o mês inteiro,
 * para a cliente ter tempo de marcar — e não havia caminho automático. A #3726
 * oferecia três saídas; a escolhida foi o campo `dias_antecedencia` no gatilho
 * que já existe (0 = no dia, como hoje), com a mesma trava de um disparo por
 * contato por ano.
 *
 * ─── As quatro maneiras de o campo novo nascer morto ────────────────────────
 *
 *  1. a tela grava o N e a varredura o ignora → o campo é decorativo, e o
 *     operador espera um aviso que nunca sai;
 *  2. a conta é feita em HORAS em vez de dias de calendário → erra na virada de
 *     horário de verão e erra feio em 29/02 (e ninguém reporta, porque só
 *     aparece uma vez por ano);
 *  3. a trava continua sendo a janela de 26h do dia → a rodada seguinte, no dia
 *     seguinte, manda de novo (o N>0 nunca foi exercitado);
 *  4. duas regras com N diferentes acordam juntas → quem nasceu hoje recebe
 *     também o "faltam 10 dias" que já passou.
 *
 * ─── O que é cópia e o que é medição ────────────────────────────────────────
 *
 * O mundo é de mentira (nenhum Postgres, nenhum PostgREST) e o código que corre
 * por cima dele é o de verdade: a rota do cron, o leitor da configuração e a
 * conta de calendário. O `p_entity_kind` e o `p_event_type` NÃO são digitados
 * aqui — saem lidos do fonte da rota, como em
 * `tests/unit/aniversario-oferece-condicao-que-funciona.test.ts`, porque um
 * dublê que montasse o evento à mão mediria a minha cópia do emissor.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/aniversario-com-antecedencia.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aniversarioDoAviso,
  aniversariosAlvo,
  anoDoAniversario,
  configDoAniversario,
} from "@/lib/automation/aniversario-do-contato";
import { env } from "@/lib/env";
import { ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";

const dubles = vi.hoisted(() => ({
  auditar: vi.fn(async () => undefined),
  adminAtual: { valor: null as unknown },
}));

vi.mock("@/lib/audit", () => ({ audit: dubles.auditar }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => dubles.adminAtual.valor,
}));

import { GET } from "@/app/api/v1/cron/contact-birthdays/route";

const CRON = path.join(process.cwd(), "app/api/v1/cron/contact-birthdays/route.ts");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const REGRA_NO_DIA = "11111111-0000-4000-8000-000000000001";
const REGRA_DEZ_DIAS = "22222222-0000-4000-8000-000000000002";
const CONTATO = "dddddddd-0000-4000-8000-000000000001";

/** 15/09/2026 às 09:00 em São Paulo (UTC-3, sem horário de verão). */
const NOVE_DA_ORG = new Date("2026-09-15T12:00:00.000Z");

type Linha = Record<string, unknown>;

/** O caminho do PostgREST: `payload->>rule_id`, `birthday_md`. */
function valorNoCaminho(linha: Linha, caminho: string): unknown {
  const partes = caminho.split("->>");
  let atual: unknown = linha;
  for (const parte of partes) {
    if (atual === null || typeof atual !== "object") return undefined;
    atual = (atual as Linha)[parte];
  }
  // `->>` devolve TEXTO: o número gravado no payload (`ano_do_aniversario`)
  // volta como "2026", e é com isso que o `.eq` compara. Um dublê que
  // devolvesse o número cru faria a trava anual parecer quebrada — ou pior,
  // faria uma trava quebrada parecer certa.
  if (partes.length > 1 && typeof atual === "number") return String(atual);
  return atual;
}

/** O recorte do PostgREST que esta rota usa: `eq`, `in`, `not is`, `gte`, `limit`. */
class MundoFalso {
  readonly eventos: Linha[] = [];

  constructor(readonly tabelas: Record<string, Linha[]>) {}

  from(tabela: string): ConsultaFalsa {
    return new ConsultaFalsa(this, tabela);
  }

  async rpc(nome: string, args: Linha): Promise<{ data: null; error: null }> {
    if (nome === "emit_event") {
      this.eventos.push(args);
      // O `emit_event` de verdade grava a linha no `event_log`; sem esta cópia
      // uma segunda rodada não veria a primeira, e o teste da trava anual
      // passaria por vacuidade.
      this.linhas("event_log").push({
        organization_id: args.p_organization_id,
        event_type: args.p_event_type,
        entity_kind: args.p_entity_kind,
        entity_id: args.p_entity_id,
        payload: args.p_payload,
        created_at: new Date().toISOString(),
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
    this.filtros.push((l) =>
      op === "is" && valor === null ? valorNoCaminho(l, caminho) != null : true,
    );
    return this;
  }

  gte(caminho: string, valor: string): this {
    this.filtros.push((l) => String(valorNoCaminho(l, caminho) ?? "") >= valor);
    return this;
  }

  limit(n: number): this {
    this.teto = n;
    return this;
  }

  then<TResult>(
    onfulfilled?: ((v: { data: Linha[] | null; error: null }) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    const casam = this.mundo
      .linhas(this.tabela)
      .filter((l) => this.filtros.every((f) => f(l)));
    const data = this.teto === null ? casam : casam.slice(0, this.teto);
    return Promise.resolve({ data, error: null }).then(
      onfulfilled ?? ((v) => v as unknown as TResult),
    );
  }
}

function regra(id: string, triggerConfig: Linha): Linha {
  return {
    id,
    organization_id: ORG,
    name: "Aniversário",
    trigger_event: "contact.birthday",
    is_active: true,
    conditions: [],
    actions: [{ type: "add_tag", config: { tags: ["aniversario"] } }],
    trigger_config: triggerConfig,
  };
}

/** O contato que faz aniversário em `md` (mês*100 + dia). */
function contato(id: string, md: number): Linha {
  return {
    id,
    organization_id: ORG,
    name: "Cliente",
    tags: [],
    birthdate: null,
    birthday_md: md,
    is_blocked: false,
    phone_number: "+5511999999999",
  };
}

function mundoCom(regras: Linha[], contatos: Linha[] = []): MundoFalso {
  return new MundoFalso({
    automation_rules: regras,
    organizations: [{ id: ORG, timezone: "America/Sao_Paulo" }],
    contacts: contatos,
    event_log: [],
  });
}

let mundo: MundoFalso;

beforeEach(() => {
  dubles.auditar.mockClear();
  (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = "segredo_do_cron";
});

afterEach(() => {
  vi.useRealTimers();
});

async function varrer(
  quando: Date,
): Promise<{ status: number; data: Record<string, unknown> }> {
  vi.useFakeTimers();
  vi.setSystemTime(quando);
  const req = new NextRequest("http://localhost/api/v1/cron/contact-birthdays", {
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

/** O `p_event_type` que a rota REALMENTE passa ao `emit_event`, lido do fonte. */
function gatilhoQueOCronEmite(): string | null {
  const m = /p_event_type:\s*"([^"]+)"/.exec(readFileSync(CRON, "utf8"));
  return m === null ? null : m[1]!;
}

describe("a conta de calendário do aviso antecipado", () => {
  it("configuração ausente vale 0 — é o que toda regra antiga tem no banco", () => {
    expect(configDoAniversario(undefined)).toEqual({ dias_antecedencia: 0 });
    expect(configDoAniversario({})).toEqual({ dias_antecedencia: 0 });
    expect(configDoAniversario({ dias_antecedencia: 0 })).toEqual({ dias_antecedencia: 0 });
    expect(configDoAniversario({ dias_antecedencia: 10 })).toEqual({ dias_antecedencia: 10 });
  });

  it("valor torto não vira 0 calado: devolve null", () => {
    for (const torto of [-1, 366, 1.5, "10", [], true]) {
      expect(
        configDoAniversario({ dias_antecedencia: torto }),
        `aceitou dias_antecedencia=${JSON.stringify(torto)}`,
      ).toBeNull();
    }
  });

  it("N=0 persegue o próprio dia; N=10, dez dias antes", () => {
    expect(aniversariosAlvo("2026-09-15", 0)).toEqual([915]);
    expect(aniversarioDoAviso("2026-09-05", 10)).toBe("2026-09-15");
    expect(aniversariosAlvo("2026-09-05", 10)).toEqual([915]);
  });

  it("⭐ virada de MÊS: 10 dias antes de 05/10 é 25/09", () => {
    expect(aniversariosAlvo("2026-09-25", 10)).toEqual([1005]);
  });

  it("⭐ virada de ANO: 10 dias antes de 05/01 cai em 26/12 do ano anterior", () => {
    expect(aniversarioDoAviso("2026-12-26", 10)).toBe("2027-01-05");
    expect(aniversariosAlvo("2026-12-26", 10)).toEqual([105]);
    // O ano da trava é o do ANIVERSÁRIO (2027), não o do disparo (2026): é o que
    // impede a virada de ano de reabrir o mesmo aviso.
    expect(anoDoAniversario("2027-01-05")).toBe(2027);
  });

  it("⭐ 29 de fevereiro: em ano não bissexto o dia 28 responde pelo 29, com N junto", () => {
    // 2026 não é bissexto: dez dias antes do 28/02 é 18/02, e o alvo é o 28 —
    // que responde também pelo 29, exatamente como no aviso do próprio dia.
    expect(aniversariosAlvo("2026-02-18", 10)).toEqual([228, 229]);
    // 2028 é bissexto: dez dias antes do 29/02 é 19/02, e o alvo é só o 29.
    expect(aniversariosAlvo("2028-02-19", 10)).toEqual([229]);
    // E o caminho de N=0 não mudou.
    expect(aniversariosAlvo("2026-02-28", 0)).toEqual([228, 229]);
    expect(aniversariosAlvo("2028-02-28", 0)).toEqual([228]);
  });
});

describe("a varredura do aniversário com antecedência", () => {
  it("o aparato enxerga o emissor (controle positivo)", () => {
    expect(gatilhoQueOCronEmite()).toBe("contact.birthday");
    expect(entidadeQueOCronEmite()).toBe(ENTIDADE_ESPERADA_POR_GATILHO["contact.birthday"]);
  });

  it("⭐ N=0 dispara NO DIA, às 9h locais — e só nele", async () => {
    mundo = mundoCom([regra(REGRA_NO_DIA, {})], [contato(CONTATO, 915)]);
    dubles.adminAtual.valor = mundo;

    const resposta = await varrer(NOVE_DA_ORG);

    expect(resposta.data.emitidos).toBe(1);
    const [emitido] = mundo.eventos;
    expect(emitido!.p_payload).toMatchObject({
      rule_id: REGRA_NO_DIA,
      dias_antecedencia: 0,
      data_do_aniversario: "2026-09-15",
      ano_do_aniversario: 2026,
      local_date: "2026-09-15",
    });
  });

  it("N=0 fora da hora marcada não dispara (a hora continua sendo 9h locais)", async () => {
    mundo = mundoCom([regra(REGRA_NO_DIA, {})], [contato(CONTATO, 915)]);
    dubles.adminAtual.valor = mundo;

    const resposta = await varrer(new Date("2026-09-15T13:00:00.000Z"));

    expect(resposta.data.emitidos).toBe(0);
    expect(mundo.eventos).toHaveLength(0);
  });

  it("⭐ N=10 dispara DEZ DIAS ANTES, e não no dia", async () => {
    mundo = mundoCom(
      [regra(REGRA_DEZ_DIAS, { dias_antecedencia: 10 })],
      // Dois contatos: um faz aniversário em 25/09 (dez dias depois de 15/09) e
      // o outro faz HOJE. Só o primeiro recebe o aviso antecipado.
      [contato(CONTATO, 925), contato("dddddddd-0000-4000-8000-000000000002", 915)],
    );
    dubles.adminAtual.valor = mundo;

    const resposta = await varrer(NOVE_DA_ORG);

    expect(resposta.data.emitidos).toBe(1);
    const [emitido] = mundo.eventos;
    expect(emitido!.p_entity_id).toBe(CONTATO);
    expect(emitido!.p_payload).toMatchObject({
      dias_antecedencia: 10,
      data_do_aniversario: "2026-09-25",
    });
  });

  it("⭐ duas rodadas no mesmo dia NÃO repetem o aviso (trava anual)", async () => {
    mundo = mundoCom(
      [regra(REGRA_DEZ_DIAS, { dias_antecedencia: 10 })],
      [contato(CONTATO, 925)],
    );
    dubles.adminAtual.valor = mundo;

    const primeira = await varrer(NOVE_DA_ORG);
    const segunda = await varrer(new Date("2026-09-15T12:30:00.000Z"));

    expect(primeira.data.emitidos).toBe(1);
    expect(
      segunda.data.emitidos,
      "a segunda rodada do dia reemitiu: o contato recebe dois avisos do mesmo aniversário",
    ).toBe(0);
    expect(mundo.eventos).toHaveLength(1);
    expect((segunda.data.pulados as Record<string, number>).ja_emitido).toBe(1);
  });

  it("⭐ a rodada do ANO SEGUINTE volta a emitir — a trava é por aniversário, não para sempre", async () => {
    mundo = mundoCom(
      [regra(REGRA_DEZ_DIAS, { dias_antecedencia: 10 })],
      [contato(CONTATO, 105)],
    );
    dubles.adminAtual.valor = mundo;

    // 26/12/2025 avisa o aniversário de 05/01/2026.
    const primeira = await varrer(new Date("2025-12-26T12:00:00.000Z"));
    // 26/12/2026 avisa o de 05/01/2027 — outro aniversário, outro disparo.
    const segunda = await varrer(new Date("2026-12-26T12:00:00.000Z"));

    expect(primeira.data.emitidos).toBe(1);
    expect(segunda.data.emitidos).toBe(1);
    expect(
      mundo.eventos.map((e) => (e.p_payload as Linha).ano_do_aniversario),
      "a virada de ano não pode nem duplicar nem silenciar o aniversário seguinte",
    ).toEqual([2026, 2027]);
  });

  it("⭐ duas regras com N diferentes não acordam juntas", async () => {
    mundo = mundoCom(
      [regra(REGRA_NO_DIA, {}), regra(REGRA_DEZ_DIAS, { dias_antecedencia: 10 })],
      [contato(CONTATO, 915), contato("dddddddd-0000-4000-8000-000000000002", 925)],
    );
    dubles.adminAtual.valor = mundo;

    await varrer(NOVE_DA_ORG);

    // No dia 15/09: a regra do dia fala com quem faz aniversário hoje; a de dez
    // dias fala com quem faz em 25/09. Um evento por par (regra, contato).
    const porRegra = mundo.eventos.map((e) => [
      (e.p_payload as Linha).rule_id,
      e.p_entity_id,
    ]);
    expect(porRegra).toEqual([
      [REGRA_NO_DIA, CONTATO],
      [REGRA_DEZ_DIAS, "dddddddd-0000-4000-8000-000000000002"],
    ]);
  });

  it("evento anterior à #3726 (sem rule_id) continua bloqueando o dia", async () => {
    mundo = mundoCom([regra(REGRA_NO_DIA, {})], [contato(CONTATO, 915)]);
    // A linha que a versão antiga gravou às 9h de hoje.
    mundo.linhas("event_log").push({
      organization_id: ORG,
      event_type: "contact.birthday",
      entity_id: CONTATO,
      payload: { local_date: "2026-09-15" },
      created_at: "2026-09-15T12:00:00.000Z",
    });
    dubles.adminAtual.valor = mundo;

    const resposta = await varrer(NOVE_DA_ORG);

    expect(
      resposta.data.emitidos,
      "o deploy do meio-dia parabenizou de novo quem já tinha recebido às 9h",
    ).toBe(0);
  });

  it("configuração torta não derruba as irmãs: ela é pulada e a outra roda", async () => {
    mundo = mundoCom(
      [
        regra("33333333-0000-4000-8000-000000000003", { dias_antecedencia: -5 }),
        regra(REGRA_NO_DIA, {}),
      ],
      [contato(CONTATO, 915)],
    );
    dubles.adminAtual.valor = mundo;

    const resposta = await varrer(NOVE_DA_ORG);

    expect(resposta.data.emitidos).toBe(1);
    expect((resposta.data.pulados as Record<string, number>).config_invalida).toBe(1);
  });

  it("a rodada que emitiu audita; a que não emitiu, não", async () => {
    mundo = mundoCom([regra(REGRA_NO_DIA, {})], [contato(CONTATO, 915)]);
    dubles.adminAtual.valor = mundo;
    await varrer(NOVE_DA_ORG);
    expect(dubles.auditar).toHaveBeenCalledTimes(1);

    dubles.auditar.mockClear();
    mundo = mundoCom([regra(REGRA_NO_DIA, {})], [contato(CONTATO, 401)]);
    dubles.adminAtual.valor = mundo;
    await varrer(NOVE_DA_ORG);
    expect(dubles.auditar).not.toHaveBeenCalled();
  });
});
