import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { IntentVerdict } from "@/lib/agent-engine/agent/intent-classifier";
import { resolveConversationTurn } from "@/lib/agent-engine/agent/resolve-turn-agent";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";

/**
 * O JEV NO ROTEADOR, PELO CAMINHO DO TURNO (onda 2 do Jev, bloco 2.2).
 *
 * O emissor é o de produção: `resolveConversationTurn`, que o handler do
 * `inbound_turn` chama antes de tudo, com Postgres real — o roteador ativo, os
 * membros, os agentes publicados, o estado da tarefa em `organizations.settings`
 * e as linhas em `jev_observacoes` e `llm_calls`. O Jev é um `fetch` dublê
 * injetado por `deps.jev`; a IA de sempre, um `classifyIntent` dublê (o
 * verdadeiro sairia para a rede pelo registry padrão).
 *
 * O que se prova aqui e o unitário (`resolve-turn-agent.test.ts`) não alcança: a
 * leitura do estado pelo `pg.Pool`, a pergunta que chega ao fornecedor, a gravação
 * que só termina DEPOIS de o turno seguir, e a concordância gerada pelo banco.
 *
 * Cada caso tem a sua organização: o disjuntor do Jev é por organização e vive
 * no processo.
 */

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ADMIN = "aaaaaaaa-0422-4000-8000-000000000001";
const MENSAGEM = "meu pedido não chegou, me liga no 11 98765-4321";

const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function settingsDoJev(estado?: "observando" | "decidindo" | "desligada", modoRoteador?: "comparacao" | "sob_demanda") {
  return {
    jev: {
      ligado: true,
      aceite: { em: "2026-09-01T12:00:00.000Z", por: ADMIN },
      ...(modoRoteador ? { modo_roteador: modoRoteador } : {}),
      ...(estado ? { tarefas: { roteador: { estado } } } : {}),
    },
  };
}

interface Cenario {
  org: string;
  contato: string;
  sessao: string;
  conversa: string;
  mensagem: string;
  job: string;
  agentes: { vendas: string; suporte: string; reserva: string };
}

async function agentePublicado(org: string, sessao: string, nome: string): Promise<string> {
  const [agente, versao] = [randomUUID(), randomUUID()];
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agente, org, nome],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [versao, org, agente, sessao],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [versao, agente]);
  return agente;
}

/**
 * Uma organização com o roteador ATIVO no número: três intenções, e duas delas
 * (`vendas` e `orcamento`) levam ao MESMO agente — é assim que se prova que a
 * concordância é de agente, não de intenção.
 */
async function cenario(settings: unknown): Promise<Cenario> {
  const [org, contato, sessao, conversa, mensagem, roteador] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, 'Jev Roteador', 'Jev Roteador', $3)`,
    [org, `jev-rot-${org}`, JSON.stringify(settings)],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Lead', '+5511900000422')`,
    [contato, org],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [sessao, org, `jev-rot-${sessao}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'ai_handling', false)`,
    [conversa, org, contato, sessao],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', $6, 'external_device', now())`,
    [mensagem, org, conversa, sessao, contato, MENSAGEM],
  );
  const agentes = {
    vendas: await agentePublicado(org, sessao, "Vendas"),
    suporte: await agentePublicado(org, sessao, "Suporte"),
    reserva: await agentePublicado(org, sessao, "Reserva"),
  };
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, fallback_agent_id, config)
     values ($1, $2, 'Roteador do Jev', $3, true, $4, '{"min_confidence": 0.6}')`,
    [roteador, org, sessao, agentes.reserva],
  );
  for (const [posicao, intencao, descricao, agente] of [
    [0, "vendas", "Quer comprar", agentes.vendas],
    [1, "orcamento", "Quer saber o preço", agentes.vendas],
    [2, "suporte", "Tem um problema com um pedido", agentes.suporte],
  ] as const) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description, examples, position)
       values ($1, $2, $3, $4, $5, '{}', $6)`,
      [org, roteador, agente, intencao, descricao, posicao],
    );
  }
  const { job } = await enqueueJob(pool, org, {
    kind: "inbound_turn",
    leadId: contato,
    payload: {
      conversation_id: conversa,
      contact_id: contato,
      channel_session_id: sessao,
      inbound_message_id: mensagem,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 1,
  });
  return { org, contato, sessao, conversa, mensagem, job: job.id, agentes };
}

interface Pedido {
  state: unknown;
  questions: Record<string, { type: string; criteria: Record<string, string> }>;
}

/**
 * O Jev: responde `escolha` no formato real da API. `segurar` faz a resposta
 * esperar o teste soltar — é o Jev mais lento que a IA de sempre. `nuncaResponde`
 * só cede ao teto do cliente (o `AbortSignal` dele).
 */
function jevDuble(escolha: string, opts: { segurar?: Promise<void>; nuncaResponde?: boolean } = {}) {
  const pedidos: Pedido[] = [];
  return {
    pedidos,
    deps: {
      buscarChave: async () => "tsk_duble_do_teste",
      baseUrl: "https://jev.duble.test",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        pedidos.push(JSON.parse(String(init?.body)) as Pedido);
        if (opts.nuncaResponde) {
          return new Promise<Response>((_, rejeitar) =>
            init?.signal?.addEventListener("abort", () => rejeitar(new DOMException("teto", "AbortError"))),
          );
        }
        await opts.segurar;
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              roteador: { type: "choice", choice: escolha, probabilities: { [escolha]: 0.92 }, confidence: 0.85 },
            },
            usage: { input_tokens: 380, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
  };
}

/** A IA de sempre: o veredito fixo (`null` = ela falhou, ou a empresa não tem uma). */
const iaDeSempre = (veredito: IntentVerdict | null) => vi.fn(async () => veredito);

function turno(c: Cenario, deps: { classifyIntent: ReturnType<typeof iaDeSempre>; jev: ReturnType<typeof jevDuble>["deps"] }) {
  return resolveConversationTurn(
    pool,
    {} as never,
    {
      tenantId: c.org,
      leadId: c.contato,
      jobId: c.job,
      conversationId: c.conversa,
      channelSessionId: c.sessao,
      inbound: true,
    },
    { log, classifyIntent: deps.classifyIntent as never, jev: deps.jev },
  );
}

/**
 * O turno numa empresa COM a IA de sempre (decisão B, doc 89): a chave da
 * instalação, que `temIaDeSempre` resolve pelo banco de verdade — a mesma
 * resolução que a chamada da IA de sempre faz antes de sair.
 */
function turnoComIaDeSempre(c: Cenario, deps: { classifyIntent: ReturnType<typeof iaDeSempre>; jev: ReturnType<typeof jevDuble>["deps"] }) {
  return resolveConversationTurn(
    pool,
    { anthropicApiKey: "chave-da-instalacao-de-teste" } as never,
    {
      tenantId: c.org,
      leadId: c.contato,
      jobId: c.job,
      conversationId: c.conversa,
      channelSessionId: c.sessao,
      inbound: true,
    },
    { log, classifyIntent: deps.classifyIntent as never, jev: deps.jev },
  );
}

async function observacoes(org: string) {
  const { rows } = await pool.query(
    `select tarefa, estado, conversation_id, message_id, job_id, rotulo_jev, rotulo_atual, concordou,
            probabilidade_jev::float8 as probabilidade_jev, modelo
       from jev_observacoes where organization_id = $1`,
    [org],
  );
  return rows;
}

async function chamadasDoJev(org: string) {
  const { rows } = await pool.query(
    `select purpose, provider, model, status, origem_da_escolha, job_id, contact_id, input_tokens,
            cost_cents::float8 as cost_cents
       from llm_calls where organization_id = $1 and provider = 'typesafe'`,
    [org],
  );
  return rows;
}

/** A gravação do Jev observando termina DEPOIS do turno: espera por ela no banco. */
async function esperarObservacao(org: string) {
  await vi.waitFor(async () => expect(await observacoes(org)).toHaveLength(1), { timeout: 5_000, interval: 50 });
  return observacoes(org);
}

afterAll(() => pool.end());

describe("o Jev no roteador, pelo caminho do turno", () => {
  it("observando: o turno NÃO espera o Jev, vale a IA de sempre, e o par é gravado quando ele responde", async () => {
    const c = await cenario(settingsDoJev());
    let soltar!: () => void;
    const jev = jevDuble("suporte", { segurar: new Promise<void>((r) => (soltar = r)) });

    // O Jev só responde quando o teste soltar: se o turno esperasse por ele,
    // esta linha nunca voltaria (o teste morreria no timeout).
    const r = await turno(c, { classifyIntent: iaDeSempre({ intentName: "vendas", confidence: 0.9 }), jev: jev.deps });
    expect(r.outcome).toBe("classified");
    expect(r.config?.agentId).toBe(c.agentes.vendas);
    // A pergunta já saiu, em paralelo; a resposta ainda não chegou, e nada foi gravado.
    expect(jev.pedidos).toHaveLength(1);
    expect(await observacoes(c.org)).toEqual([]);

    // Só a última mensagem, sem o telefone, e só a pergunta do roteador (R4, R6).
    const pedido = jev.pedidos[0]!;
    expect(Object.keys(pedido.questions)).toEqual(["roteador"]);
    expect(Object.keys(pedido.questions.roteador!.criteria)).toEqual(["vendas", "orcamento", "suporte", "none"]);
    expect(String(pedido.state)).toContain("meu pedido não chegou");
    expect(String(pedido.state)).not.toContain("98765-4321");

    soltar();
    expect(await esperarObservacao(c.org)).toEqual([
      {
        tarefa: "roteador",
        estado: "observando",
        conversation_id: c.conversa,
        message_id: c.mensagem,
        job_id: c.job,
        rotulo_jev: c.agentes.suporte,
        rotulo_atual: c.agentes.vendas,
        concordou: false,
        probabilidade_jev: 0.92,
        modelo: "jev-1.13.0",
      },
    ]);
    const [custo] = await chamadasDoJev(c.org);
    expect(custo).toMatchObject({
      purpose: "intent_router",
      model: "typesafe/jev-1.13.0",
      status: "ok",
      origem_da_escolha: "jev_observacao",
      job_id: c.job,
      contact_id: c.contato,
      input_tokens: 380,
    });
    // Fracionário: 380 tokens a US$ 0,042/Mtok — um arredondamento para cima faria 1 centavo.
    expect(custo!.cost_cents).toBeGreaterThan(0);
    expect(custo!.cost_cents).toBeLessThan(0.01);
  });

  it("concordância é o MESMO AGENTE: intenções diferentes que levam ao mesmo agente concordam", async () => {
    const c = await cenario(settingsDoJev());
    const jev = jevDuble("orcamento");
    await turno(c, { classifyIntent: iaDeSempre({ intentName: "vendas", confidence: 0.9 }), jev: jev.deps });
    const [obs] = await esperarObservacao(c.org);
    expect(obs).toMatchObject({ rotulo_jev: c.agentes.vendas, rotulo_atual: c.agentes.vendas, concordou: true });
  });

  it("decidindo: vale a escolha do Jev, e a linha de custo diz que ele decidiu", async () => {
    const c = await cenario(settingsDoJev("decidindo"));
    const jev = jevDuble("suporte");
    const r = await turno(c, { classifyIntent: iaDeSempre({ intentName: "vendas", confidence: 0.95 }), jev: jev.deps });
    expect(r.outcome).toBe("classified");
    expect(r.config?.agentId).toBe(c.agentes.suporte);
    expect(r.intentName).toBe("suporte");
    expect(r.confidence).toBeCloseTo(0.92);
    const [obs] = await esperarObservacao(c.org);
    expect(obs).toMatchObject({ estado: "decidindo", rotulo_jev: c.agentes.suporte, rotulo_atual: c.agentes.vendas });
    expect(await chamadasDoJev(c.org)).toEqual([expect.objectContaining({ origem_da_escolha: "jev" })]);
  });

  it("sob demanda: o turno real escolhe o Jev sem consultar o classificador convencional", async () => {
    const c = await cenario(settingsDoJev("decidindo", "sob_demanda"));
    const jev = jevDuble("suporte");
    const ia = iaDeSempre({ intentName: "vendas", confidence: 0.99 });
    const r = await turnoComIaDeSempre(c, { classifyIntent: ia, jev: jev.deps });
    expect(r.config?.agentId).toBe(c.agentes.suporte);
    expect(ia).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      `select modo, origem, motivo_reserva, custo_tradicional_cents::float8 as custo_tradicional_cents
       from public.jev_router_decisions where organization_id=$1 and message_id=$2`,
      [c.org, c.mensagem],
    );
    expect(rows).toEqual([expect.objectContaining({ modo: "jev_sob_demanda", origem: "jev",
      motivo_reserva: null, custo_tradicional_cents: 0 })]);
  });

  it("sob demanda: falha do Jev aciona e registra a reserva tradicional uma vez", async () => {
    const c = await cenario(settingsDoJev("decidindo", "sob_demanda"));
    const ia = iaDeSempre({ intentName: "vendas", confidence: 0.95 });
    const r = await turnoComIaDeSempre(c, { classifyIntent: ia, jev: jevDuble("suporte", { nuncaResponde: true }).deps });
    expect(r.config?.agentId).toBe(c.agentes.vendas);
    expect(ia).toHaveBeenCalledOnce();
    const { rows } = await pool.query(
      `select modo, origem, motivo_reserva from public.jev_router_decisions
       where organization_id=$1 and message_id=$2`,
      [c.org, c.mensagem],
    );
    expect(rows).toEqual([expect.objectContaining({ modo: "jev_sob_demanda", origem: "reserva", motivo_reserva: "falha_jev" })]);
  });

  it("sob demanda numa empresa SEM a IA de sempre (decisão B): o modo não liga, a IA de sempre é perguntada, e sem ela vale a regra de hoje", async () => {
    // Sem credencial e sem chave da instalação: `temIaDeSempre` diz não pelo banco.
    const c = await cenario(settingsDoJev("decidindo", "sob_demanda"));
    const ia = iaDeSempre(null);
    const r = await turno(c, { classifyIntent: ia, jev: jevDuble("suporte").deps });
    expect(ia).toHaveBeenCalledOnce();
    expect(r.outcome).toBe("classifier_failed");
    expect(r.config?.agentId).toBe(c.agentes.reserva);
    const { rows } = await pool.query(
      `select modo, origem from public.jev_router_decisions where organization_id=$1 and message_id=$2`,
      [c.org, c.mensagem],
    );
    expect(rows).toEqual([expect.objectContaining({ modo: "jev_comparacao", origem: "tradicional" })]);
    // O Jev respondeu: a observação fica, sem par (como na R2).
    await esperarObservacao(c.org);
  });

  it("decidindo, e o Jev passa do teto: a IA de sempre cobre, e o turno espera no máximo o teto dele", async () => {
    const c = await cenario(settingsDoJev("decidindo"));
    const jev = jevDuble("suporte", { nuncaResponde: true });
    const inicio = Date.now();
    const r = await turno(c, { classifyIntent: iaDeSempre({ intentName: "vendas", confidence: 0.95 }), jev: jev.deps });
    const esperou = Date.now() - inicio;
    expect(r.config?.agentId).toBe(c.agentes.vendas);
    // O teto do cliente é 1,5 s; a folga é da leitura do banco e do agendador.
    expect(esperou).toBeLessThan(3_000);
    expect(await observacoes(c.org)).toEqual([]);
  });

  it("R2 — sem a IA de sempre, vale a regra de hoje (o de reserva), NUNCA o Jev, mesmo decidindo", async () => {
    const c = await cenario(settingsDoJev("decidindo"));
    const jev = jevDuble("suporte");
    const r = await turno(c, { classifyIntent: iaDeSempre(null), jev: jev.deps });
    expect(r.outcome).toBe("classifier_failed");
    expect(r.config?.agentId).toBe(c.agentes.reserva);
    // O Jev respondeu e custou (R8): fica gravado, SEM par — não é discordância.
    const [obs] = await esperarObservacao(c.org);
    expect(obs).toMatchObject({ rotulo_jev: c.agentes.suporte, rotulo_atual: null, concordou: null });
    expect(await chamadasDoJev(c.org)).toEqual([expect.objectContaining({ origem_da_escolha: "jev_observacao" })]);
  });

  it("R2 com o agente de antes: segue com ele, e o Jev decidindo não o troca", async () => {
    const c = await cenario(settingsDoJev("decidindo"));
    await pool.query(
      `update conversations set active_ai_agent_id = $1, active_intent = 'vendas' where organization_id = $2 and id = $3`,
      [c.agentes.vendas, c.org, c.conversa],
    );
    const jev = jevDuble("suporte");
    const r = await turno(c, { classifyIntent: iaDeSempre(null), jev: jev.deps });
    expect(r.outcome).toBe("sticky");
    expect(r.config?.agentId).toBe(c.agentes.vendas);
  });

  it("Jev desligado na empresa: nada sai para a rede, e nada é gravado", async () => {
    const c = await cenario({});
    const jev = jevDuble("suporte");
    const r = await turno(c, { classifyIntent: iaDeSempre({ intentName: "vendas", confidence: 0.9 }), jev: jev.deps });
    expect(r.config?.agentId).toBe(c.agentes.vendas);
    expect(jev.pedidos).toEqual([]);
    expect(await chamadasDoJev(c.org)).toEqual([]);
  });

  it("o retry do job sobre a MESMA mensagem não conta em dobro na concordância — mas o custo, que houve, entra", async () => {
    const c = await cenario(settingsDoJev());
    const ia = iaDeSempre({ intentName: "vendas", confidence: 0.9 });
    await turno(c, { classifyIntent: ia, jev: jevDuble("suporte").deps });
    await esperarObservacao(c.org);
    await turno(c, { classifyIntent: ia, jev: jevDuble("vendas").deps });
    await vi.waitFor(async () => expect(await chamadasDoJev(c.org)).toHaveLength(2), { timeout: 5_000, interval: 50 });
    // A primeira resposta fica.
    expect(await observacoes(c.org)).toEqual([expect.objectContaining({ rotulo_jev: c.agentes.suporte })]);
  });
});


describe("a janela do roteador vale para a IA de sempre; o histórico do Jev espera a TypeSafe (DEC-012, escolha 2)", () => {
  it("a IA de sempre recebe a janela, sem mensagens de outra conversa ou organização; o Jev, mesmo com um aceite de histórico gravado, só a mensagem", async () => {
    const config = settingsDoJev("decidindo");
    const c = await cenario({ jev: { ...config.jev, contexto_roteador: { em: "2026-09-29T12:00:00.000Z", por: ADMIN, versao: 1 } } });
    const alheia = await cenario(settingsDoJev());
    const outraConversa = randomUUID();
    const outroContato = randomUUID();
    await pool.query("insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Outro contato',$3)",
      [outroContato, c.org, "+5511900000423"]);
    await pool.query(`insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ($1, $2, $3, $4, 'ai_handling', false)`, [outraConversa, c.org, outroContato, c.sessao]);
    async function anterior(alvo: Cenario, corpo: string, segundos: number, direction = "outbound") {
      await pool.query(`insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
        type, direction, status, body, sent_via, sent_at)
        values ($1,$2,$3,$4,$5,'text',$6,'delivered',$7,'external_device',now() - $8 * interval '1 second')`,
        [randomUUID(), alvo.org, alvo.conversa, alvo.sessao, alvo.contato, direction, corpo, segundos]);
    }
    await anterior(alheia, "segredo de outra empresa", 1);
    await anterior({ ...c, conversa: outraConversa, contato: outroContato }, "segredo de outra conversa", 1);
    await anterior(c, "velha demais", 60);
    await anterior(c, "Quero comprar", 50, "inbound");
    await anterior(c, "Prefere a primeira ou a segunda?", 40);
    await anterior(c, "meu e-mail é cliente@example.com", 30, "inbound");
    await anterior(c, "Confirmar a primeira opção?", 20);
    await pool.query("update messages set body='a primeira' where id=$1", [c.mensagem]);
    const jev = jevDuble("vendas");
    const ia = iaDeSempre({ intentName: "vendas", confidence: 0.95 });
    const resultado = await turno(c, { classifyIntent: ia, jev: jev.deps });
    expect(resultado.config?.agentId).toBe(c.agentes.vendas);
    const input = (ia.mock.calls[0] as unknown as [unknown, unknown, { recentMessages: Array<{ direction: string; body: string }> }])[2];
    expect(input.recentMessages.map((m) => m.body)).toEqual([
      "Quero comprar", "Prefere a primeira ou a segunda?", "meu e-mail é cliente@example.com", "Confirmar a primeira opção?",
    ]);
    expect(jev.pedidos[0]!.state).toBe("a primeira");
    await esperarObservacao(c.org);
  });
});
