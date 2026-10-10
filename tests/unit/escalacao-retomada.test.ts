/**
 * A VOLTA TEM DE DESTRAVAR AS TRÊS TRAVAS, NÃO UMA.
 *
 * O defeito que este arquivo prende: `reactivate-bot` limpava `bot_silenced_until`
 * e respondia `{ reactivated: true }` com o agente ainda morto por
 * `contacts.force_human` (lido por `workers/ai-response-worker.ts`,
 * `isLeadInHandoff` e `before-send.ts`) e por `assignee_kind='user'`.
 *
 * O teste é escrito por EFEITO OBSERVÁVEL — as escritas que saem para o banco —,
 * não por chamada de função interna. Um teste que só verificasse "a função X foi
 * chamada" continuaria verde se alguém trocasse o valor escrito, que é
 * exatamente o formato do defeito original: a operação acontecia, só não fazia o
 * que dizia.
 */
import { describe, expect, it, vi } from "vitest";

import { devolverAtendimentoAoAgente, type OrigemDaRetomada } from "@/lib/escalacao/retomada";
import type { Actor } from "@/lib/api/handlers/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const NEGOCIO = "66666666-6666-4666-8666-666666666666";
const ATENDENTE = "11111111-1111-4111-8111-111111111111";
const CHAMADO = "33333333-3333-4333-8333-333333333333";

const USUARIO: Actor = { type: "user", id: ATENDENTE, role: "manager" };

interface Escrita {
  tabela: string;
  valores: Record<string, unknown>;
}

interface Captura {
  updates: Escrita[];
  inserts: Escrita[];
  rpc: Array<{ fn: string; args: Record<string, unknown> }>;
}

interface CenarioBanco {
  /** null = conversa não encontrada / de outra org. */
  conversa: Record<string, unknown> | null;
  /**
   * A linha de `contacts` que a retomada lê antes de escrever — é ali que mora
   * `ai_opt_out`, a marca permanente "sempre atendimento humano" (issue 2379).
   * Ausente = contato sem a marca (o caso que já funcionava).
   */
  contato?: Record<string, unknown> | null;
  /** Falha na LEITURA do contato — a retomada tem de recusar sem escrever nada. */
  erroAoLerContato?: { message: string } | null;
  /** 0 linhas no UPDATE da conversa = alguém assumiu na corrida. */
  updateDaConversaCasa?: boolean;
  chamados?: Array<Record<string, unknown>>;
  eventosDeChamado?: Array<Record<string, unknown>>;
  notas?: Array<Record<string, unknown>>;
  checkpointAnterior?: Record<string, unknown> | null;
  negocios?: Array<Record<string, unknown>>;
  erroDoEmitEvent?: { message: string } | null;
  /** Falha no UPDATE de `contacts.force_human` — o passo (3) de `retomada.ts`. */
  erroAoLimparForceHuman?: { message: string } | null;
}

/**
 * Dublê do supabase-js suficiente para o caminho da retomada. Cada terminal
 * responde pela TABELA, não pela ordem das chamadas — assim o teste não quebra
 * quando alguém reordena passos que não têm dependência entre si.
 */
function fazerSupabase(cenario: CenarioBanco, cap: Captura) {
  const from = (tabela: string) => {
    let ehUpdate = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (valores: Record<string, unknown>) => {
        ehUpdate = true;
        cap.updates.push({ tabela, valores });
        return chain;
      },
      insert: (valores: Record<string, unknown>) => {
        cap.inserts.push({ tabela, valores });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle: () => {
        if (ehUpdate) {
          const casa = cenario.updateDaConversaCasa ?? true;
          return Promise.resolve({ data: casa ? { id: CONV } : null, error: null });
        }
        if (tabela === "conversations") {
          return Promise.resolve({ data: cenario.conversa, error: null });
        }
        if (tabela === "contacts") {
          return Promise.resolve({
            data: cenario.contato ?? null,
            error: cenario.erroAoLerContato ?? null,
          });
        }
        if (tabela === "lead_checkpoints") {
          return Promise.resolve({ data: cenario.checkpointAnterior ?? null, error: null });
        }
        if (tabela === "crm_pipelines") {
          return Promise.resolve({ data: { id: "pipe-1" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: (v: unknown) => unknown) => {
        if (ehUpdate && tabela === "contacts" && cenario.erroAoLimparForceHuman) {
          return Promise.resolve({
            data: null,
            error: cenario.erroAoLimparForceHuman,
          }).then(res);
        }
        const listas: Record<string, unknown[]> = {
          agent_cases: cenario.chamados ?? [],
          agent_case_events: cenario.eventosDeChamado ?? [],
          conversation_notes: cenario.notas ?? [],
          crm_leads: cenario.negocios ?? [],
        };
        return Promise.resolve({ data: listas[tabela] ?? [], error: null }).then(res);
      },
    };
    return chain;
  };

  return {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      cap.rpc.push({ fn, args });
      if (fn === "emit_event") {
        return Promise.resolve({ data: null, error: cenario.erroDoEmitEvent ?? null });
      }
      return Promise.resolve({ data: [{ id: CONV }], error: null });
    },
  };
}

function conversaPassadaAHumano(over: Record<string, unknown> = {}) {
  return {
    id: CONV,
    contact_id: CONTATO,
    status: "claimed",
    assigned_to_user_id: ATENDENTE,
    assignee_kind: "user",
    bot_silenced_until: "infinity",
    ...over,
  };
}

const NEGOCIO_ABERTO = {
  id: NEGOCIO,
  organization_id: ORG,
  pipeline_id: "pipe-1",
  status: "open",
  last_activity_at: "2026-08-01T10:00:00Z",
  created_at: "2026-07-30T10:00:00Z",
};

const DECISAO_HUMANA = {
  case_id: CHAMADO,
  human_action: "resolved",
  body: "Aprovei 15% de desconto, prazo de entrega segue 5 dias.",
  created_at: "2026-08-04T12:00:00Z",
};

function cenarioComAtendimentoHumano(over: Partial<CenarioBanco> = {}): CenarioBanco {
  return {
    conversa: conversaPassadaAHumano(),
    chamados: [
      {
        id: CHAMADO,
        title: "Desconto acima da alçada",
        status: "resolved",
        opened_at: "2026-08-04T11:00:00Z",
        closed_at: "2026-08-04T12:00:00Z",
      },
    ],
    eventosDeChamado: [DECISAO_HUMANA],
    notas: [],
    negocios: [NEGOCIO_ABERTO],
    ...over,
  };
}

function novaCaptura(): Captura {
  return { updates: [], inserts: [], rpc: [] };
}

async function retomar(
  cenario: CenarioBanco,
  cap: Captura,
  actor: Actor = USUARIO,
  origem?: OrigemDaRetomada,
) {
  return devolverAtendimentoAoAgente(
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: fazerSupabase(cenario, cap) as any,
      organizationId: ORG,
      actor,
      requestId: "req-1",
    },
    { conversationId: CONV, origem },
  );
}

describe("devolver o atendimento ao agente", () => {
  it("limpa force_human do contato — a trava que ninguém soltava", async () => {
    const cap = novaCaptura();
    const res = await retomar(cenarioComAtendimentoHumano(), cap);

    expect(res.ok).toBe(true);
    const noContato = cap.updates.filter((u) => u.tabela === "contacts");
    expect(
      noContato,
      "sem esta escrita o agente continua morto nos três guards (worker nativo, harness e before-send)",
    ).toContainEqual({ tabela: "contacts", valores: { force_human: false } });
    // Retomada manual = re-autoriza o contato (gate opt-in 'allowlist', 0203):
    // sem isto, "devolver ao automático" apagaria as travas de handoff e a IA
    // seguiria muda porque ai_authorized_at continuaria nulo/expirado.
    expect(noContato).toContainEqual(
      expect.objectContaining({
        tabela: "contacts",
        valores: expect.objectContaining({ ai_authorized_reason: "retomada_manual" }),
      }),
    );
  });

  it("devolve o comando da conversa: silêncio some, marca de passagem some, dono vira a IA", async () => {
    const cap = novaCaptura();
    await retomar(cenarioComAtendimentoHumano(), cap);

    const naConversa = cap.updates.find((u) => u.tabela === "conversations");
    expect(naConversa?.valores).toMatchObject({
      bot_silenced_until: null,
      last_handoff_at: null,
      last_handoff_reason: null,
      assignee_kind: "ai",
      status: "ai_handling",
    });
  });

  it("solta o dono humano pela regra que já existe, em vez de escrever a coluna na mão", async () => {
    const cap = novaCaptura();
    await retomar(cenarioComAtendimentoHumano(), cap);

    expect(cap.rpc.filter((r) => r.fn === "fn_conversation_assign")).toEqual([
      {
        fn: "fn_conversation_assign",
        args: {
          p_organization_id: ORG,
          p_conversation_id: CONV,
          p_to_user_id: null,
          p_reason: "release",
          p_expected_assignee: null,
          p_enforce_expected: false,
        },
      },
    ]);
    // A coluna do dono NUNCA é escrita direto: quem escreve é a função, que grava
    // o evento de atribuição na mesma transação.
    const naConversa = cap.updates.find((u) => u.tabela === "conversations");
    expect(Object.keys(naConversa?.valores ?? {})).not.toContain("assigned_to_user_id");
  });

  it("conversa sem dono humano não gera release inútil", async () => {
    const cap = novaCaptura();
    await retomar(
      cenarioComAtendimentoHumano({
        conversa: conversaPassadaAHumano({ assigned_to_user_id: null, assignee_kind: null }),
      }),
      cap,
    );
    expect(cap.rpc.filter((r) => r.fn === "fn_conversation_assign")).toEqual([]);
  });

  it("grava o que a pessoa decidiu no checkpoint — é de onde o próximo turno lê", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({
        checkpointAnterior: {
          commitments: ["enviar proposta"],
          objections: ["achou caro"],
          next_action: "reenviar orçamento",
          rolling_summary: "Cliente pediu orçamento de 200 unidades.",
        },
      }),
      cap,
    );

    expect(res.ok).toBe(true);
    const checkpoint = cap.inserts.find((i) => i.tabela === "lead_checkpoints");
    expect(checkpoint, "sem checkpoint o agente volta cego").toBeDefined();

    const resumo = String(checkpoint!.valores.rolling_summary);
    // O acumulado ANTERIOR sobrevive: sobrescrever apagaria o histórico da
    // conversa justamente para contar um pedaço dela.
    expect(resumo).toContain("Cliente pediu orçamento de 200 unidades.");
    // E o que a pessoa decidiu entra com o TEXTO dela, não com um rótulo.
    expect(resumo).toContain("Aprovei 15% de desconto");
    expect(resumo).toContain("Desconto acima da alçada");
    expect(checkpoint!.valores.commitments).toEqual(["enviar proposta"]);
  });

  it("pedido feito ao cliente vira a próxima ação do agente", async () => {
    const cap = novaCaptura();
    await retomar(
      cenarioComAtendimentoHumano({
        eventosDeChamado: [
          { ...DECISAO_HUMANA, human_action: "need_lead_info", body: "Confirmar o CNPJ da empresa." },
        ],
      }),
      cap,
    );
    const checkpoint = cap.inserts.find((i) => i.tabela === "lead_checkpoints");
    expect(checkpoint!.valores.next_action).toBe("Confirmar o CNPJ da empresa.");
  });

  it("sem rastro humano nenhum não inventa checkpoint de retomada", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({ chamados: [], eventosDeChamado: [], notas: [] }),
      cap,
    );
    expect(res.ok).toBe(true);
    expect(cap.inserts.find((i) => i.tabela === "lead_checkpoints")).toBeUndefined();
    if (res.ok) expect(res.continuidade.houveAtendimentoHumano).toBe(false);
  });

  it("a volta aparece na linha do tempo do negócio", async () => {
    const cap = novaCaptura();
    await retomar(cenarioComAtendimentoHumano(), cap);

    const atividade = cap.inserts.find((i) => i.tabela === "crm_lead_activities");
    expect(atividade, "a ida emitia atividade e a volta não emitia nada").toBeDefined();
    expect(atividade!.valores).toMatchObject({
      organization_id: ORG,
      lead_id: NEGOCIO,
      type: "handoff_resolved",
      actor_kind: "user",
      performed_by_user_id: ATENDENTE,
    });
  });

  it("devolução automática (prazo vencido): o rastro diz que foi o prazo, não uma pessoa", async () => {
    const cap = novaCaptura();
    const cron: Actor = { type: "webhook_source", id: "cron:handoff-devolucao" };
    const res = await retomar(cenarioComAtendimentoHumano(), cap, cron, { automatica: { minutos: 60 } });
    expect(res.ok).toBe(true);

    // A autorização do contato entra como REGRA DE AUTOMAÇÃO, não como
    // "retomada_manual": quem investiga por que a IA voltou a falar lê daqui.
    expect(cap.updates.filter((u) => u.tabela === "contacts")).toContainEqual(
      expect.objectContaining({
        valores: expect.objectContaining({ ai_authorized_reason: "automacao:devolucao_apos_prazo" }),
      }),
    );
    // As três travas saem do mesmo jeito que no clique.
    expect(cap.updates.find((u) => u.tabela === "conversations")?.valores).toMatchObject({
      bot_silenced_until: null,
      assignee_kind: "ai",
    });
    // E a linha do tempo diz o prazo, como ato do sistema.
    const atividade = cap.inserts.find((i) => i.tabela === "crm_lead_activities");
    expect(atividade?.valores).toMatchObject({ type: "handoff_resolved", actor_kind: "system" });
    expect(JSON.stringify(atividade?.valores)).toContain("automaticamente após 60 min");
  });

  it("negócio ambíguo não vira atividade no card errado", async () => {
    const cap = novaCaptura();
    // Dois negócios abertos tocados no MESMO instante: adivinhar moveria o card
    // do cliente errado (resolveActiveLeadForContact recusa de propósito).
    const res = await retomar(
      cenarioComAtendimentoHumano({
        negocios: [
          NEGOCIO_ABERTO,
          { ...NEGOCIO_ABERTO, id: "77777777-7777-4777-8777-777777777777" },
        ],
      }),
      cap,
    );
    expect(res.ok).toBe(true);
    expect(cap.inserts.find((i) => i.tabela === "crm_lead_activities")).toBeUndefined();
  });

  it("emite o sinal de retomada do acompanhamento e falha alto se ele não sair", async () => {
    const cap = novaCaptura();
    const res = await retomar(cenarioComAtendimentoHumano(), cap);
    expect(cap.rpc.some((r) => r.fn === "emit_event")).toBe(true);

    const capFalha = novaCaptura();
    const falhou = await retomar(
      cenarioComAtendimentoHumano({ erroDoEmitEvent: { message: "boom" } }),
      capFalha,
    );
    // Único produtor do sinal que retoma um acompanhamento pausado — engolir aqui
    // órfã o agendamento para sempre.
    expect(falhou).toMatchObject({ ok: false, erro: "resume_signal_failed" });
    expect(res.ok).toBe(true);
  });

  it("conversa de outra organização não é encontrada", async () => {
    const cap = novaCaptura();
    const res = await retomar({ conversa: null }, cap);
    expect(res).toMatchObject({ ok: false, erro: "conversation_not_found" });
    expect(cap.updates).toEqual([]);
  });

  it("alguém assumiu na corrida: reporta conflito SEM detalhe — é esse o discriminador", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({ updateDaConversaCasa: false }),
      cap,
    );
    expect(res).toMatchObject({ ok: false, erro: "assignment_conflict" });
    // A AUSÊNCIA de `detalhe` é contrato, não detalhe de implementação: é por ela
    // que o cron `handoff-devolucao` separa a corrida benigna (a pessoa ganhou,
    // segue o baile) dos erros de banco que também voltam como
    // `assignment_conflict`. Encher isto aqui faz um defeito real voltar a sair
    // calado lá — ver o caso irmão logo abaixo.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detalhe).toBeUndefined();
    // E não chega a mexer no contato: devolver metade seria pior que não devolver.
    expect(cap.updates.filter((u) => u.tabela === "contacts")).toEqual([]);
  });

  it("erro ao limpar force_human volta como conflito COM detalhe — não é corrida, é defeito", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({ erroAoLimparForceHuman: { message: "deadlock detected" } }),
      cap,
    );
    // Mesmo código de erro da corrida — o tipo `RetomadaFalha` não os separa —,
    // mas este chega DEPOIS de a conversa já ter virado `assignee_kind='ai'`:
    // ela saiu da fila humana e a trava que cala os três guards ficou de pé.
    // Quem classifica só pelo `erro` trata os dois igual e perde este.
    expect(res).toMatchObject({ ok: false, erro: "assignment_conflict" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detalhe).toBe("deadlock detected");
    // Controle positivo do dublê: a escrita SAIU (foi o banco que a recusou).
    // Sem isto, um dublê que simplesmente não chamasse o UPDATE daria o mesmo
    // vermelho por outro motivo.
    expect(cap.updates.filter((u) => u.tabela === "contacts")).toContainEqual({
      tabela: "contacts",
      valores: { force_human: false },
    });
  });

  it("é idempotente: repetir com a conversa já no agente segue devolvendo ok", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({
        conversa: conversaPassadaAHumano({
          assigned_to_user_id: null,
          assignee_kind: "ai",
          bot_silenced_until: null,
          status: "ai_handling",
        }),
      }),
      cap,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.jaEstavaComOAgente).toBe(true);
  });

  it("conversa encerrada não é reaberta pela volta", async () => {
    const cap = novaCaptura();
    await retomar(
      cenarioComAtendimentoHumano({
        conversa: conversaPassadaAHumano({ status: "closed", assigned_to_user_id: null }),
      }),
      cap,
    );
    const naConversa = cap.updates.find((u) => u.tabela === "conversations");
    expect(naConversa?.valores.status).toBe("closed");
  });

  // ─── A TRAVA PERMANENTE "SEMPRE ATENDIMENTO HUMANO" (issue 2379) ──────────
  //
  // O defeito que estes casos prendem: a devolução — CLICADA ou AUTOMÁTICA —
  // limpava `contacts.force_human` e trazia a conversa de volta para a IA de um
  // contato que a operação marcou para ficar com humano para sempre. A marca é
  // `contacts.ai_opt_out` (migration 0624), separada da trava de handoff, e é
  // lida ANTES de qualquer escrita: com ela ligada, a função recusa e o estado
  // volta intacto.
  //
  // Escritos por EFEITO OBSERVÁVEL, pelo mesmo motivo do resto do arquivo: um
  // caso que só pedisse "recusou" continuaria verde se alguém recusasse DEPOIS
  // de já ter limpado a trava — que é exatamente o formato do defeito original.

  it("contato com a trava permanente NÃO é devolvido à IA: recusa sem tocar em nada", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({ contato: { id: CONTATO, ai_opt_out: true } }),
      cap,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.erro).toBe("contato_sempre_humano");
    // NADA escrito: nem a conversa (que voltaria para a IA), nem o contato (que
    // perderia force_human), nem a autorização do allowlist.
    expect(cap.updates, "escreveu estado com a trava ligada").toEqual([]);
    expect(cap.inserts).toEqual([]);
    expect(cap.rpc.map((c) => c.fn), "emitiu sinal de retomada").toEqual([]);
  });

  it("devolução AUTOMÁTICA (cron) respeita a MESMA trava — é o caminho que a issue mediu", async () => {
    const cap = novaCaptura();
    const cron: Actor = { type: "webhook_source", id: "cron:handoff-devolucao" };
    const res = await retomar(
      cenarioComAtendimentoHumano({ contato: { id: CONTATO, ai_opt_out: true } }),
      cap,
      cron,
      { automatica: { minutos: 60 } },
    );

    // O cron chama a MESMA função — o conserto é um só para os dois caminhos.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.erro).toBe("contato_sempre_humano");
    expect(cap.updates).toEqual([]);
    expect(cap.rpc).toEqual([]);
  });

  it("contato SEM a trava permanente continua sendo devolvido — o controle do mesmo cenário", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({ contato: { id: CONTATO, ai_opt_out: false } }),
      cap,
    );

    expect(res.ok).toBe(true);
    expect(cap.updates.filter((u) => u.tabela === "contacts")).toContainEqual({
      tabela: "contacts",
      valores: { force_human: false },
    });
  });

  it("leitura do contato falhando: fail-closed — recusa sem escrever nada", async () => {
    const cap = novaCaptura();
    const res = await retomar(
      cenarioComAtendimentoHumano({ erroAoLerContato: { message: "conexao caiu" } }),
      cap,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.erro).toBe("contact_state_unreadable");
    expect(cap.updates).toEqual([]);
  });
});
