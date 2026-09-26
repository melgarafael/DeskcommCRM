/**
 * Dublê de banco das rotas de FUNIL e de ETAPA (`app/api/v1/pipelines/**`).
 *
 * Ele APLICA os filtros `eq`/`neq`, a projeção do `select()`, o `order()` e o
 * `count`/`head` de verdade. Um stub de linha fixa deixaria "etapa de outra
 * organização → 404" passar mesmo com o `eq("organization_id", …)` apagado da
 * rota: mediria o dublê, não o handler.
 *
 * Ele também registra CADA escrita (update e insert) com seus filtros e com
 * marcas de início/fim, porque três garantias desta task são sobre a emissão em
 * si: "nenhuma escrita quando é 404", "desmarcar antes de marcar" e "mover os
 * negócios antes de arquivar a etapa".
 */
import { expect, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import type { EspecieDeAutor } from "@/lib/operacao/autoria";

export const ORG_ID = "22222222-2222-4222-8222-222222222222";
export const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const PIPE = "44444444-4444-4444-8444-444444444444";

export interface StageRow {
  id: string;
  name: string;
  slug: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  agent_stage_hint: string | null;
  pipeline_id: string;
  organization_id: string;
}

export function etapa(over: Partial<StageRow> & { id: string; name: string }): StageRow {
  return {
    slug: over.id,
    position: 1,
    is_won: false,
    is_lost: false,
    is_archived: false,
    agent_stage_hint: null,
    pipeline_id: PIPE,
    organization_id: ORG_ID,
    ...over,
  };
}

export interface LeadRow {
  id: string;
  stage_id: string;
  pipeline_id: string;
  organization_id: string;
  contact_id: string | null;
}

export function negocio(id: string, stageId: string, over: Partial<LeadRow> = {}): LeadRow {
  return {
    id,
    stage_id: stageId,
    pipeline_id: PIPE,
    organization_id: ORG_ID,
    contact_id: null,
    ...over,
  };
}

export interface PipelineRow {
  id: string;
  name: string;
  /** settings do funil — é dele que `settingsDoFunil` lê (issue #1536). */
  settings?: Record<string, unknown> | null;
  slug: string;
  description: string | null;
  position: number;
  is_default: boolean;
  is_archived: boolean;
  organization_id: string;
}

export function funilRow(over: Partial<PipelineRow> & { id: string; name: string }): PipelineRow {
  return {
    slug: over.id,
    description: null,
    position: 1000,
    is_default: false,
    is_archived: false,
    organization_id: ORG_ID,
    ...over,
  };
}

export interface Escrita {
  tipo: "update" | "insert" | "delete";
  table: string;
  /** O corpo como a rota o mandou: linha no update/insert simples, ARRAY no insert multi-linha. */
  patch: Record<string, unknown> | Record<string, unknown>[];
  filtros: Array<[string, unknown]>;
}

export interface DbOpts {
  /** Org dona do pipeline — troque para simular funil de outro tenant. */
  pipelineOrg?: string;
  stages?: StageRow[];
  leads?: LeadRow[];
  /** Os funis da org. Sem isto, uma linha só (`PIPE`), que é o que as rotas de etapa precisam. */
  pipelines?: PipelineRow[];
  /** Fontes de webhook — o `default_pipeline_id` delas é FK CASCADE para o funil. */
  webhookSources?: Array<Record<string, unknown>>;
  /** Automações — `actions` é jsonb cru, sem FK para o funil. */
  automationRules?: Array<Record<string, unknown>>;
  /**
   * Contatos — `createLeadHandler`/`updateLeadHandler` recusam com 404 o
   * `contact_id` que não for da organização, então quem cria lead com contato
   * precisa declarar que ele existe e de quem é.
   */
  contacts?: Array<Record<string, unknown>>;
  /** Erro do banco na n-ésima escrita (1-based), como o PostgREST devolveria. */
  writeError?: (n: number, table: string) => { code: string; message: string } | null;
}

type Linha = Record<string, unknown>;

export interface Registro {
  /**
   * O MESMO dublê que `createClient` devolve, exposto para injeção direta.
   *
   * As operações de `lib/operacao/` e `lib/leads/stage-operations.ts` recebem o
   * cliente por parâmetro (é o que permite a rota usar o client do usuário e a
   * tool usar o service-role). Sem esta saída, testá-las exigiria um segundo
   * dublê — e dois dublês da mesma tabela divergem no primeiro ajuste, que é
   * exatamente o defeito que a extração da regra existe para evitar.
   */
  client: { from: (table: string) => unknown; rpc: (nome: string, args: unknown) => Promise<unknown> };
  escritas: Escrita[];
  eventos: string[];
  rpcs: Array<{ nome: string; args: unknown }>;
  /** As tabelas DEPOIS das escritas — é aqui que se confere que os negócios andaram. */
  tabelas: {
    crm_pipelines: Linha[];
    crm_stages: Linha[];
    crm_leads: Linha[];
    crm_lead_activities: Linha[];
    webhook_sources: Linha[];
    automation_rules: Linha[];
    contacts: Linha[];
  };
}

/**
 * Uma cláusula de `.or(...)` — o OU do PostgREST (`owner_user_id.is.null,
 * owner_user_id.eq.<uuid>`).
 */
interface Clausula {
  coluna: string;
  op: "is" | "eq" | "neq";
  valor: unknown;
}

/**
 * Lê a expressão do `.or()`, ou LANÇA.
 *
 * ⚠️ LANÇAR É O PONTO. Um dublê que engole a cláusula que não entende devolve a
 * linha que o filtro existia para excluir e o teste mede o dublê, não o código:
 * foi assim que um vazamento de tenant passaria verde. Só as três formas que o
 * repo usa estão implementadas (`.is.`, `.eq.`, `.neq.`); qualquer outra coisa
 * para aqui, alto.
 */
function clausulasDoOu(expressao: string): Clausula[] {
  return expressao.split(",").map((bruta) => {
    const [coluna, op, ...resto] = bruta.trim().split(".");
    if (!coluna || !op || resto.length !== 1 || (op !== "is" && op !== "eq" && op !== "neq")) {
      throw new Error(`dublê: cláusula de .or() não suportada: "${bruta}"`);
    }
    const cru = resto[0]!;
    if (op === "is" && cru !== "null") {
      throw new Error(`dublê: .is("${coluna}", ...) só é suportado com null (veio "${cru}")`);
    }
    return { coluna, op, valor: op === "is" ? null : cru };
  });
}

/** A cláusula casa a linha? `is null` inclui o `undefined` (coluna ausente é nula). */
function casa(linha: Linha, clausula: Clausula): boolean {
  const valor = linha[clausula.coluna];
  if (clausula.op === "is") return valor === null || valor === undefined;
  if (clausula.op === "eq") return valor === clausula.valor;
  return valor !== null && valor !== undefined && valor !== clausula.valor;
}

export function makeDb(opts: DbOpts = {}): Registro {
  const registro: Registro = {
    // preenchido no fim, quando `builder` e `rpc` já existem
    client: null as unknown as Registro["client"],
    escritas: [],
    eventos: [],
    rpcs: [],
    tabelas: {
      crm_pipelines: (opts.pipelines ?? [
        { id: PIPE, name: "Pedidos", organization_id: opts.pipelineOrg ?? ORG_ID },
      ]) as unknown as Linha[],
      crm_stages: (opts.stages ?? []) as unknown as Linha[],
      crm_leads: (opts.leads ?? []) as unknown as Linha[],
      crm_lead_activities: [],
      webhook_sources: (opts.webhookSources ?? []) as Linha[],
      automation_rules: (opts.automationRules ?? []) as Linha[],
      contacts: (opts.contacts ?? []) as Linha[],
    },
  };
  const tables = registro.tabelas as unknown as Record<string, Linha[] | undefined>;
  let nEscrita = 0;

  function builder(table: string) {
    const filtros: Array<[string, unknown]> = [];
    const pertinencias: Array<[string, unknown[]]> = [];
    const negacoes: Array<[string, unknown]> = [];
    const disjuncoes: Clausula[][] = [];
    let patch: Record<string, unknown> | null = null;
    let nova: Record<string, unknown> | Record<string, unknown>[] | null = null;
    let colunas: string[] | null = null;
    let ordem: string | null = null;
    let contar = false;
    let head = false;
    let apagar = false;
    let teto: number | null = null;

    const casam = () =>
      (tables[table] ?? [])
        .filter((r) => filtros.every(([c, v]) => r[c] === v))
        .filter((r) => pertinencias.every(([c, vs]) => vs.includes(r[c])))
        // `neq` em SQL exclui NULL (`NULL <> v` nao e verdadeiro) — o duble
        // segue o banco, nao o JavaScript.
        .filter((r) => negacoes.every(([c, v]) => r[c] !== null && r[c] !== undefined && r[c] !== v))
        // `.or()` é OU entre as cláusulas da MESMA chamada e E com os outros
        // filtros — a mesma combinação do PostgREST.
        .filter((r) =>
          disjuncoes.every((clausulas) => clausulas.some((clausula) => casa(r, clausula))),
        );

    /**
     * Ordena, corta e projeta como o PostgREST faria.
     *
     * `tabela(coluna)` no select é um EMBED: o PostgREST devolve a chave
     * `tabela`, não a string inteira. Projetar pelo literal deixaria o join
     * sempre `undefined` — e um teste sobre o nome da regra mediria o dublê.
     */
    const lidos = () => {
      let rows = [...casam()];
      if (ordem) rows.sort((a, b) => Number(a[ordem!]) - Number(b[ordem!]));
      if (teto !== null) rows = rows.slice(0, teto);
      // `select("*")` (usado por `app/api/v1/leads/_handler.ts`) é o CURINGA do
      // PostgREST — a linha inteira, não uma coluna literal chamada "*". Sem
      // este ramo, o projetor abaixo tratava "*" como nome de coluna e devolvia
      // `{"*": undefined}`: toda leitura virava linha vazia, e quem chama
      // (`moveLeadHandler`) lia `lead.organization_id === undefined` e
      // respondia 404 "Lead não encontrado" mesmo com o lead presente na
      // tabela — media o dublê, não o handler.
      if (!colunas || colunas.length === 1 && colunas[0] === "*") return rows;
      const chaves = colunas.map((c) => /^(\w+)\(/.exec(c)?.[1] ?? c);
      return rows.map((r) => Object.fromEntries(chaves.map((c) => [c, r[c]])));
    };

    async function escreve(
      tipo: Escrita["tipo"],
      corpo: Record<string, unknown> | Record<string, unknown>[],
      aplica: () => void,
    ): Promise<{ data: unknown; error: unknown; count: number | null }> {
      const i = nEscrita++;
      registro.escritas.push({ tipo, table, patch: corpo, filtros: [...filtros] });
      registro.eventos.push(`start:${table}:${i}`);
      // Folga real: sem ela, escritas disparadas em paralelo teriam o mesmo
      // intercalamento de um laço sequencial e o teste de ordem não mediria nada.
      await new Promise((r) => setTimeout(r, 0));
      registro.eventos.push(`end:${table}:${i}`);
      const err = opts.writeError?.(i + 1, table) ?? null;
      if (err) return { data: null, error: err, count: null };
      aplica();
      return { data: null, error: null, count: null };
    }

    async function run(): Promise<{ data: unknown; error: unknown; count: number | null }> {
      // ⚠️ O DELETE NÃO CASCATEIA AQUI, e é deliberado. No banco,
      // `webhook_sources.default_pipeline_id` é `ON DELETE CASCADE` — simular
      // isso faria o dublê provar o Postgres em vez da rota. O que a rota deve
      // garantir é NUNCA chegar ao delete com dependente vivo, e é isso que os
      // testes medem: a escrita que não sai.
      if (apagar) {
        const alvos = casam();
        const r = await escreve("delete", {}, () => {
          const restantes = (tables[table] ?? []).filter((l) => !alvos.includes(l));
          tables[table] = restantes;
          registro.tabelas[table as keyof Registro["tabelas"]] = restantes;
        });
        return r.error ? r : { ...r, data: alvos.map((l) => ({ ...l })) };
      }
      if (patch) {
        const alvos = casam();
        const r = await escreve("update", patch, () => {
          for (const linha of alvos) Object.assign(linha, patch);
        });
        return r.error ? r : { ...r, data: alvos.map((l) => ({ ...l })) };
      }
      if (nova) {
        // `insert` aceita linha OU array — a rota de arquivamento grava as
        // atividades num ÚNICO insert multi-linha, e um dublê que só entende
        // linha solta esconderia justamente isso.
        const linhas = (Array.isArray(nova) ? nova : [nova]).map((l, k) => ({
          id: `novo-${nEscrita + 1}-${k}`,
          ...l,
        }));
        const r = await escreve("insert", nova, () => {
          (tables[table] ??= []).push(...linhas);
        });
        return r.error ? r : { ...r, data: linhas };
      }
      // `head: true` NÃO traz linhas; `count` sozinho traz linhas E contagem —
      // é assim que o PostgREST responde, e a diferença não é acadêmica: o dublê
      // devolvendo `data: null` para `select(..., { count })` fez a emissão de
      // atividades do arquivamento sumir com a suíte verde.
      if (head) return { data: null, error: null, count: casam().length };
      if (contar) return { data: lidos(), error: null, count: casam().length };
      return { data: lidos(), error: null, count: null };
    }

    const b = {
      select: (cols?: string, o?: { count?: string; head?: boolean }) => {
        colunas = cols ? cols.split(",").map((c) => c.trim()) : null;
        if (o?.count) contar = true;
        if (o?.head) head = true;
        return b;
      },
      insert: (r: Record<string, unknown> | Record<string, unknown>[]) => {
        nova = r;
        return b;
      },
      update: (p: Record<string, unknown>) => {
        patch = p;
        return b;
      },
      delete: () => {
        apagar = true;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      /** `.is(col, null)` — o único uso real no repo é "convite não revogado". */
      is: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      /** `.in(col, [...])` vira um filtro de pertinência, não de igualdade. */
      in: (c: string, vs: unknown[]) => {
        pertinencias.push([c, vs]);
        return b;
      },
      /**
       * `.or(expr)` — o caso real do repo é o "compartilhado OU próprio" da
       * leitura de modelos de mensagem (`owner_user_id.is.null,owner_user_id.eq.<id>`),
       * que é a policy da tabela repetida em SQL. Um `.or()` ignorado devolveria
       * a linha pessoal de OUTRA pessoa e o teste do vazamento mediria o dublê.
       */
      or: (expressao: string) => {
        disjuncoes.push(clausulasDoOu(expressao));
        return b;
      },
      /**
       * `.neq(col, v)` — filtro de DESIGUALDADE.
       *
       * O dublê nasceu aplicando só `eq`. A #992 trouxe o primeiro uso real de
       * `neq` (a busca pelo negócio aberto do contato em OUTRO funil): sem este
       * ramo, a chamada estourava e a ação devolvia `failed` — o teste media o
       * dublê, não o código.
       */
      neq: (c: string, v: unknown) => {
        negacoes.push([c, v]);
        return b;
      },
      limit: (n: number) => {
        teto = n;
        return b;
      },
      order: (col: string) => {
        ordem = col;
        return b;
      },
      maybeSingle: async () => {
        const r = await run();
        return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = await run();
        const linha = (r.data as unknown[] | null)?.[0] ?? null;
        if (!r.error && !linha) {
          return { data: null, error: { code: "PGRST116", message: "no rows" } };
        }
        return { data: linha, error: r.error };
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej),
    };
    return b;
  }

  // `rpc` só existe para o aviso de atividade perdida (`emit_event`): sem ele, a
  // rota estouraria no caminho de falha e o teste mediria um TypeError em vez do
  // comportamento ("o arquivamento não é desfeito por causa do rastro").
  const rpc = async (nome: string, args: unknown) => {
    registro.rpcs.push({ nome, args });
    return { data: null, error: null };
  };

  registro.client = { from: builder, rpc } as unknown as Registro["client"];
  vi.mocked(createClient).mockResolvedValue(registro.client as never);
  return registro;
}

/**
 * O patch esperado, mais a autoria que TODA escrita em `crm_stages` carrega.
 *
 * ⚠️ EXISTE PARA O `toEqual` CONTINUAR EXATO. Trocar os `toEqual` por
 * `objectContaining` seria a saída fácil e mataria a garantia que estes testes
 * dão desde o começo: nenhum campo A MAIS na escrita. Aqui a autoria é declarada
 * — some do patch e o teste reprova, aparece uma coluna nova sem ninguém pedir e
 * o teste reprova também.
 *
 * `last_change_at` é `any(String)` porque é o relógio: fixá-lo mediria o
 * `Date.now()`, não a operação.
 */
export function comAutoria(
  patch: Record<string, unknown>,
  quem: EspecieDeAutor = "user",
): Record<string, unknown> {
  return { ...patch, last_change_actor_kind: quem, last_change_at: expect.any(String) };
}

export function authOk(role: "manager" | "admin" = "manager"): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

/**
 * Funil de trabalho: duas etapas comuns, uma de ganho e uma de perda.
 *
 * DE PROPÓSITO fora da ordem de `position` — se a tabela já viesse ordenada, o
 * `.order("position")` da rota poderia sumir com a suíte verde enquanto a tela
 * mostra as etapas embaralhadas (e a etapa nova nasceria no meio do funil).
 */
export function funil(): StageRow[] {
  return [
    etapa({ id: "e3", name: "Pago", slug: "pago", position: 3000, is_won: true }),
    etapa({ id: "e1", name: "Novo", slug: "novo", position: 1000 }),
    etapa({ id: "e4", name: "Cancelado", slug: "cancelado", position: 4000, is_lost: true }),
    etapa({ id: "e2", name: "Proposta", slug: "proposta", position: 2000 }),
  ];
}
