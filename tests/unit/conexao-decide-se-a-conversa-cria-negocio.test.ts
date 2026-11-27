/**
 * #4670 — A CONEXÃO DECIDE SE A CONVERSA NOVA ABRE NEGÓCIO.
 *
 * ═══ O pedido, e o que ele NÃO é ═══
 *
 * Uma empresa com vários números usa só alguns para vender. Até aqui, toda
 * conversa nova, em qualquer número, abria card no funil padrão — e o funil
 * enchia de negócio que alguém precisava perder à mão. O pedido é POR NÚMERO:
 * desligar para a organização inteira já existia
 * (`settings.crm.entrada_automatica_no_funil`) e não resolve.
 *
 * Desligada, a pessoa não pode sumir: o contato nasce, a conversa aparece no
 * Inbox, o agente de IA atende e o card só não nasce. Criar à mão continua
 * igual — `crm_create_lead`, o botão da tela e a ficha do contato não passam por
 * `garantirLeadDaConversa`.
 *
 * ═══ O que este arquivo mede ═══
 *
 *   1. duas conexões da MESMA organização, uma desligada: a mensagem que chega
 *      na desligada não cria card e registra o motivo; a que chega na ligada
 *      cria como hoje;
 *   2. o CONTROLE da instalação antiga: sem a chave (conversa sem a relação, ou
 *      banco sem a migration) o comportamento é o de hoje — e o DDL da coluna
 *      nasce `default true`, que é o que faz a atualização ser invisível;
 *   3. organização B não lê a chave da A — e a consulta leva a organização no
 *      filtro, que é o que impede o vazamento;
 *   4. falha de leitura NÃO cria o card nesta mensagem (a próxima tenta de novo:
 *      o nascimento é idempotente por contato);
 *   5. a criação à mão não conhece a chave.
 *
 * Comando:
 *     pnpm vitest run tests/unit/conexao-decide-se-a-conversa-cria-negocio.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// A campanha e a atividade não são o assunto: `null`/`ok` mantêm o caminho no
// nascimento, que é onde a decisão mora.
vi.mock("@/lib/campanhas/origem-do-lead", () => ({
  origemDeCampanhaDaConversa: vi.fn(async () => null),
  marcaDaOrigem: vi.fn(() => ({ source: "campanha", source_metadata: {} })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

const ORG_A = "org-a";
const ORG_B = "org-b";
const CONTATO = "contato-1";
/** Duas conexões da MESMA organização — é o caso da issue. */
const CONVERSA_DESLIGADA = "conv-do-numero-de-suporte";
const CONVERSA_LIGADA = "conv-do-numero-de-vendas";

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

/** A conexão do número, como a leitura embutida a devolve. */
type ConexaoNaCena =
  /** `false` = desligada; `true` = ligada; `null` = linha sem a relação (instalação antiga). */
  | { tipo: "com-chave"; cria: boolean }
  | { tipo: "sem-relacao" }
  /** O banco sem a migration: o PostgREST devolve 42703 nomeando a coluna. */
  | { tipo: "sem-coluna" }
  /** Falha de leitura de verdade. */
  | { tipo: "erro"; code: string; message: string };

interface Cena {
  /** De quem é a conversa. Organização diferente no argumento = não acha a linha. */
  orgDaConversa: string;
  conexao: ConexaoNaCena;
  /** Quantas vezes a RPC de nascimento foi chamada. */
  nascimentos: number;
  /** Filtros de cada leitura, por tabela. */
  consultas: Array<{ tabela: string; filtros: Record<string, unknown> }>;
}

function novaCena(parcial: Partial<Cena> = {}): Cena {
  return {
    orgDaConversa: ORG_A,
    conexao: { tipo: "com-chave", cria: true },
    nascimentos: 0,
    consultas: [],
    ...parcial,
  };
}

/**
 * O dublê do `SupabaseClient`. Aplica `eq` e resolve por (tabela, filtros), e
 * registra CADA leitura: é assim que o teste prova que a organização vai no
 * filtro da consulta, em vez de confiar que o PostgREST filtraria por nós.
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
      c.consultas.push({ tabela: nome, filtros: { ...filtros } });
      if (nome === "contacts")
        return Promise.resolve({ data: { ...CONTATO_BASE, tags: [] }, error: null });

      if (nome === "conversations") {
        // A leitura real filtra organização E id: conversa de outra organização
        // não volta, e é por isso que a chave dela não é lida.
        const daOrg = filtros.organization_id === c.orgDaConversa;
        if (!daOrg) return Promise.resolve({ data: null, error: null });
        switch (c.conexao.tipo) {
          case "sem-coluna":
            return Promise.resolve({
              data: null,
              error: {
                code: "42703",
                message: 'column channel_sessions_1.conversa_nova_cria_negocio does not exist',
              },
            });
          case "erro":
            return Promise.resolve({
              data: null,
              error: { code: c.conexao.code, message: c.conexao.message },
            });
          case "sem-relacao":
            return Promise.resolve({ data: { channel_session_id: "sess-1" }, error: null });
          case "com-chave":
            return Promise.resolve({
              data: {
                channel_session_id: "sess-1",
                channel_sessions: { conversa_nova_cria_negocio: c.conexao.cria },
              },
              error: null,
            });
        }
      }

      if (nome === "organizations") return Promise.resolve({ data: { settings: {} }, error: null });
      if (nome === "crm_leads") return Promise.resolve({ data: null, error: null });
      if (nome === "crm_pipelines")
        return Promise.resolve({ data: { id: "funil-entrada", settings: {} }, error: null });
      if (nome === "crm_stages") return Promise.resolve({ data: { id: "etapa-1" }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    return chain;
  };

  return {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string) => {
      if (fn === "fn_nascer_lead_da_conversa" || fn === "fn_nascer_lead_da_mensagem") {
        c.nascimentos += 1;
        return { data: "lead-novo", error: null };
      }
      return { data: null, error: null };
    },
  } as never;
}

function dados(conversationId: string, organizationId = ORG_A) {
  return { organizationId, contactId: CONTATO, conversationId, nomeDoContato: "Marina" };
}

beforeEach(() => vi.clearAllMocks());

describe("#4670 · duas conexões da mesma organização", () => {
  it("a mensagem na conexão DESLIGADA não cria card e registra o motivo", async () => {
    const c = novaCena({ conexao: { tipo: "com-chave", cria: false } });

    const r = await garantirLeadDaConversa(adminFake(c), dados(CONVERSA_DESLIGADA));

    // O motivo próprio é o registro: `ja_existe` diria "o card está lá", e não
    // está — quem procura a pessoa no funil não acharia nada e não saberia por quê.
    expect(r).toEqual({ criado: false, motivo: "conexao_nao_cria_negocio" });
    expect(c.nascimentos, "nenhuma RPC de nascimento pode ter sido chamada").toBe(0);
  });

  it("a mensagem na conexão LIGADA cria como hoje, no funil de entrada", async () => {
    const c = novaCena({ conexao: { tipo: "com-chave", cria: true } });

    const r = await garantirLeadDaConversa(adminFake(c), dados(CONVERSA_LIGADA));

    expect(r).toMatchObject({ criado: true, pipelineId: "funil-entrada", stageId: "etapa-1" });
    expect(c.nascimentos).toBe(1);
  });

  it("a decisão é da CONEXÃO: desligar uma não desliga a outra", async () => {
    // As duas cenas são da MESMA organização; o que muda é a conexão da conversa.
    const desligada = novaCena({ conexao: { tipo: "com-chave", cria: false } });
    const ligada = novaCena({ conexao: { tipo: "com-chave", cria: true } });

    expect(await garantirLeadDaConversa(adminFake(desligada), dados(CONVERSA_DESLIGADA))).toMatchObject({
      criado: false,
      motivo: "conexao_nao_cria_negocio",
    });
    expect(await garantirLeadDaConversa(adminFake(ligada), dados(CONVERSA_LIGADA))).toMatchObject({
      criado: true,
    });
  });
});

describe("#4670 · o que NÃO podia mudar", () => {
  it("CONTROLE: instalação antiga, conversa sem a relação da conexão — cria como hoje", async () => {
    const c = novaCena({ conexao: { tipo: "sem-relacao" } });

    expect(await garantirLeadDaConversa(adminFake(c), dados(CONVERSA_LIGADA))).toMatchObject({
      criado: true,
    });
    expect(c.nascimentos).toBe(1);
  });

  it("CONTROLE: chave ausente no banco (migration pendente) — cria como hoje, e não recusa", async () => {
    const c = novaCena({ conexao: { tipo: "sem-coluna" } });

    const r = await garantirLeadDaConversa(adminFake(c), dados(CONVERSA_LIGADA));

    // Recusar aqui seria a instalação inteira parar de pôr gente no funil por
    // causa de uma migration que ainda não rodou.
    expect(r).toMatchObject({ criado: true });
    expect(c.nascimentos).toBe(1);
  });

  it("organização B não lê a chave da A: a conversa da A não é encontrada, e o filtro leva a B", async () => {
    // A conversa é da ORG_A e a conexão dela está DESLIGADA.
    const c = novaCena({ orgDaConversa: ORG_A, conexao: { tipo: "com-chave", cria: false } });

    const r = await garantirLeadDaConversa(adminFake(c), dados(CONVERSA_DESLIGADA, ORG_B));

    // B não herda a decisão de A — e o caminho é o de hoje, porque não há chave
    // de B nesta conversa.
    expect(r).toMatchObject({ criado: true });
    const leitura = c.consultas.find((q) => q.tabela === "conversations");
    expect(leitura?.filtros, "a organização TEM de ir no filtro da consulta").toEqual({
      organization_id: ORG_B,
      id: CONVERSA_DESLIGADA,
    });
  });

  it("falha de leitura da conexão NÃO cria o card nesta mensagem", async () => {
    const c = novaCena({
      conexao: { tipo: "erro", code: "08006", message: "connection failure" },
    });

    const r = await garantirLeadDaConversa(adminFake(c), dados(CONVERSA_LIGADA));

    // `erro`, e não `conexao_nao_cria_negocio`: o sistema NÃO decidiu que este
    // número não abre negócio — ele não conseguiu perguntar.
    expect(r).toMatchObject({ criado: false, motivo: "erro" });
    expect(c.nascimentos).toBe(0);
  });

  it("CONTROLE: a coluna nasce LIGADA na migration e no espelho do baseline", () => {
    // O mock acima prova o ramo de leitura; ESTE caso prova o DDL, que é o que faz
    // a instalação antiga seguir como hoje sem abrir tela nenhuma: `default true`.
    // Inverter o default (nascendo desligado) derruba este caso — e só ele.
    const migrations = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((n) =>
      n.endsWith("_conexao_decide_se_a_conversa_cria_negocio.sql"),
    );
    expect(migrations, "a migration da #4670 tem de existir, e uma só").toHaveLength(1);
    const [arquivo] = migrations;
    if (!arquivo) throw new Error("migration da #4670 não encontrada");

    const declaracao = /add column if not exists conversa_nova_cria_negocio boolean not null default true;/;
    const migration = readFileSync(join(process.cwd(), "supabase", "migrations", arquivo), "utf8");
    expect(migration).toMatch(declaracao);

    // O espelho só pode ficar FORA da janela do invariante `lgpd-alcanca-fichas-fundidas`
    // (entre a cascata da 9243 e a VARREDURA anon): aquele trecho é comparado por
    // igualdade contra a migration da 9243.
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    expect(baseline).toMatch(declaracao);
    const janelaInicio = baseline.indexOf("-- ---- anonimizar alcança as fichas fundidas: a cascata (migration 9243)");
    const janelaFim = baseline.indexOf("-- ---- VARREDURA anon:");
    const posicao = baseline.indexOf("add column if not exists conversa_nova_cria_negocio");
    expect(posicao, "o espelho tem de estar no baseline").toBeGreaterThan(-1);
    expect(posicao < janelaInicio || posicao > janelaFim, "espelho FORA da janela do invariante").toBe(true);
  });

  it("a criação à mão não conhece a chave: `crm_create_lead` e o botão da tela seguem iguais", () => {
    const arquivos = [
      join(process.cwd(), "lib", "mcp", "tools", "leads.ts"),
      join(process.cwd(), "app", "api", "v1", "leads", "_handler.ts"),
    ];
    for (const caminho of arquivos) {
      const fonte = readFileSync(caminho, "utf8");
      expect(fonte, `${caminho}: a criação manual não passa pelo nascimento da conversa`).not.toContain(
        "garantirLeadDaConversa",
      );
      expect(fonte, `${caminho}: a criação manual não lê a chave da conexão`).not.toContain(
        "negocio-da-conversa",
      );
      expect(fonte, `${caminho}: a criação manual não lê a coluna`).not.toContain(
        "conversa_nova_cria_negocio",
      );
    }
  });
});
