import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

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
 * criou a tarefa foi a regra. O teste ⭐ fica VERMELHO sem a chamada — é o
 * defeito, medido.
 */
type Linha = Record<string, unknown>;

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const LEAD = "bbbbbbbb-0000-4000-8000-00000000000b";
const CONTATO = "cccccccc-0000-4000-8000-00000000000c";
const DONO = "99999999-0000-4000-8000-000000000009";
const TAREFA = "dddddddd-0000-4000-8000-00000000000d";

/** A cadeia do supabase que `criarTarefaInterna` percorre, sem PostgREST. */
class Cadeia {
  private inserido: Linha | null = null;

  constructor(
    private readonly db: DbFalso,
    private readonly tabela: string,
  ) {}

  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  not(): this {
    return this;
  }
  insert(dados: Linha): this {
    this.inserido = dados;
    this.db.escritas.push({ tabela: this.tabela, dados });
    return this;
  }
  async maybeSingle(): Promise<{ data: Linha | null; error: null }> {
    if (this.inserido) return { data: { ...this.inserido, id: TAREFA }, error: null };
    return { data: this.db.linhas(this.tabela)[0] ?? null, error: null };
  }
  // `then` e não `async then`: um método async precisa devolver `Promise<T>`,
  // e a cadeia do supabase é PromiseLike — `await db.from(...).insert(...)` e
  // `await ...maybeSingle()` passam pelas duas pontas por aqui.
  then<TResult>(
    onfulfilled?: ((v: { data: Linha | null; error: null }) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    return Promise.resolve({ data: this.inserido, error: null }).then(
      onfulfilled ?? ((v) => v as unknown as TResult),
    );
  }
}

class DbFalso {
  readonly escritas: Array<{ tabela: string; dados: Linha }> = [];

  constructor(private readonly tabelas: Record<string, Linha[]>) {}

  linhas(tabela: string): Linha[] {
    return this.tabelas[tabela] ?? [];
  }

  from(tabela: string): Cadeia {
    return new Cadeia(this, tabela);
  }
}

function dbCom(): DbFalso {
  return new DbFalso({
    crm_leads: [
      {
        id: LEAD,
        organization_id: ORG,
        title: "Renovação do contrato",
        contact_id: CONTATO,
        owner_user_id: DONO,
      },
    ],
    contacts: [{ id: CONTATO, organization_id: ORG, name: "Ana Souza", display_name: null }],
    crm_tasks: [],
    crm_lead_activities: [],
  });
}

describe("a tarefa automática entra na linha do tempo do lead", () => {
  it("⭐ grava em crm_lead_activities com ator system — o mesmo laço da tarefa da tela", async () => {
    const db = dbCom();

    const resultado = await criarTarefaInterna(db as unknown as SupabaseClient, {
      organizationId: ORG,
      titulo: "Ligar para {{contact.name}}",
      venceEmDias: 1,
      atribuirA: "dono_do_lead",
      prioridade: "high",
      leadId: LEAD,
      origem: "automation:regra-1",
    });

    expect(resultado.ok).toBe(true);
    const atividades = db.escritas.filter((e) => e.tabela === "crm_lead_activities");
    expect(
      atividades.map((a) => ({
        type: a.dados.type,
        actor_kind: a.dados.actor_kind,
        lead_id: a.dados.lead_id,
        source_module: a.dados.source_module,
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
      atividades[0]!.dados.performed_by_user_id,
      "quem criou foi a regra, não a pessoa que por acaso é a dona do negócio",
    ).toBeNull();
    expect(atividades[0]!.dados.source_id).toBe(
      resultado.ok ? resultado.tarefa_id : "não deveria chegar aqui",
    );
    expect(atividades[0]!.dados.reason).toBe("Ligar para Ana Souza");
  });

  it("tarefa solta (sem negócio) não escreve nada — a coluna lead_id é not null", async () => {
    const db = dbCom();

    const resultado = await criarTarefaInterna(db as unknown as SupabaseClient, {
      organizationId: ORG,
      titulo: "Revisar os textos do agente",
      venceEmDias: 2,
      atribuirA: { usuario_id: DONO },
      prioridade: "low",
      contactId: CONTATO,
      origem: "followup:internal_task",
    });

    expect(resultado.ok).toBe(true);
    expect(db.escritas.filter((e) => e.tabela === "crm_lead_activities")).toEqual([]);
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
    await criarTarefaInterna(dbCom() as unknown as SupabaseClient, {
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
