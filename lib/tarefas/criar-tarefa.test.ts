import { describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db";

import { enviarPushAoUsuario } from "@/lib/notifications/web_push";

import { criarTarefaInterna, interpolarTitulo } from "./criar-tarefa";
import { HREF_MINHAS_TAREFAS } from "./tipos";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Push de verdade gravaria em `web_push_subscriptions` no meio do teste.
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: vi.fn(async () => undefined),
}));

/**
 * #1540 — o lembrete interno.
 *
 * O título é a ÚNICA coisa que a pessoa lê antes de agir, e os placeholders são
 * como o operador os escreve na tela. O que este arquivo vigia: os dois
 * placeholders que a proposta nomeia (`{{lead.title}}`, `{{contact.name}}`) e o
 * comportamento diante de dado ausente — apagar seria esconder do operador que
 * falta preencher o campo, e título vazio é linha que o CHECK do banco recusa
 * sem dizer por quê.
 */
describe("interpolarTitulo", () => {
  it("⭐ substitui os dois placeholders da proposta", () => {
    expect(
      interpolarTitulo("Ligar para {{contact.name}} sobre {{lead.title}}", {
        lead: { id: "l1", title: "Renovação do contrato" },
        contact: { id: "c1", name: "Ana Souza" },
      }),
    ).toBe("Ligar para Ana Souza sobre Renovação do contrato");
  });

  it("prefere name (o nome de cadastro) e cai para display_name (o pushName)", () => {
    // A ordem não é minha: é a de `nomeDoContato`, a mesma que o resto do
    // produto usa, e inverter aqui seria inverter em todo lugar.
    expect(
      interpolarTitulo("Ligar para {{contact.name}}", {
        contact: { id: "c1", name: "Ana Souza", display_name: "Ana (Jurídico)" },
      }),
    ).toBe("Ligar para Ana Souza");
    // Sem nome de cadastro, sobra o `display_name` — nunca o identificador
    // técnico, que `nomeDoContato` descarta.
    expect(
      interpolarTitulo("Ligar para {{contact.name}}", {
        contact: { id: "c1", name: "", display_name: "Ana (Jurídico)" },
      }),
    ).toBe("Ligar para Ana (Jurídico)");
    expect(
      interpolarTitulo("Ligar para {{contact.name}}", { contact: { id: "c1", name: "Ana" } }),
    ).toBe("Ligar para Ana");
  });

  it("placeholder sem dado fica À VISTA — não vira título em branco", () => {
    expect(interpolarTitulo("Ligar para {{contact.name}}", { contact: { id: "c1" } })).toBe(
      "Ligar para",
    );
    expect(interpolarTitulo("{{lead.title}}", { lead: { id: "l1", title: " " } })).toBe("");
  });

  it("texto sem placeholder passa adiante intacto", () => {
    expect(interpolarTitulo("Revisar proposta", {})).toBe("Revisar proposta");
  });
});

/**
 * ─── O LAÇO DE RETORNO (item 3 do PR #1683) ───
 *
 * `criar-tarefa.ts` gravava `crm_tasks`, audit e push — e nada em
 * `crm_lead_activities`. A tarefa criada pela TELA passa por
 * `registraAtividadeDaTarefa` (`POST /api/v1/tasks`) e a automática não: o card
 * do lead ficava parado, sem sinal de que o sistema marcou um retorno, e a
 * pergunta "por que ninguém falou com este cliente?" continuava sem resposta.
 *
 * O ator é `system` (`webhook_source` com a origem), não uma pessoa: quem
 * criou a tarefa foi a regra.
 *
 * ═══ A PORTA (#3715) ═══
 *
 * O banco falso deixou de imitar a CADEIA do PostgREST e passou a implementar
 * `Db` (dois métodos). É mais honesto: o teste vê o SQL e os PARÂMETROS que a
 * função manda, em vez de uma forma de SDK que não existe mais. A prova de que
 * essas instruções rodam num Postgres de verdade — e de que a organização A
 * não alcança a B — está em `tests/invariants/tarefas-piloto-pg.test.ts`.
 */
type Linha = Record<string, unknown>;

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const LEAD = "bbbbbbbb-0000-4000-8000-00000000000b";
const CONTATO = "cccccccc-0000-4000-8000-00000000000c";
const DONO = "99999999-0000-4000-8000-000000000009";
const TAREFA = "dddddddd-0000-4000-8000-00000000000d";

/** Colunas do INSERT de atividade, na ordem em que `atividade.ts` as vincula. */
const COLUNA = {
  organization_id: 0,
  lead_id: 1,
  contact_id: 2,
  type: 3,
  source_module: 4,
  source_id: 5,
  actor_kind: 6,
  performed_by_user_id: 8,
  reason: 9,
  payload: 11,
} as const;

class BancoFalso implements Db {
  readonly escritas: Array<{ sql: string; parametros: readonly unknown[] }> = [];

  constructor(private readonly linhas: { lead?: Linha | null; contato?: Linha | null } = {}) {}

  async query<T>(sql: string, parametros: readonly unknown[] = []): Promise<T[]> {
    this.escritas.push({ sql, parametros });
    if (/^\s*insert into crm_tasks/im.test(sql)) return [{ id: TAREFA }] as T[];
    return [];
  }

  async queryOne<T>(sql: string, parametros: readonly unknown[] = []): Promise<T | null> {
    this.escritas.push({ sql, parametros });
    if (sql.includes("from crm_leads")) return (this.linhas.lead ?? null) as T | null;
    if (sql.includes("from contacts")) return (this.linhas.contato ?? null) as T | null;
    return null;
  }

  atividades(): Array<readonly unknown[]> {
    return this.escritas
      .filter((e) => e.sql.includes("crm_lead_activities"))
      .map((e) => e.parametros);
  }
}

function dbCom(): BancoFalso {
  return new BancoFalso({
    lead: {
      id: LEAD,
      title: "Renovação do contrato",
      contact_id: CONTATO,
      owner_user_id: DONO,
    },
    contato: { id: CONTATO, name: "Ana Souza", display_name: null },
  });
}

describe("a tarefa automática entra na linha do tempo do lead", () => {
  it("⭐ grava em crm_lead_activities com ator system — o mesmo laço da tarefa da tela", async () => {
    const db = dbCom();

    const resultado = await criarTarefaInterna(db, {
      organizationId: ORG,
      titulo: "Ligar para {{contact.name}}",
      venceEmDias: 1,
      atribuirA: "dono_do_lead",
      prioridade: "high",
      leadId: LEAD,
      origem: "automation:regra-1",
    });

    expect(resultado.ok).toBe(true);
    const atividades = db.atividades();
    expect(
      atividades.map((p) => ({
        type: p[COLUNA.type],
        actor_kind: p[COLUNA.actor_kind],
        lead_id: p[COLUNA.lead_id],
        source_module: p[COLUNA.source_module],
      })),
      "a tarefa nasce em crm_tasks e some da linha do tempo: o card do negócio fica parado sem sinal de que o sistema marcou um retorno",
    ).toEqual([
      {
        type: "task_created",
        actor_kind: "system",
        lead_id: LEAD,
        source_module: "tarefas",
      },
    ]);
    expect(
      atividades[0]![COLUNA.performed_by_user_id],
      "quem criou foi a regra, não a pessoa que por acaso é a dona do negócio",
    ).toBeNull();
    expect(atividades[0]![COLUNA.source_id]).toBe(
      resultado.ok ? resultado.tarefa_id : "não deveria chegar aqui",
    );
    expect(atividades[0]![COLUNA.reason]).toBe("Ligar para Ana Souza");
    // A linha é da organização do PEDIDO — o mesmo filtro que a leitura usa.
    expect(atividades[0]![COLUNA.organization_id]).toBe(ORG);
  });

  it("tarefa solta (sem negócio) não escreve nada — a coluna lead_id é not null", async () => {
    const db = dbCom();

    const resultado = await criarTarefaInterna(db, {
      organizationId: ORG,
      titulo: "Revisar os textos do agente",
      venceEmDias: 2,
      atribuirA: { usuario_id: DONO },
      prioridade: "low",
      contactId: CONTATO,
      origem: "followup:internal_task",
    });

    expect(resultado.ok).toBe(true);
    expect(db.atividades()).toEqual([]);
  });
});

describe("o push de tarefa criada", () => {
  it("o endereço do push é o que a página de Tarefas lê como 'Minhas'", () => {
    // Os outros testes comparam a constante com ela mesma; este prende o VALOR
    // ao que `app/app/tasks/page.tsx` entende (`assigned_to === "me"`). A tela
    // de verdade é provada pelo e2e, que navega por esta mesma constante.
    const url = new URL(HREF_MINHAS_TAREFAS, "http://x");
    expect(url.pathname).toBe("/app/tasks");
    expect(url.searchParams.get("assigned_to")).toBe("me");
  });

  it("abre as tarefas do responsável, não a lista da organização", async () => {
    await criarTarefaInterna(dbCom(), {
      organizationId: ORG,
      titulo: "Ligar de volta",
      venceEmDias: 1,
      atribuirA: { usuario_id: DONO },
      prioridade: "medium",
      origem: "automation:regra-1",
    });

    expect(vi.mocked(enviarPushAoUsuario)).toHaveBeenCalledWith(
      ORG,
      DONO,
      expect.objectContaining({ href: HREF_MINHAS_TAREFAS }),
    );
  });
});
