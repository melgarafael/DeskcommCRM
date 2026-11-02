/**
 * #3644 — QUEM JÁ COMPROU NÃO VOLTA COMO CAPTAÇÃO.
 *
 * ═══ O defeito, medido na issue ═══
 *
 * `garantirLeadDaConversa` só tratava como cliente quem tinha
 * `contacts.first_service_at` preenchido E `settings.crm.cliente_pela_agenda`
 * ligado. Quem comprou sem nunca ter agendado nada tem a coluna nula, então a
 * conversa do dia seguinte nascia no funil PADRÃO (`is_default`, "Aquisição ›
 * Abordagem") — como lead frio. O funil de entrada mede quem é novo, e a
 * recompra entrava na conta; o pós-venda ficava invisível.
 *
 * ═══ O que este arquivo mede ═══
 *
 *   1. a REGRA PURA (`lib/leads/cliente-pela-venda.ts`): chave desligada =
 *      comportamento antigo; ganha vira cliente; só perdida não; a janela de
 *      pós-venda (dentro, fora e na borda); configuração torta vira o padrão;
 *   2. o CAMINHO REAL, chamando `garantirLeadDaConversa` com o client dublado —
 *      a função de produção, não uma cópia da consulta: funil de clientes
 *      marcado (nasce nele, com a venda na linha do tempo), sem funil de
 *      clientes (cai no padrão, com o aviso), só perdida, negócio aberto
 *      (`ja_existe`), janela de pós-venda;
 *   3. os CONTROLES do que não podia mudar: lead frio sem venda e sem
 *      agendamento continua na captação; `first_service_at` continua valendo
 *      exatamente como antes;
 *   4. o CUSTO: nenhuma consulta a mais por mensagem recebida — a mensagem de
 *      uma conversa que já tem card custa as MESMAS duas leituras de antes, e a
 *      leitura da venda só acontece com a chave ligada.
 *
 * O dublê aplica os filtros de `eq` e devolve por (tabela, filtro): é o que
 * permite separar a leitura de negócio ABERTO da de negócio GANHO — as duas na
 * mesma tabela, e trocá-las faria tudo abaixo passar pelo motivo errado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// A campanha não é o assunto desta issue: `null` mantém o caminho na regra de
// entrada, que é onde o defeito mora.
vi.mock("@/lib/campanhas/origem-do-lead", () => ({
  origemDeCampanhaDaConversa: vi.fn(async () => null),
  marcaDaOrigem: vi.fn(() => ({ source: "campanha", source_metadata: {} })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  decidirPelaVenda,
  diasDesde,
  motivoDaVolta,
  type VendaAnterior,
} from "@/lib/leads/cliente-pela-venda";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { formatValorDoNegocio } from "@/lib/money";
import { regrasDeCliente } from "@/lib/schemas/settings";

/**
 * O valor sai do MESMO formatador da produção (o `Intl` usa espaço
 * inquebrável depois de "R$"): escrever o literal aqui mediria a cópia, e a
 * cópia com espaço comum reprovaria o texto certo.
 */
const VALOR = formatValorDoNegocio(120_000, "BRL");

const ORG = "org-1";
const CONTATO = "contato-1";
const CONVERSA = "conv-1";

const FUNIL_PADRAO = "funil-entrada";
const FUNIL_CLIENTES = "funil-clientes";

/** O contato do defeito: comprou, nunca agendou. */
const CONTATO_BASE = {
  is_blocked: false,
  is_personal: false,
  display_name: "Marina",
  name: "Marina",
  phone_number: "5511988887777",
  source: null,
  source_metadata: null,
  first_service_at: null as string | null,
  tags: [] as string[],
};

interface VendaNaCena {
  id: string;
  pipeline_id: string;
  pipeline_nome: string | null;
  closed_at: string | null;
  value_cents: number | null;
  currency: string | null;
}

interface Cena {
  /** `contacts.first_service_at` — o critério antigo. */
  firstServiceAt: string | null;
  /** `organizations.settings` cru. */
  settings: unknown;
  /** O contato tem negócio ABERTO (passo 2). */
  leadAberto?: boolean;
  /** A última venda ganha, ou `null` (só perdida / nunca comprou). */
  venda?: VendaNaCena | null;
  /** Id do funil marcado como `is_client_pipeline`, ou `null` (não marcado). */
  funilDeClientes?: string | null;
  /** Cada leitura resolvida, na ordem: é a prova do custo. */
  consultas: string[];
  /** `fn_nascer_lead_*` chamada quantas vezes. */
  nascimentos: number;
  /** Argumentos da RPC de nascimento. */
  argumentos: Record<string, unknown> | null;
}

function novaCena(parcial: Partial<Cena> = {}): Cena {
  return {
    firstServiceAt: null,
    settings: {
      crm: { cliente_pela_agenda: false, cliente_pela_venda: true, pos_venda_dias: 0 },
    },
    leadAberto: false,
    venda: null,
    funilDeClientes: FUNIL_CLIENTES,
    consultas: [],
    nascimentos: 0,
    argumentos: null,
    ...parcial,
  };
}

/**
 * O dublê do `SupabaseClient`: aplica `eq`, projeta o `select` e resolve por
 * (tabela, filtros). Registrar CADA leitura é metade do teste — o critério
 * "sem N+1 por mensagem recebida" só se prova contando.
 */
function adminFake(c: Cena) {
  const tabela = (nome: string) => {
    const filtros: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    const passa = () => chain;
    chain.select = passa;
    chain.order = passa;
    chain.limit = passa;
    chain.is = passa;
    chain.eq = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return chain;
    };
    chain.maybeSingle = () => {
      c.consultas.push(nome);
      if (nome === "contacts") {
        return Promise.resolve({
          data: { ...CONTATO_BASE, first_service_at: c.firstServiceAt, tags: [] },
          error: null,
        });
      }
      if (nome === "organizations") {
        return Promise.resolve({ data: { settings: c.settings }, error: null });
      }
      if (nome === "crm_leads") {
        if (filtros.status === "open")
          return Promise.resolve({ data: c.leadAberto ? { id: "lead-aberto" } : null, error: null });
        if (filtros.status === "won") {
          const v = c.venda;
          return Promise.resolve({
            data: v
              ? {
                  id: v.id,
                  pipeline_id: v.pipeline_id,
                  closed_at: v.closed_at,
                  updated_at: v.closed_at,
                  value_cents: v.value_cents,
                  currency: v.currency,
                }
              : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (nome === "crm_pipelines") {
        // O nome do funil da venda — leitura de texto, não de roteamento.
        if (typeof filtros.id === "string")
          return Promise.resolve({ data: { name: c.venda?.pipeline_nome ?? null }, error: null });
        if (filtros.is_client_pipeline === true) {
          return Promise.resolve({
            data: c.funilDeClientes ? { id: c.funilDeClientes, settings: {} } : null,
            error: null,
          });
        }
        if (filtros.is_default === true) {
          return Promise.resolve({ data: { id: FUNIL_PADRAO, settings: {} }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (nome === "crm_stages") return Promise.resolve({ data: { id: "etapa-1" }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    return chain;
  };

  return {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "fn_nascer_lead_da_conversa" || fn === "fn_nascer_lead_da_mensagem") {
        c.nascimentos += 1;
        c.argumentos = args;
        return { data: "lead-novo", error: null };
      }
      return { data: null, error: null };
    },
  } as never;
}

const DADOS = {
  organizationId: ORG,
  contactId: CONTATO,
  conversationId: CONVERSA,
  nomeDoContato: "Marina",
};

function vendaHa(dias: number, extra: Partial<VendaNaCena> = {}): VendaNaCena {
  const quando = new Date(Date.now() - dias * 86_400_000).toISOString();
  return {
    id: "venda-1",
    pipeline_id: "funil-vendas",
    pipeline_nome: "Vendas",
    closed_at: quando,
    value_cents: 120_000,
    currency: "BRL",
    ...extra,
  };
}

function atividadeDoLead() {
  const chamadas = vi.mocked(emitLeadActivity).mock.calls;
  return chamadas.length > 0 ? (chamadas[0]![1] as unknown as Record<string, unknown>) : null;
}

beforeEach(() => vi.clearAllMocks());

describe("#3644 · a regra pura", () => {
  const venda: VendaAnterior = {
    leadId: "venda-1",
    pipelineId: "funil-vendas",
    pipelineNome: "Vendas",
    fechadaEm: "2026-10-01T12:00:00.000Z",
    valorCents: 120_000,
    moeda: "BRL",
  };

  it("chave DESLIGADA: venda ganha não muda nada (o comportamento antigo)", () => {
    const d = decidirPelaVenda({ pelaVenda: false, posVendaDias: 30, venda });
    expect(d).toMatchObject({ cliente: false, posVenda: false, motivo: null });
  });

  it("venda ganha com a chave ligada vira cliente, com o texto da venda", () => {
    const d = decidirPelaVenda({
      pelaVenda: true,
      posVendaDias: 0,
      venda,
      agora: new Date("2026-10-13T12:00:00.000Z"),
    });
    expect(d).toMatchObject({ cliente: true, posVenda: false, diasDesdeAVenda: 12 });
    expect(d.motivo).toBe(`Cliente voltou a escrever · última venda há 12 dias (Vendas, ${VALOR})`);
  });

  it("só perdida (nenhuma ganha) NÃO vira cliente", () => {
    expect(decidirPelaVenda({ pelaVenda: true, posVendaDias: 0, venda: null })).toMatchObject({
      cliente: false,
      posVenda: false,
    });
  });

  it("dentro da janela de pós-venda: nenhum negócio é aberto", () => {
    const d = decidirPelaVenda({
      pelaVenda: true,
      posVendaDias: 30,
      venda,
      agora: new Date("2026-10-11T12:00:00.000Z"), // 10 dias
    });
    expect(d).toMatchObject({ cliente: false, posVenda: true, diasDesdeAVenda: 10 });
  });

  it("fora da janela: nasce como cliente", () => {
    const d = decidirPelaVenda({
      pelaVenda: true,
      posVendaDias: 30,
      venda,
      agora: new Date("2026-11-10T12:00:00.000Z"), // 40 dias
    });
    expect(d).toMatchObject({ cliente: true, posVenda: false, diasDesdeAVenda: 40 });
  });

  it("a borda conta como DENTRO (o último dia da janela não abre card)", () => {
    const d = decidirPelaVenda({
      pelaVenda: true,
      posVendaDias: 30,
      venda,
      agora: new Date("2026-10-31T12:00:00.000Z"), // exatos 30 dias
    });
    expect(d).toMatchObject({ posVenda: true, diasDesdeAVenda: 30 });
  });

  it("janela em 0 (o padrão) desliga o pós-venda: o card sempre nasce", () => {
    const d = decidirPelaVenda({
      pelaVenda: true,
      posVendaDias: 0,
      venda,
      agora: new Date("2026-10-02T12:00:00.000Z"), // 1 dia
    });
    expect(d).toMatchObject({ cliente: true, posVenda: false, diasDesdeAVenda: 1 });
  });

  it("data ilegível não segura a conversa: vira cliente, sem 'há N dias'", () => {
    const d = decidirPelaVenda({
      pelaVenda: true,
      posVendaDias: 30,
      venda: { ...venda, fechadaEm: null },
    });
    expect(d).toMatchObject({ cliente: true, posVenda: false, diasDesdeAVenda: null });
    expect(d.motivo).toBe(`Cliente voltou a escrever · última venda registrada (Vendas, ${VALOR})`);
  });

  it("texto da timeline: 'hoje', singular, e sem parêntese vazio", () => {
    expect(motivoDaVolta(venda, 0)).toBe(`Cliente voltou a escrever · última venda hoje (Vendas, ${VALOR})`);
    expect(motivoDaVolta(venda, 1)).toContain("última venda há 1 dia");
    expect(
      motivoDaVolta({ ...venda, pipelineNome: null, valorCents: null }, 5),
    ).toBe("Cliente voltou a escrever · última venda há 5 dias");
  });

  it("diasDesde nunca é negativo (relógio torto não vira 'há -3 dias')", () => {
    expect(diasDesde("2026-10-10T12:00:00.000Z", new Date("2026-10-01T12:00:00.000Z"))).toBe(0);
    expect(diasDesde(null)).toBeNull();
    expect(diasDesde("não é data")).toBeNull();
  });

  it("configuração torta vira o padrão: chave string e janela fora de 0–365", () => {
    const lido = regrasDeCliente({
      crm: { cliente_pela_venda: "true", pos_venda_dias: 9999 },
    });
    expect(lido).toMatchObject({ pelaVenda: false, posVendaDias: 0 });

    // E um jsonb que nem objeto é: tudo desligado, nada lança.
    expect(regrasDeCliente("lixo")).toMatchObject({ pelaVenda: false, posVendaDias: 0 });
  });
});

describe("#3644 · o caminho real (garantirLeadDaConversa)", () => {
  it("venda ganha + funil de clientes marcado → nasce no funil de CLIENTES, com a venda na timeline", async () => {
    const c = novaCena({ venda: vendaHa(12) });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({
      criado: true,
      leadId: "lead-novo",
      pipelineId: FUNIL_CLIENTES,
    });
    // O contrato com o banco: o card nasce no funil de clientes, não no padrão.
    expect(c.argumentos).toMatchObject({ p_pipeline: FUNIL_CLIENTES });

    const atividade = atividadeDoLead();
    expect(atividade?.reason).toContain("Cliente voltou a escrever · última venda há 12 dias");
    expect(atividade?.reason).toContain(`(Vendas, ${VALOR})`);
    expect(atividade?.payload).toMatchObject({ cliente: true, venda_anterior_id: "venda-1" });
  });

  it("venda ganha SEM funil de clientes marcado → cai no funil padrão, e o aviso continua", async () => {
    // O destino não muda quando a organização não marcou um funil de clientes —
    // mas a timeline DIZ que é recompra, que é o que faltava.
    const c = novaCena({ venda: vendaHa(12), funilDeClientes: null });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, pipelineId: FUNIL_PADRAO });
    expect(atividadeDoLead()?.payload).toMatchObject({
      cliente: true,
      venda_anterior_id: "venda-1",
    });
  });

  it("CONTROLE · chave desligada: a venda ganha é ignorada e o card volta para a captação", async () => {
    const c = novaCena({
      venda: vendaHa(12),
      settings: { crm: { cliente_pela_agenda: false, cliente_pela_venda: false } },
    });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, pipelineId: FUNIL_PADRAO });
    expect(atividadeDoLead()?.payload).toMatchObject({ cliente: false });
    expect(atividadeDoLead()?.payload).not.toHaveProperty("venda_anterior_id");
  });

  it("CONTROLE · lead frio, sem venda e sem agendamento, continua na captação", async () => {
    const c = novaCena({ venda: null });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, pipelineId: FUNIL_PADRAO });
    expect(atividadeDoLead()?.payload).toMatchObject({ cliente: false });
  });

  it("CONTROLE · só negócio PERDIDO não vira cliente (nenhuma venda ganha)", async () => {
    // A recusa do banco é `status = 'won'`: o dublê devolve `null` para a leitura
    // de ganho, que é o que o Postgres faria com um lead `lost`.
    const c = novaCena({ venda: null });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, pipelineId: FUNIL_PADRAO });
  });

  it("CONTROLE · first_service_at continua valendo como hoje (regra da agenda ligada)", async () => {
    const c = novaCena({
      firstServiceAt: "2026-09-01T10:00:00.000Z",
      settings: { crm: { cliente_pela_agenda: true, cliente_pela_venda: false } },
    });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, pipelineId: FUNIL_CLIENTES });
    expect(atividadeDoLead()?.reason).toBe("cliente conhecido voltou a escrever");
  });

  it("CONTROLE · agenda DESLIGADA com data preenchida não vira cliente (nada afrouxou)", async () => {
    const c = novaCena({
      firstServiceAt: "2026-09-01T10:00:00.000Z",
      settings: { crm: { cliente_pela_agenda: false, cliente_pela_venda: false } },
    });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, pipelineId: FUNIL_PADRAO });
  });

  it("negócio ABERTO decide antes: 'ja_existe', sem ler venda nem funil", async () => {
    const c = novaCena({ leadAberto: true, venda: vendaHa(12) });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: false, motivo: "ja_existe" });
    expect(c.nascimentos).toBe(0);
    // Duas leituras: o contato e o negócio aberto. Nada de settings nem venda.
    expect(c.consultas).toEqual(["contacts", "crm_leads"]);
  });

  it("pós-venda DENTRO da janela: não abre negócio nenhum, motivo 'pos_venda'", async () => {
    const c = novaCena({
      venda: vendaHa(3),
      settings: { crm: { cliente_pela_venda: true, pos_venda_dias: 30 } },
    });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: false, motivo: "pos_venda" });
    expect(c.nascimentos).toBe(0);
  });

  it("pós-venda FORA da janela: o card nasce no funil de clientes", async () => {
    const c = novaCena({
      venda: vendaHa(40),
      settings: { crm: { cliente_pela_venda: true, pos_venda_dias: 30 } },
    });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, pipelineId: FUNIL_CLIENTES });
  });
});

describe("#3644 · o custo por mensagem recebida", () => {
  it("mensagem de conversa que JÁ tem card custa as MESMAS 2 leituras de antes, com a chave ligada", async () => {
    const c = novaCena({ leadAberto: true, venda: vendaHa(12) });

    // Três mensagens seguidas: o custo não cresce com o número de mensagens —
    // que é a definição de N+1 que esta entrega não podia introduzir.
    for (let i = 0; i < 3; i++) await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(c.consultas).toEqual([
      "contacts", "crm_leads",
      "contacts", "crm_leads",
      "contacts", "crm_leads",
    ]);
  });

  it("criação de card com a chave DESLIGADA não lê venda nenhuma", async () => {
    const c = novaCena({
      settings: { crm: { cliente_pela_agenda: false, cliente_pela_venda: false } },
    });
    await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(c.consultas).toEqual(["contacts", "crm_leads", "organizations", "crm_pipelines", "crm_stages"]);
  });

  it("criação de card com a chave LIGADA lê uma venda e um nome — número fixo, não por mensagem", async () => {
    const c = novaCena({ venda: vendaHa(12) });
    await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(c.consultas).toEqual([
      "contacts",
      "crm_leads", // negócio aberto
      "organizations", // as três chaves de settings.crm, numa leitura
      "crm_leads", // a venda ganha
      "crm_pipelines", // nome do funil da venda (só para o texto)
      "crm_pipelines", // funil de clientes
      "crm_stages",
    ]);
  });
});
