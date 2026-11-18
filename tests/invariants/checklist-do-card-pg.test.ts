import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { criarPorta } from "@/lib/db";
import { lerChecklistDoNegocio, marcarItemDoChecklist, type GravarSituacao } from "@/lib/tarefas/checklist";
import { aplicarPlanoDeTarefas } from "@/lib/tarefas/plano";

/**
 * CHECKLIST DO CARD (#4717, FASE 1) — a lista única do negócio, contra Postgres
 * de verdade.
 *
 * O que este arquivo prova, e por que ele não podia ser unitário:
 *
 *   1. aplicar o plano cria a lista NA ORDEM do plano e o progresso começa em
 *      0 de M — a ordem vem do `payload.tarefa_ids` gravado em jsonb, coisa que
 *      banco falso nenhum prova;
 *   2. marcar grava AUTOR e DATA (a linha `task_completed` da timeline, a mesma
 *      que a aba Tarefas mostra) e o progresso vira 1 de M;
 *   3. desmarcar volta o item sem perder o autor da marcação original — o
 *      histórico é linha, não estado;
 *   4. o negócio de OUTRA organização recusa marcar: nem lê, nem escreve.
 *
 * `audit` e o push são mockados: efeitos externos ao caminho sob teste.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: vi.fn(async () => undefined),
}));

if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});

const db = criarPorta(pool);

/**
 * O papel da sessão na rota: aqui o banco de teste não tem RLS de sessão, então
 * a escrita é direta — o que a régua de permissão faz é provado no teste da
 * rota. O que ESTE arquivo prova é o que a lib faz com o "sim" e o "não".
 */
const gravarDireto: GravarSituacao = async (tarefaId, alvo) =>
  (await pool.query(`update crm_tasks set status = $2 where id = $1 returning id`, [tarefaId, alvo])).rowCount === 1;

afterAll(async () => {
  await pool.end();
});

const ORG_A = "e4717000-0000-4000-8000-00000000000a";
const ORG_B = "e4717000-0000-4000-8000-00000000000b";
const DONO_A = "e4717000-0000-4000-8000-000000000101";
const USER_B = "e4717000-0000-4000-8000-000000000201";
const FUNIL_A = "e4717000-0000-4000-8000-000000000301";
const ETAPA_A = "e4717000-0000-4000-8000-000000000302";
const FUNIL_B = "e4717000-0000-4000-8000-000000000311";
const ETAPA_B = "e4717000-0000-4000-8000-000000000312";
const CONTATO_A = "e4717000-0000-4000-8000-000000000401";
const CONTATO_B = "e4717000-0000-4000-8000-000000000403";
const LEAD_A = "e4717000-0000-4000-8000-000000000501";
const LEAD_B = "e4717000-0000-4000-8000-000000000504";

const AGORA = new Date("2026-11-10T12:00:00.000Z");

/** A cadência da Dom Travel no pedido da issue: pré-viagem, 3 passos. */
const PLANO = {
  id: "plano-pre-viagem",
  nome: "Pré-viagem",
  passos: [
    { ordem: 1, titulo: "Conferir documentos", vence_em_dias: 0, atribuir_a: "dono_do_lead" },
    { ordem: 2, titulo: "Emitir e anexar vouchers", vence_em_dias: 2, atribuir_a: "dono_do_lead" },
    { ordem: 3, titulo: "Enviar o roteiro", vence_em_dias: 5, atribuir_a: "dono_do_lead" },
  ],
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, 'Org A do checklist', 'Org A', $3),
            ($4, $5, 'Org B do checklist', 'Org B', $3)`,
    [ORG_A, "checklist-4717-a", { task_plans: [PLANO] }, ORG_B, "checklist-4717-b"],
  );

  await pool.query(
    `insert into auth.users (id, email) values
       ($1, 'checklist-4717-dono@invariant.test'),
       ($2, 'checklist-4717-b@invariant.test')`,
    [DONO_A, USER_B],
  );

  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values
       ($1, $2, 'manager', now(), null),
       ($3, $4, 'manager', now(), null)`,
    [DONO_A, ORG_A, USER_B, ORG_B],
  );

  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values
       ($1, $2, 'Funil A', 'checklist-4717-a'),
       ($3, $4, 'Funil B', 'checklist-4717-b')`,
    [FUNIL_A, ORG_A, FUNIL_B, ORG_B],
  );

  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1, $2, $3, 'Entrada', 'entrada-a', 1000),
       ($4, $5, $6, 'Entrada', 'entrada-b', 1000)`,
    [ETAPA_A, ORG_A, FUNIL_A, ETAPA_B, ORG_B, FUNIL_B],
  );

  await pool.query(
    `insert into contacts (id, organization_id, name) values
       ($1, $2, 'Ana Souza'),
       ($3, $4, 'Cliente B')`,
    [CONTATO_A, ORG_A, CONTATO_B, ORG_B],
  );

  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, owner_user_id) values
       ($1, $2, $3, $4, $5, 'Pacote Cancún', $6),
       ($7, $8, $9, $10, $11, 'Negócio da B', $12)`,
    [LEAD_A, ORG_A, FUNIL_A, ETAPA_A, CONTATO_A, DONO_A, LEAD_B, ORG_B, FUNIL_B, ETAPA_B, CONTATO_B, USER_B],
  );
});

async function aplicar() {
  const resultado = await aplicarPlanoDeTarefas(db, {
    organizationId: ORG_A,
    leadId: LEAD_A,
    planoId: PLANO.id,
    origem: "invariante:checklist",
    agora: AGORA,
  });
  if (!resultado.ok) throw new Error(`aplicação falhou: ${resultado.codigo}`);
  return resultado.tarefa_ids;
}

async function statusDaTarefa(tarefaId: string) {
  const linha = await db.queryOne<{ status: string }>(
    `select status from crm_tasks where id = $1 limit 1`,
    [tarefaId],
  );
  return linha?.status ?? null;
}

describe("checklist do card (#4717)", () => {
  /**
   * (a) Aplicar o plano cria a lista na ORDEM do plano e o progresso começa em
   * 0 de M.
   */
  it("aplicar o plano cria o checklist na ordem, com 0 de M concluídas", async () => {
    const tarefaIds = await aplicar();

    const leitura = await lerChecklistDoNegocio(db, { organizationId: ORG_A, leadId: LEAD_A });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const checklist = leitura.checklist;
    expect(checklist).not.toBeNull();

    // A ORDEM é a do plano, não a do prazo nem a de criação da tarefa.
    expect(checklist!.itens.map((i) => i.titulo)).toEqual([
      "Conferir documentos",
      "Emitir e anexar vouchers",
      "Enviar o roteiro",
    ]);
    // E os itens são AS TAREFAS que a aplicação criou — sem tabela paralela.
    expect(checklist!.itens.map((i) => i.tarefa_id)).toEqual(tarefaIds);
    expect(checklist!.itens.map((i) => i.ordem)).toEqual([1, 2, 3]);
    expect(checklist!.total).toBe(3);
    expect(checklist!.concluidos).toBe(0);
    expect(checklist!.itens.every((i) => i.concluido === false)).toBe(true);
    expect(checklist!.planos).toEqual(["Pré-viagem"]);
  });

  /**
   * (b) Marcar um item grava AUTOR e DATA e o progresso vira 1 de M.
   */
  it("marcar um item grava autor e data e o progresso vira 1 de M", async () => {
    const antes = await lerChecklistDoNegocio(db, { organizationId: ORG_A, leadId: LEAD_A });
    if (!antes.ok || !antes.checklist) throw new Error("checklist ausente");
    const alvo = antes.checklist.itens[1]!; // o segundo: provar que não é "o primeiro"

    const marcado = await marcarItemDoChecklist(db, {
      organizationId: ORG_A,
      leadId: LEAD_A,
      tarefaId: alvo.tarefa_id,
      usuarioId: DONO_A,
      concluido: true,
      origem: "teste:checklist",
    }, gravarDireto);

    expect(marcado.ok).toBe(true);
    if (!marcado.ok) return;
    expect(marcado.checklist.concluidos).toBe(1);
    expect(marcado.checklist.total).toBe(3);

    const item = marcado.checklist.itens.find((i) => i.tarefa_id === alvo.tarefa_id)!;
    expect(item.concluido).toBe(true);
    expect(item.status).toBe("done");
    // O AUTOR é a pessoa que marcou...
    expect(item.marcado_por).toBe(DONO_A);
    // ...e o nome sai da mesma função que o resto do produto usa.
    expect(item.marcado_por_nome).toContain("checklist-4717-dono");
    // ...e a DATA é a da linha da timeline, não um prazo inventado.
    expect(item.marcado_em).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // O que a tela lê em seguida (nova requisição) é o MESMO estado.
    const depois = await lerChecklistDoNegocio(db, { organizationId: ORG_A, leadId: LEAD_A });
    if (!depois.ok) throw new Error("leitura falhou");
    expect(depois.checklist?.concluidos).toBe(1);

    // A linha da timeline é a mesma da aba Tarefas: uma só verdade.
    const { rows } = await pool.query(
      `select count(*)::int as n
         from crm_lead_activities
        where organization_id = $1 and lead_id = $2 and type = 'task_completed' and source_id = $3`,
      [ORG_A, LEAD_A, alvo.tarefa_id],
    );
    expect(rows[0].n).toBe(1);
  });

  /**
   * (c) Desmarcar volta o item e NÃO perde o autor da marcação original — o
   * histórico é linha, o estado é coluna.
   */
  it("desmarcar volta o item sem perder o autor da marcação original", async () => {
    const antes = await lerChecklistDoNegocio(db, { organizationId: ORG_A, leadId: LEAD_A });
    if (!antes.ok || !antes.checklist) throw new Error("checklist ausente");
    const alvo = antes.checklist.itens[1]!;
    expect(alvo.concluido).toBe(true);
    const autorOriginal = alvo.marcado_por;
    const quandoOriginal = alvo.marcado_em;

    const desmarcado = await marcarItemDoChecklist(db, {
      organizationId: ORG_A,
      leadId: LEAD_A,
      tarefaId: alvo.tarefa_id,
      usuarioId: DONO_A,
      concluido: false,
      origem: "teste:checklist",
    }, gravarDireto);

    expect(desmarcado.ok).toBe(true);
    if (!desmarcado.ok) return;
    expect(desmarcado.checklist.concluidos).toBe(0);

    const item = desmarcado.checklist.itens.find((i) => i.tarefa_id === alvo.tarefa_id)!;
    expect(item.concluido).toBe(false);
    expect(item.status).toBe("pending");
    // O AUTOR da marcação original continua lá: desmarcar não apaga história.
    expect(item.marcado_por).toBe(autorOriginal);
    expect(item.marcado_em).toBe(quandoOriginal);

    const { rows } = await pool.query(
      `select count(*)::int as n
         from crm_lead_activities
        where organization_id = $1 and lead_id = $2 and type = 'task_completed' and source_id = $3`,
      [ORG_A, LEAD_A, alvo.tarefa_id],
    );
    expect(rows[0].n).toBe(1);
  });

  /**
   * (e) Negócio de OUTRA organização recusa marcar — e não escreve nada.
   */
  it("negócio de outra organização recusa marcar o checklist", async () => {
    const leitura = await lerChecklistDoNegocio(db, { organizationId: ORG_B, leadId: LEAD_A });
    expect(leitura.ok).toBe(false);
    if (leitura.ok) return;
    expect(leitura.codigo).toBe("negocio_fora_do_escopo");

    const doNegocio = await lerChecklistDoNegocio(db, { organizationId: ORG_A, leadId: LEAD_A });
    if (!doNegocio.ok || !doNegocio.checklist) throw new Error("checklist ausente");
    const alvo = doNegocio.checklist.itens[0]!;

    const naoDeviaGravar = vi.fn<GravarSituacao>(gravarDireto);
    const recusa = await marcarItemDoChecklist(db, {
      organizationId: ORG_B,
      leadId: LEAD_A,
      tarefaId: alvo.tarefa_id,
      usuarioId: USER_B,
      concluido: true,
      origem: "teste:checklist",
    }, naoDeviaGravar);
    expect(recusa.ok).toBe(false);
    if (recusa.ok) return;
    expect(recusa.codigo).toBe("negocio_fora_do_escopo");
    // Nada foi gravado: o estado do card continua o de antes.
    expect(await statusDaTarefa(alvo.tarefa_id)).toBe("pending");

    // E um id que NÃO é item do checklist deste card também não se marca.
    const fora = await marcarItemDoChecklist(db, {
      organizationId: ORG_A,
      leadId: LEAD_A,
      tarefaId: LEAD_B,
      usuarioId: DONO_A,
      concluido: true,
      origem: "teste:checklist",
    }, naoDeviaGravar);
    expect(fora.ok).toBe(false);
    if (fora.ok) return;
    expect(fora.codigo).toBe("item_fora_do_checklist");
    expect(naoDeviaGravar).not.toHaveBeenCalled();
  });

  /**
   * (f) Quando a escrita da sessão NÃO alcança a linha, a lib não grava autor
   * nem data: o item continua aberto e a timeline não ganha uma conclusão que
   * não aconteceu.
   */
  it("escrita recusada pela permissão da sessão não marca nem grava autor", async () => {
    const antes = await lerChecklistDoNegocio(db, { organizationId: ORG_A, leadId: LEAD_A });
    if (!antes.ok || !antes.checklist) throw new Error("checklist ausente");
    const alvo = antes.checklist.itens[2]!;
    expect(alvo.concluido).toBe(false);

    const recusada = await marcarItemDoChecklist(db, {
      organizationId: ORG_A,
      leadId: LEAD_A,
      tarefaId: alvo.tarefa_id,
      usuarioId: DONO_A,
      concluido: true,
      origem: "teste:checklist",
    }, async () => false);

    expect(recusada.ok).toBe(false);
    if (recusada.ok) return;
    expect(recusada.codigo).toBe("item_fora_do_checklist");
    expect(await statusDaTarefa(alvo.tarefa_id)).toBe("pending");
    const { rows } = await pool.query(
      `select count(*)::int as n
         from crm_lead_activities
        where organization_id = $1 and lead_id = $2 and type = 'task_completed' and source_id = $3`,
      [ORG_A, LEAD_A, alvo.tarefa_id],
    );
    expect(rows[0].n).toBe(0);
  });
});
