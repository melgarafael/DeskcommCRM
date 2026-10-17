/**
 * As garantias das operações que o agente de IA passou a alcançar (épico IA 360,
 * W4). Cada teste aqui existe por uma falha CONCRETA que a operação evita.
 *
 * Três famílias, e nenhuma delas é sobre "o CRUD funciona":
 *
 * 1. **Tenancy sob service-role.** As tools recebem o cliente ADMIN, que bypassa
 *    RLS. A rota REST equivalente é protegida de graça pela policy; a tool não é.
 *    O que separa os tenants aqui é o `eq("organization_id", …)` escrito à mão —
 *    e um teste que só exercitasse a rota nunca veria isso faltar.
 *
 * 2. **O que NÃO sai.** O retorno de uma tool entra no contexto de um modelo de
 *    linguagem e pode ser repetido numa conversa com um cliente. Segredo de
 *    entrada automática, URL de destino de regra, e-mail de atendente e o que a
 *    pessoa digitou num formulário não têm o que fazer lá.
 *
 * 3. **Autoria.** Toda escrita de configuração grava QUEM mexeu, e a espécie tem
 *    que seguir o ator de verdade — senão a tela mostra "alterado por você/time"
 *    para uma regra que o assistente ligou, que é pior do que não mostrar nada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import {
  criarEntradaAutomatica,
  listarEntradasAutomaticas,
  recebimentosDaEntrada,
  type DepsDaOperacao,
} from "@/lib/operacao/entradas-automaticas";
import { listarMarcadores, listarTime } from "@/lib/operacao/marcadores-e-time";
import { preencherModeloDeMensagem } from "@/lib/operacao/modelos-de-mensagem";
import {
  definirRegraAtiva,
  execucoesDasRegras,
  listarRegrasAutomaticas,
} from "@/lib/operacao/regras-automaticas";
import { MENSAGEM_CAMPO_DE_DATA_DO_CONTATO } from "@/lib/automation/campo-do-gatilho-de-data";
import { ORG_ID, OUTRA_ORG, PIPE, USER_ID, etapa, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

const AGENTE: Actor = { type: "ai_agent", id: "aa11", role: "agent" };
const PESSOA: Actor = { type: "user", id: USER_ID, role: "manager" };

function deps(db: ReturnType<typeof makeDb>, actor: Actor = PESSOA): DepsDaOperacao {
  return {
    supabase: db.client as unknown as SupabaseClient,
    organizationId: ORG_ID,
    actor,
    requestId: "req-1",
  };
}

/** A recusa como a operação a lança — código e frase, não só "deu erro". */
async function recusa(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("a operação NÃO recusou — era para ter lançado ApiError");
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. tenancy sob service-role
// ---------------------------------------------------------------------------

describe("criar entrada automática de contatos — tenancy sob service-role", () => {
  const ENTRADA = {
    name: "Formulário do site",
    default_pipeline_id: PIPE,
    default_stage_id: "e1",
  };

  it("cria quando o funil e a etapa são da organização", async () => {
    const db = makeDb({ stages: [etapa({ id: "e1", name: "Novo" })] });
    const criada = await criarEntradaAutomatica(deps(db), ENTRADA);

    expect(criada.name).toBe("Formulário do site");
    expect(criada.path_token).toEqual(expect.any(String));
    expect(db.escritas.filter((e) => e.table === "webhook_sources")).toHaveLength(1);
  });

  it("⭐ funil de OUTRA organização → recusa e NENHUMA escrita", async () => {
    // O funil EXISTE — só que noutro tenant. A FK do banco não conhece
    // organização: sem o filtro explícito, a entrada nasceria despejando os
    // contatos desta empresa no funil de outra. O veredito não é o código do
    // erro, é a lista de escritas que não saiu.
    const db = makeDb({
      pipelineOrg: OUTRA_ORG,
      stages: [etapa({ id: "e1", name: "Novo", organization_id: OUTRA_ORG })],
    });
    const erro = await recusa(() => criarEntradaAutomatica(deps(db), ENTRADA));

    expect(erro.status).toBe(422);
    expect(erro.message).toContain("Esse funil não existe aqui");
    expect(db.escritas).toEqual([]);
  });

  it("etapa de OUTRO funil da mesma org → recusa e nenhuma escrita", async () => {
    // Passa no filtro de organização e ainda assim é errado: os contatos
    // entrariam num quadro e cairiam numa coluna de outro.
    const db = makeDb({
      stages: [etapa({ id: "e1", name: "Novo", pipeline_id: "outro-funil" })],
    });
    const erro = await recusa(() => criarEntradaAutomatica(deps(db), ENTRADA));

    expect(erro.status).toBe(422);
    expect(erro.message).toContain("não pertence ao funil escolhido");
    expect(db.escritas).toEqual([]);
  });

  it("etapa ARQUIVADA → recusa: os contatos cairiam fora do quadro", async () => {
    const db = makeDb({ stages: [etapa({ id: "e1", name: "Novo", is_archived: true })] });
    const erro = await recusa(() => criarEntradaAutomatica(deps(db), ENTRADA));

    expect(erro.status).toBe(422);
    expect(erro.message).toContain("arquivada");
    expect(db.escritas).toEqual([]);
  });

  it("entrada de outra organização não aparece na listagem", async () => {
    const db = makeDb({
      webhookSources: [
        { id: "w1", organization_id: ORG_ID, name: "Minha", is_active: true, secret_encrypted: null },
        { id: "w2", organization_id: OUTRA_ORG, name: "Alheia", is_active: true, secret_encrypted: null },
      ],
    });
    const lista = await listarEntradasAutomaticas(deps(db));
    expect(lista.map((f) => f.name)).toEqual(["Minha"]);
  });

  it("regra de outra organização não aparece na listagem", async () => {
    const db = makeDb({
      automationRules: [
        { id: "r1", organization_id: ORG_ID, name: "Minha", is_active: true, actions: [], conditions: [] },
        { id: "r2", organization_id: OUTRA_ORG, name: "Alheia", is_active: true, actions: [], conditions: [] },
      ],
    });
    const lista = await listarRegrasAutomaticas(deps(db));
    expect(lista.map((r) => r.name)).toEqual(["Minha"]);
  });

  it("ligar regra de outra organização → 404, e nenhuma escrita", async () => {
    const db = makeDb({
      automationRules: [
        { id: "r2", organization_id: OUTRA_ORG, name: "Alheia", is_active: false, actions: [], conditions: [] },
      ],
    });
    const erro = await recusa(() => definirRegraAtiva(deps(db, AGENTE), { id: "r2", ativa: true }));

    expect(erro.status).toBe(404);
    expect(db.escritas).toEqual([]);
    // A regra continua desligada no "banco" — o veredito de verdade.
    expect(db.tabelas.automation_rules[0]?.is_active).toBe(false);
  });
});

describe("religar pelo MCP passa pela mesma recusa do gatilho por data (#2791)", () => {
  // `crm_set_automation_rule_active` não passa pelo PATCH da rota. Sem a guarda
  // aqui, uma regra antiga apontada para um campo do CONTATO voltaria ligada e
  // muda: a varredura lê o negócio.
  const funil = funilRow({
    id: PIPE,
    name: "Ateliê",
    settings: {
      fields: [
        { key: "nascimento", label: "Nascimento", type: "date", escopo: "contato" },
        { key: "entrega", label: "Entrega", type: "date", escopo: "negocio" },
      ],
    },
  });
  const regra = (campo: string) => ({
    id: "r1",
    organization_id: ORG_ID,
    name: "Aniversário",
    is_active: false,
    actions: [],
    conditions: [],
    trigger_event: "lead.date_field_due",
    trigger_config: { pipeline_id: PIPE, campo, dias: 0 },
  });

  it("⭐ religar com campo do contato → 422 e nenhuma escrita", async () => {
    const db = makeDb({ pipelines: [funil], automationRules: [regra("nascimento")] });
    const erro = await recusa(() => definirRegraAtiva(deps(db, AGENTE), { id: "r1", ativa: true }));

    expect(erro.status).toBe(422);
    expect(erro.message).toBe(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO);
    expect(db.escritas).toEqual([]);
  });

  it("controle: religar com campo do negócio passa, e desligar a do contato também", async () => {
    const db = makeDb({ pipelines: [funil], automationRules: [regra("entrega")] });
    await definirRegraAtiva(deps(db, AGENTE), { id: "r1", ativa: true });
    expect(db.escritas.filter((e) => e.table === "automation_rules")).toHaveLength(1);

    const db2 = makeDb({ pipelines: [funil], automationRules: [{ ...regra("nascimento"), is_active: true }] });
    await definirRegraAtiva(deps(db2, AGENTE), { id: "r1", ativa: false });
    expect(db2.escritas.filter((e) => e.table === "automation_rules")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. o que NÃO sai para o contexto do modelo
// ---------------------------------------------------------------------------

describe("o que a leitura NÃO devolve", () => {
  it("entrada automática sai com has_secret, nunca com o segredo", async () => {
    const db = makeDb({
      webhookSources: [
        {
          id: "w1",
          organization_id: ORG_ID,
          name: "Site",
          is_active: true,
          secret_encrypted: "deadbeefcafe",
        },
      ],
    });
    const [fonte] = await listarEntradasAutomaticas(deps(db));

    expect(fonte?.has_secret).toBe(true);
    // `not.toHaveProperty` sozinho passaria com a chave presente e valor null.
    // O que se garante é que o VALOR não viajou de nenhuma forma.
    expect(JSON.stringify(fonte)).not.toContain("deadbeefcafe");
    expect(fonte).not.toHaveProperty("secret_encrypted");
  });

  it("⭐ regra automática sai sem a config das ações (URL e segredo ficam)", async () => {
    const db = makeDb({
      automationRules: [
        {
          id: "r1",
          organization_id: ORG_ID,
          name: "Avisar o ERP",
          is_active: true,
          trigger_event: "lead.created",
          conditions: [{ field: "x", op: "eq", value: "y" }],
          actions: [
            {
              type: "call_webhook",
              config: { url: "https://erp.interno.exemplo/hook", secret_enc: "abc123" },
            },
            { type: "add_tag", config: { tags: ["novo"] } },
          ],
          run_count: 3,
        },
      ],
    });
    const [regra] = await listarRegrasAutomaticas(deps(db));

    // O que SAI: o suficiente para decidir se liga.
    expect(regra?.acoes).toEqual(["call_webhook", "add_tag"]);
    expect(regra?.quantidade_de_condicoes).toBe(1);
    // O que NÃO sai: para onde a empresa manda dados, e com que segredo.
    const serializado = JSON.stringify(regra);
    expect(serializado).not.toContain("erp.interno.exemplo");
    expect(serializado).not.toContain("abc123");
  });

  it("⭐ recebimento devolve os NOMES dos campos, nunca o que a pessoa digitou", async () => {
    const db = makeDb({
      webhookSources: [
        { id: "w1", organization_id: ORG_ID, name: "Site", path_token: "tok", secret_encrypted: null },
      ],
    });
    db.tabelas.crm_pipelines.push(); // sem efeito: só para deixar claro que a fonte é a tabela abaixo
    (db.tabelas as unknown as Record<string, unknown[]>).webhook_events_log = [
      {
        id: "ev1",
        webhook_path_token: "tok",
        received_at: "2026-08-04T10:00:00Z",
        valid_signature: true,
        status: "ok",
        payload_parsed: { name: "Joana da Silva", phone: "+5511999998888" },
      },
    ];

    const [evento] = await recebimentosDaEntrada(deps(db), { id: "w1", limite: 20 });

    expect(evento?.campos_recebidos).toEqual(["name", "phone"]);
    const serializado = JSON.stringify(evento);
    expect(serializado).not.toContain("Joana");
    expect(serializado).not.toContain("999998888");
  });

  it("time sai com papel e user_id, sem e-mail nem nome", async () => {
    const db = makeDb();
    (db.tabelas as unknown as Record<string, unknown[]>).user_organizations = [
      {
        user_id: USER_ID,
        organization_id: ORG_ID,
        role: "manager",
        accepted_at: "2026-01-01T00:00:00Z",
        revoked_at: null,
        created_at: "2026-01-01T00:00:00Z",
        email: "atendente@empresa.exemplo",
      },
    ];

    const [pessoa] = await listarTime(deps(db));

    expect(pessoa?.papel).toBe("manager");
    expect(pessoa?.convite_pendente).toBe(false);
    expect(JSON.stringify(pessoa)).not.toContain("atendente@empresa.exemplo");
  });

  it("execução devolve só as ações que falharam", async () => {
    const db = makeDb({
      automationRules: [
        { id: "r1", organization_id: ORG_ID, name: "Avisar o ERP", is_active: true, actions: [], conditions: [] },
      ],
    });
    (db.tabelas as unknown as Record<string, unknown[]>).automation_rule_runs = [
      {
        id: "run1",
        organization_id: ORG_ID,
        rule_id: "r1",
        status: "partial",
        created_at: "2026-08-04T10:00:00Z",
        error: null,
        automation_rules: { name: "Avisar o ERP" },
        actions_result: [
          { type: "add_tag", status: "success" },
          { type: "call_webhook", status: "failed", error: "connect ECONNREFUSED" },
        ],
      },
    ];

    const [execucao] = await execucoesDasRegras(deps(db), { limite: 20 });

    expect(execucao?.status).toBe("partial");
    expect(execucao?.regra).toBe("Avisar o ERP");
    expect(execucao?.falhas).toEqual([
      { acao: "call_webhook", erro: "connect ECONNREFUSED" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. autoria — a espécie segue o ator de verdade
// ---------------------------------------------------------------------------

describe("autoria da mudança de configuração", () => {
  const REGRA = [
    { id: "r1", organization_id: ORG_ID, name: "Boas-vindas", is_active: false, actions: [], conditions: [] },
  ];

  it("⭐ regra ligada pelo AGENTE grava autoria 'ai'", async () => {
    const db = makeDb({ automationRules: [...REGRA] });
    await definirRegraAtiva(deps(db, AGENTE), { id: "r1", ativa: true });

    const escrita = db.escritas.find((e) => e.table === "automation_rules");
    expect(escrita?.patch).toMatchObject({
      is_active: true,
      last_change_actor_kind: "ai",
    });
    expect((escrita?.patch as Record<string, unknown>).last_change_at).toEqual(expect.any(String));
  });

  it("regra ligada por uma PESSOA grava autoria 'user'", async () => {
    // A metade que impede o teste acima de passar com a espécie chumbada:
    // um `last_change_actor_kind: "ai"` fixo passaria naquele e falha neste.
    const db = makeDb({ automationRules: [...REGRA] });
    await definirRegraAtiva(deps(db, PESSOA), { id: "r1", ativa: true });

    expect(db.escritas.find((e) => e.table === "automation_rules")?.patch).toMatchObject({
      last_change_actor_kind: "user",
    });
  });

  it("entrada automática criada pelo agente não inventa um dono humano", async () => {
    const db = makeDb({ stages: [etapa({ id: "e1", name: "Novo" })] });
    await criarEntradaAutomatica(deps(db, AGENTE), {
      name: "Site",
      default_pipeline_id: PIPE,
      default_stage_id: "e1",
    });

    const escrita = db.escritas.find((e) => e.table === "webhook_sources");
    expect(escrita?.patch).toMatchObject({
      created_by_user_id: null,
      last_change_actor_kind: "ai",
    });
  });
});

// ---------------------------------------------------------------------------
// preencher resposta pronta — a lacuna é devolvida, não escondida
// ---------------------------------------------------------------------------

describe("preencher resposta pronta", () => {
  function comModelo(corpo: string, contato?: Record<string, unknown>) {
    const db = makeDb();
    (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
      { id: "t1", organization_id: ORG_ID, title: "Boas-vindas", body: corpo },
    ];
    (db.tabelas as unknown as Record<string, unknown[]>).contacts = contato ? [contato] : [];
    return db;
  }

  it("troca a marcação pelos dados do cliente", async () => {
    const db = comModelo("Olá {{nome}}, tudo bem?", {
      id: "c1",
      organization_id: ORG_ID,
      name: "Joana",
      phone_number: "+5511999998888",
      email: null,
    });
    const r = await preencherModeloDeMensagem(deps(db), { templateId: "t1", contactId: "c1" });

    expect(r.texto).toBe("Olá Joana, tudo bem?");
    expect(r.lacunas).toEqual([]);
  });

  it("⭐ sem o dado, denuncia a lacuna em vez de entregar a frase quebrada", async () => {
    // `renderTemplate` troca marcação sem valor por string vazia — o texto SAI
    // parecendo pronto ("Olá , tudo bem?"). Sem a lista de lacunas, quem chama
    // não tem como saber que aquilo não pode ser mandado ao cliente.
    const db = comModelo("Olá {{nome}}, tudo bem?");
    const r = await preencherModeloDeMensagem(deps(db), { templateId: "t1" });

    expect(r.texto).toBe("Olá , tudo bem?");
    expect(r.lacunas).toEqual(["nome"]);
  });

  it("modelo de outra organização → 404", async () => {
    const db = makeDb();
    (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
      { id: "t1", organization_id: OUTRA_ORG, title: "Alheio", body: "oi" },
    ];
    const erro = await recusa(() =>
      preencherModeloDeMensagem(deps(db), { templateId: "t1" }),
    );
    expect(erro.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// marcadores — a lista que evita a quarta variação de "urgente"
// ---------------------------------------------------------------------------

describe("listar marcadores", () => {
  it("junta o vocabulário oficial com o que está em uso, os mais usados primeiro", async () => {
    const db = makeDb();
    (db.tabelas as unknown as Record<string, unknown[]>).organizations = [
      { id: ORG_ID, settings: { canonical_conversation_tags: ["urgente", "nunca-usado"] } },
    ];
    (db.tabelas as unknown as Record<string, unknown[]>).conversations = [
      { id: "c1", organization_id: ORG_ID, tags: ["urgente", "vip"] },
      { id: "c2", organization_id: ORG_ID, tags: ["urgente"] },
      { id: "c3", organization_id: OUTRA_ORG, tags: ["de-outra-empresa"] },
    ];

    const lista = await listarMarcadores(deps(db));

    expect(lista).toEqual([
      { marcador: "urgente", conversas: 2, oficial: true },
      { marcador: "vip", conversas: 1, oficial: false },
      { marcador: "nunca-usado", conversas: 0, oficial: true },
    ]);
    // Marcador de outro tenant não entra — o filtro de organização é o que separa.
    expect(lista.map((m) => m.marcador)).not.toContain("de-outra-empresa");
  });
});
