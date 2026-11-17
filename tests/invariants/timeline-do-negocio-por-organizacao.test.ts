import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";
import {
  type Cursor,
  eixoDoDossie,
  filtroDaPagina,
  filtroDoCursor,
} from "@/lib/leads/timeline-query";

/**
 * #4324 — a linha do tempo do NEGÓCIO, contra Postgres real, com duas empresas.
 *
 * O conserto do eixo da organização já está na `main` (PR #4332): `filtroDaPagina`
 * e `filtroDoCursor` cercam a consulta com `and(organization_id.eq.X, …)`. O que
 * faltava era a prova de BANCO: o teste que veio com ele usa duble do PostgREST e
 * compara predicados — prova a intenção da consulta, não o que o Postgres devolve
 * com duas organizações de verdade na tabela.
 *
 * Este arquivo roda as MESMAS funções de produção (`filtroDaPagina`/
 * `filtroDoCursor`/`eixoDoDossie`) e traduz a árvore booleana do PostgREST para
 * SQL, em vez de reescrever o filtro à mão. Quem tirar `organization_id` da
 * consulta vê o teste cair: é a sabotagem que o prova.
 *
 * O QUE A MEDIÇÃO ACHOU — e contraria a leitura de "vazamento efetivo":
 *
 *  1. há um PORTÃO no banco: `trg_validate_activity_lead_org`
 *     (`baseline.sql:3068`) roda `fn_validate_activity_lead_org` (`:853`) ANTES
 *     do INSERT e recusa (`lead_org_mismatch`, 23514) atividade cuja
 *     `organization_id` divirja da do lead. A linha "de outra empresa com o
 *     `lead_id` casando" não nasce por INSERT. O invariante (a) mede a recusa,
 *     não a supõe;
 *  2. o portão é `BEFORE INSERT` — não há gatilho de UPDATE, e a tabela não tem
 *     policy de UPDATE (só `select`/`insert`), então sob RLS de `authenticated`
 *     a linha não muda de empresa. Quem poderia criar a incoerência é escritor
 *     privilegiado (`service_role`, que bypassa RLS). Por isso o teste constrói
 *     o estado com `session_replication_role = replica`: o cenário é de defesa
 *     em profundidade, e é assim que ele é medido, sem inventar gravidade;
 *  3. a policy `crm_lead_activities_select` (`baseline.sql:74335`) NÃO olha o
 *     `organization_id` da ATIVIDADE: ela faz `EXISTS` no lead-pai. Ou seja, se
 *     a linha incoerente existisse, a RLS a entregaria (invariante (a2) mede
 *     exatamente isso). O `organization_id` na consulta é a única camada que
 *     confere a empresa DA LINHA — não é enfeite de índice;
 *  4. a segunda perna do eixo (`contact_id = C and lead_id is null`) casa zero
 *     linhas por construção: `crm_lead_activities.lead_id` é NOT NULL
 *     (`baseline.sql:1440`). Por isso o invariante (c) avalia o predicado sobre
 *     `values` e MEDE a nulabilidade, em vez de inserir linha impossível.
 *
 * Namespace 859a (cada invariante roda no seu próprio banco, copiado do molde).
 */

const ORG_A = "859a0001-0000-4000-8000-000000000001";
const ORG_B = "859a0002-0000-4000-8000-000000000001";

const AGENTE_A = "859a1000-0000-4000-8000-000000000001";

const CONTATO_A = "859a3333-0000-4000-8000-000000000001";
const CONTATO_B = "859a3333-0000-4000-8000-000000000002";

const PIPELINE_A = "859a5555-0000-4000-8000-000000000001";
const STAGE_A = "859a5555-0000-4000-8000-000000000002";
const PIPELINE_B = "859a5556-0000-4000-8000-000000000001";
const STAGE_B = "859a5556-0000-4000-8000-000000000002";

/** O negócio da empresa A cuja linha do tempo é o alvo. */
const LEAD_A = "859a6666-0000-4000-8000-000000000001";
/** O negócio "normal": só atividades da própria empresa, sem intrusa. */
const LEAD_A2 = "859a6666-0000-4000-8000-000000000002";
/** O negócio da empresa B — tem de continuar 404. */
const LEAD_B = "859a6666-0000-4000-8000-000000000003";

function ativ(ordinal: number): string {
  return `859a7777-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/** Sete atividades da empresa A no negócio A, um minuto entre cada. */
const ATIVIDADES_A = [1, 2, 3, 4, 5, 6, 7].map(ativ);
/** A INTRUSA: diz empresa B, mas pendura no `lead_id` do negócio de A. */
const ATIVIDADE_INTRUSA = ativ(90);
/** Três atividades da empresa A no negócio "normal". */
const ATIVIDADES_A2 = [11, 12, 13].map(ativ);

function instante(minuto: number, segundo = 0, hora = 10): string {
  return `2026-01-01T${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}:${String(segundo).padStart(2, "0")}.000+00:00`;
}

// ---------------------------------------------------------------- tradutor ---

/**
 * Separa por vírgula só no nível de fora: `or(lead_id.eq.X,and(a,b))` tem
 * vírgula dentro do `and`, e cortar por `split(",")` cegamente partiria o filtro
 * no meio — que é como um duble de teste "passa" sem medir nada.
 */
function partes(deFora: string): string[] {
  const saida: string[] = [];
  let profundidade = 0;
  let atual = "";
  for (const c of deFora) {
    if (c === "(") profundidade += 1;
    if (c === ")") profundidade -= 1;
    if (c === "," && profundidade === 0) {
      saida.push(atual);
      atual = "";
      continue;
    }
    atual += c;
  }
  if (atual.trim() !== "") saida.push(atual);
  return saida.map((p) => p.trim());
}

/**
 * Traduz a árvore booleana que o PostgREST recebe (`and(...)`, `or(...)`,
 * `coluna.op.valor`) para o `WHERE` equivalente. Operador desconhecido LANÇA:
 * um filtro novo que este tradutor não entenda tem de aparecer como falha, não
 * como "nenhuma linha, tudo certo".
 */
function condicaoSql(filtro: string): string {
  const f = filtro.trim();

  for (const operador of ["and", "or"] as const) {
    if (f.startsWith(`${operador}(`) && f.endsWith(")")) {
      const dentro = f.slice(operador.length + 1, -1);
      const sqlPartes = partes(dentro).map(condicaoSql);
      return `(${sqlPartes.join(operador === "and" ? " and " : " or ")})`;
    }
  }

  const folha = /^([a-z_]+)\.([a-z]+)\.(.*)$/.exec(f);
  if (!folha) throw new Error(`filtro fora da gramática: ${f}`);
  const [, coluna, op, valor] = folha as unknown as [string, string, string, string];

  if (op === "eq") return `${coluna} = '${valor}'`;
  if (op === "lt") return `${coluna} < '${valor}'`;
  if (op === "gt") return `${coluna} > '${valor}'`;
  if (op === "is" && valor === "null") return `${coluna} is null`;
  throw new Error(`operador sem tradução: ${op} (${f})`);
}

// ------------------------------------------------------------------ consulta ---

interface Linha {
  id: string;
  performed_at: string;
}

/**
 * Roda a consulta como a rota monta: os filtros são CONJUNÇÃO (a rota chama
 * `.or(...)` duas vezes, e o PostgREST junta os grupos com AND), ordem
 * `performed_at desc, id desc`, `limit + 1` para saber se há mais.
 */
function consultar(filtros: string[], limite: number): Linha[] {
  const onde = filtros.map(condicaoSql).join(" and ");
  const saida = sql(`
    select id,
           to_char(performed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"+00:00"')
      from public.crm_lead_activities
     where ${onde}
     order by performed_at desc, id desc
     limit ${limite}
  `);
  if (saida === "") return [];
  return saida.split("\n").map((linha) => {
    const [id, performed_at] = linha.split("|") as [string, string];
    return { id, performed_at };
  });
}

/**
 * Roda um DML que DEVE ser recusado e devolve a mensagem do banco. Se passar,
 * devolve a frase explícita — um teste que aceita o estado proibido em silêncio
 * é pior do que não existir.
 */
function erroDoBanco(script: string): string {
  try {
    sql(script);
  } catch (err) {
    const bruto = (err as { stderr?: string | Buffer }).stderr ?? "";
    const texto = typeof bruto === "string" ? bruto : bruto.toString("utf8");
    const mensagem = /ERROR:\s+(\w+)/.exec(texto);
    return mensagem ? (mensagem[1] as string) : texto.slice(0, 200);
  }
  return "(o banco ACEITOU o estado incoerente)";
}

/**
 * A consulta de ONTEM (`main` em 510ed04d4): o eixo do dossiê sem o eixo da
 * empresa. É a régua contra a qual o "caso normal" é comparado e a prova de que
 * a intrusa voltava antes do conserto.
 */
function filtroDeOntem(leadId: string, contactId: string | null): string {
  const eixo = eixoDoDossie(leadId, contactId);
  return eixo ? `or(${eixo})` : `lead_id.eq.${leadId}`;
}

// -------------------------------------------------------------------- fixture ---

beforeAll(() => {
  // Empresa A, negócio A (o alvo) e negócio A2 (o caso sem intrusa).
  const atividadesSemIntrusa = [
    ...ATIVIDADES_A.map(
      (id, i) =>
        `('${id}', '${ORG_A}', '${LEAD_A}', '${CONTATO_A}', 'crm', 'nota', '${instante(i + 1)}', 'user')`,
    ),
    // Relógio próprio (09h) para que o negócio "normal" não empate com o alvo.
    ...ATIVIDADES_A2.map(
      (id, i) =>
        `('${id}', '${ORG_A}', '${LEAD_A2}', '${CONTATO_A}', 'crm', 'nota', '${instante(i + 1, 0, 9)}', 'user')`,
    ),
  ].join(",\n      ");

  sql(`
    insert into auth.users (id, email) values ('${AGENTE_A}', 'agente-a@invariant.test');
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-859a-a', 'Inv 859a A', 'Inv 859a A'),
      ('${ORG_B}', 'inv-859a-b', 'Inv 859a B', 'Inv 859a B')
    on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${AGENTE_A}', '${ORG_A}', 'agent', now()) on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Contato 859a A'),
      ('${CONTATO_B}', '${ORG_B}', 'Contato 859a B')
    on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE_A}', '${ORG_A}', 'Funil 859a A', 'funil-859a-a'),
      ('${PIPELINE_B}', '${ORG_B}', 'Funil 859a B', 'funil-859a-b')
    on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPELINE_A}', 'Etapa 859a A', 'etapa-859a-a', 1000),
      ('${STAGE_B}', '${ORG_B}', '${PIPELINE_B}', 'Etapa 859a B', 'etapa-859a-b', 1000)
    on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, owner_user_id) values
      ('${LEAD_A}', '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', '${CONTATO_A}', 'Negócio 859a A', '${AGENTE_A}'),
      ('${LEAD_A2}', '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', null, 'Negócio 859a A2', '${AGENTE_A}'),
      ('${LEAD_B}', '${ORG_B}', '${PIPELINE_B}', '${STAGE_B}', '${CONTATO_B}', 'Negócio 859a B', null)
    on conflict do nothing;
    -- As atividades da empresa A entram normalmente (o portão de INSERT as aceita).
    insert into public.crm_lead_activities
      (id, organization_id, lead_id, contact_id, source_module, type, performed_at, actor_kind)
    values
      ${atividadesSemIntrusa}
    on conflict do nothing;

    -- A INTRUSA só existe com o portão contornado: é o estado que um escritor
    -- privilegiado (service_role) poderia deixar para trás. Recriamos o cenário
    -- em vez de fingi-lo — e o invariante (a0) mede a recusa no caminho normal.
    set session_replication_role = replica;
    insert into public.crm_lead_activities
      (id, organization_id, lead_id, contact_id, source_module, type, performed_at, actor_kind)
    values ('${ATIVIDADE_INTRUSA}', '${ORG_B}', '${LEAD_A}', '${CONTATO_A}', 'crm', 'nota', '${instante(3, 30)}', 'user')
    on conflict do nothing;
    set session_replication_role = origin;
  `);
});

// ----------------------------------------------------------------- invariantes ---

describe("#4324 — a linha do tempo do negócio diz de qual empresa é", () => {
  /**
   * (a0) O caminho NORMAL de escrita já recusa a linha incoerente: o gatilho
   * `trg_validate_activity_lead_org` compara a empresa da atividade com a do
   * lead. Sem esta medição, "não vaza" seria fé; com ela, é o banco falando.
   */
  it("(a0) o banco recusa atividade com empresa diferente da do lead", () => {
    const recusa = erroDoBanco(`
      insert into public.crm_lead_activities
        (id, organization_id, lead_id, contact_id, source_module, type, performed_at, actor_kind)
      values ('859a7777-0000-4000-8000-000000009999', '${ORG_B}', '${LEAD_A}', '${CONTATO_A}', 'crm', 'nota', '${instante(9)}', 'user')
    `);
    expect(recusa).toBe("lead_org_mismatch");
  });

  /**
   * (a) O filtro da primeira página não traz atividade de OUTRA empresa, mesmo
   * quando o `lead_id` casa. É o defeito da issue, na forma exata em que ele
   * aparece no banco: linha de B pendurada no lead de A.
   */
  it("(a) atividade de outra empresa não entra nem com o lead_id casando", () => {
    const filtro = filtroDaPagina(ORG_A, LEAD_A, CONTATO_A);

    // A régua de ontem, medida: sem o eixo da empresa, a intrusa VOLTA.
    const deOntem = consultar([filtroDeOntem(LEAD_A, CONTATO_A)], 50);
    expect(deOntem.map((l) => l.id)).toContain(ATIVIDADE_INTRUSA);

    const deHoje = consultar([filtro], 50);
    expect(deHoje.map((l) => l.id)).toEqual([...ATIVIDADES_A].reverse());
    expect(deHoje.map((l) => l.id)).not.toContain(ATIVIDADE_INTRUSA);
  });

  /**
   * A MEDIÇÃO que muda a gravidade: a RLS da tabela NÃO fecha este caso. A
   * policy faz `EXISTS` no lead-pai, então uma atividade que se declara da
   * empresa B mas aponta para um lead da A é legível pelo usuário da A. O
   * `organization_id` na consulta é a camada que falta, não enfeite de índice.
   */
  it("(a2) a RLS sozinha deixaria a intrusa passar — quem a barra é o filtro", () => {
    const pelaRls = countAs(
      AGENTE_A,
      `select count(*) from public.crm_lead_activities where id = '${ATIVIDADE_INTRUSA}'`,
    );
    expect(pelaRls).toBe(1);

    const pelaConsulta = consultar([filtroDaPagina(ORG_A, LEAD_A, CONTATO_A)], 50);
    expect(pelaConsulta.map((l) => l.id)).not.toContain(ATIVIDADE_INTRUSA);
  });

  /**
   * (b) Paginação por `(performed_at, id)` continua sem pular nem repetir. A
   * intrusa está ENTRE as páginas (10:03:30), então um cursor sem o eixo da
   * empresa a pesca na segunda página — é assim que a sabotagem do cursor cai.
   */
  it("(b) paginar com o filtro novo devolve as mesmas linhas, na mesma ordem, sem pular nem repetir", () => {
    const limite = 3;
    const vistas: string[] = [];
    let cursor: Cursor | null = null;

    for (let pagina = 0; pagina < 10; pagina += 1) {
      const filtros = [filtroDaPagina(ORG_A, LEAD_A, CONTATO_A)];
      if (cursor) filtros.push(filtroDoCursor(ORG_A, cursor));

      const linhas = consultar(filtros, limite + 1);
      const destaPagina = linhas.slice(0, limite);
      if (destaPagina.length === 0) break;
      vistas.push(...destaPagina.map((l) => l.id));

      const ultima = destaPagina[destaPagina.length - 1] as Linha;
      if (linhas.length <= limite) break;
      cursor = { performed_at: ultima.performed_at, id: ultima.id };
    }

    expect(vistas).toEqual([...ATIVIDADES_A].reverse());
    expect(new Set(vistas).size).toBe(vistas.length);
    expect(vistas).not.toContain(ATIVIDADE_INTRUSA);
  });

  /**
   * (b2) O cursor carrega o eixo da empresa POR CONTA PRÓPRIA.
   *
   * Medido, e é uma sutileza que muda o que se pode afirmar: a rota chama
   * `.or()` duas vezes, e o `supabase-js` faz `searchParams.append`
   * (`PostgrestFilterBuilder.ts:2063`) — os dois grupos viram `or=` repetidos,
   * que o PostgREST CONJUNTA. Logo, tirar `organization_id` do cursor não muda
   * as linhas da paginação, porque o filtro da página já cerca a empresa. O que
   * se pode prender do cursor é o que o código dele afirma: ele é suficiente
   * sozinho. Aqui ele roda SOZINHO — sem o filtro da página — e ainda assim não
   * devolve linha de outra empresa. Sem o eixo, a intrusa aparece.
   */
  it("(b2) o cursor carrega o eixo da empresa por conta própria", () => {
    const cursor: Cursor = {
      performed_at: instante(4),
      id: ATIVIDADES_A[3] as string,
    };

    const soComOCursor = consultar([filtroDoCursor(ORG_A, cursor)], 50).map((l) => l.id);

    // Tudo o que é da empresa A e está depois do cursor — inclusive as três do
    // negócio A2, que o cursor sozinho não tem por que separar (quem separa o
    // dossiê é o filtro da página). O que NÃO pode estar aqui é a linha da
    // empresa B, e é ela que aparece quando o eixo é tirado do cursor.
    expect(soComOCursor).toEqual([
      ATIVIDADES_A[2] as string,
      ATIVIDADES_A[1] as string,
      ATIVIDADES_A[0] as string,
      ATIVIDADES_A2[2] as string,
      ATIVIDADES_A2[1] as string,
      ATIVIDADES_A2[0] as string,
    ]);
    expect(soComOCursor).not.toContain(ATIVIDADE_INTRUSA);
  });

  /**
   * (c) A segunda perna do eixo (`contact_id = C and lead_id is null`) também
   * carrega a empresa. Roda sobre `values` porque no banco real essa perna é
   * inalcançável: `lead_id` é NOT NULL — o teste logo abaixo mede isso, para o
   * dia em que deixar de ser.
   */
  it("(c) a perna do contato respeita a empresa", () => {
    const nulavel = lastLine(
      sql(`
        select is_nullable from information_schema.columns
         where table_schema = 'public'
           and table_name = 'crm_lead_activities'
           and column_name = 'lead_id'
      `),
    );
    expect(nulavel).toBe("NO");

    const condicao = condicaoSql(filtroDaPagina(ORG_A, LEAD_A, CONTATO_A));
    const saida = sql(`
      with linhas(id, organization_id, lead_id, contact_id) as (values
        ('859a8888-0000-4000-8000-000000000001'::uuid, '${ORG_A}'::uuid, null::uuid,             '${CONTATO_A}'::uuid),
        ('859a8888-0000-4000-8000-000000000002'::uuid, '${ORG_B}'::uuid, null::uuid,             '${CONTATO_A}'::uuid),
        ('859a8888-0000-4000-8000-000000000003'::uuid, '${ORG_A}'::uuid, '${LEAD_A}'::uuid,      '${CONTATO_A}'::uuid),
        ('859a8888-0000-4000-8000-000000000004'::uuid, '${ORG_B}'::uuid, '${LEAD_A}'::uuid,      '${CONTATO_A}'::uuid),
        ('859a8888-0000-4000-8000-000000000005'::uuid, '${ORG_A}'::uuid, '${LEAD_A}'::uuid,      null::uuid)
      )
      select id from linhas where ${condicao} order by id
    `);
    expect(saida.split("\n")).toEqual([
      "859a8888-0000-4000-8000-000000000001",
      "859a8888-0000-4000-8000-000000000003",
      "859a8888-0000-4000-8000-000000000005",
    ]);
  });

  /** (d) O negócio da outra empresa continua invisível — logo, continua 404. */
  it("(d) negócio de outra empresa não é lido: a rota segue devolvendo 404", () => {
    expect(countAs(AGENTE_A, `select count(*) from public.crm_leads where id = '${LEAD_A}'`)).toBe(1);
    expect(countAs(AGENTE_A, `select count(*) from public.crm_leads where id = '${LEAD_B}'`)).toBe(0);
  });

  /**
   * (e) Caso normal idêntico ao de antes: num negócio sem linha incoerente, o
   * filtro com empresa e o de ontem devolvem as MESMAS linhas na MESMA ordem.
   */
  it("(e) caso normal: mesma resposta de antes, agora cercada pela empresa", () => {
    const novo = consultar([filtroDaPagina(ORG_A, LEAD_A2, null)], 50).map((l) => l.id);
    const deOntem = consultar([filtroDeOntem(LEAD_A2, null)], 50).map((l) => l.id);

    expect(novo).toEqual(deOntem);
    expect(novo).toEqual([...ATIVIDADES_A2].reverse());
  });
});
