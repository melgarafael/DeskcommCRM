/**
 * O LIMIAR DE SENTIMENTO É DO AGENTE DA CONVERSA, NÃO DE UM AGENTE QUALQUER
 * (issue #486).
 *
 * ## O defeito medido
 *
 * `workers/ai-sentiment-worker.ts` lia o `sentiment_threshold` do PRIMEIRO
 * agente da organização que atende — ordenado por `is_default` e depois por
 * `created_at`. A conversa que disparou o evento não entrava na consulta em
 * lugar nenhum.
 *
 * Numa organização com um agente só isso acerta por acidente. Com dois ou mais,
 * **o limiar em vigor passa a depender da ordem de criação**: quem configura o
 * agente da assistência técnica (onde cliente irritado é o cliente normal) vê o
 * comportamento do agente da clínica (onde cliente triste é sinal de problema),
 * e não tem como descobrir o porquê pela tela.
 *
 * O mesmo erro escolhia o dono do CUSTO: `logInvocation` recebia o id do agente
 * errado, e a tela de consumo de IA atribuía a classificação a quem não a pediu.
 *
 * ## Por que os casos são estes
 *
 * O cenário tem DOIS agentes cujos limiares cercam a nota do classificador
 * (0.9 e 0.1, nota 0.5): assim "qual limiar valeu" vira um efeito observável —
 * o alerta `ai.sentiment_alert` sai ou não sai —, e não uma leitura de campo
 * interno. O agente da clínica é o primeiro pela régua ANTIGA (é `is_default` e
 * é o mais antigo), então todo caso em que a conversa é do outro agente
 * distingue os dois comportamentos.
 *
 * Dois casos são guarda de vacuidade e não distinguem nada sozinhos: a conversa
 * NA sessão da clínica (que tem de continuar escalando) e a organização de um
 * agente legado só (que tem de continuar usando o limiar dele). Eles existem
 * para reprovar um "conserto" que passe a devolver sempre o último agente ou
 * sempre o padrão do produto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";

import { processSentiment } from "@/workers/ai-sentiment-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import { logInvocation } from "@/lib/ai/log-invocation";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";

/** O número de WhatsApp da clínica e o da assistência técnica. */
const SESSAO_CLINICA = "44444444-4444-4444-8444-444444444444";
const SESSAO_TECNICA = "55555555-5555-4555-8555-555555555555";
/** Uma sessão sem agente publicado nenhum — o canal recém-conectado. */
const SESSAO_ORFA = "66666666-6666-4666-8666-666666666666";

const AGENTE_CLINICA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENTE_TECNICA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSAO_CLINICA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSAO_TECNICA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Cliente triste é sinal de problema: escala quase sempre. */
const LIMIAR_CLINICA = 0.9;
/** Cliente irritado é o cliente NORMAL: quase nunca escala. */
const LIMIAR_TECNICA = 0.1;
/** O default do produto, quando não há agente resolvível. */
const LIMIAR_PADRAO = 0.3;
/** A nota do classificador — de propósito ENTRE os dois limiares. */
const NOTA = 0.5;

type Linha = Record<string, unknown>;

interface Banco {
  messages: Linha[];
  conversations: Linha[];
  ai_agents: Linha[];
  ai_agent_versions: Linha[];
}

interface Chamada {
  op: string;
  args: unknown[];
}

/**
 * Mini-Postgres de brinquedo: aplica `eq`/`is`/`in`/`order` sobre as linhas da
 * tabela. É mais caro que devolver um objeto fixo e é o que torna o teste capaz
 * de medir a CONSULTA — um dublê que devolve sempre a mesma linha aprovaria o
 * worker que nunca filtra pela conversa, que é exatamente o defeito.
 */
function fazerAdmin(banco: Banco, rpcs: Linha[]) {
  const from = (tabela: string) => {
    const chamadas: Chamada[] = [];

    const resolver = (): { data: Linha[]; error: null } => {
      let linhas = [...((banco as unknown as Record<string, Linha[]>)[tabela] ?? [])];
      for (const c of chamadas) {
        if (c.op === "eq") {
          const [col, val] = c.args as [string, unknown];
          linhas = linhas.filter((l) => l[col] === val);
        } else if (c.op === "is") {
          const [col, val] = c.args as [string, unknown];
          linhas = linhas.filter((l) => (l[col] ?? null) === val);
        } else if (c.op === "in") {
          const [col, vals] = c.args as [string, unknown[]];
          linhas = linhas.filter((l) => vals.includes(l[col]));
        }
      }
      const ordens = chamadas.filter((c) => c.op === "order");
      if (ordens.length > 0) {
        linhas.sort((a, b) => {
          for (const o of ordens) {
            const [col, opts] = o.args as [string, { ascending?: boolean } | undefined];
            const asc = opts?.ascending !== false;
            const va = a[col];
            const vb = b[col];
            if (va === vb) continue;
            const menor = (va as never) < (vb as never) ? -1 : 1;
            return asc ? menor : -menor;
          }
          return 0;
        });
      }
      return { data: linhas, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_alvo, prop: string) => {
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: resolver().data[0] ?? null, error: null });
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
              Promise.resolve(resolver()).then(ok, falha);
          }
          return (...args: unknown[]) => {
            chamadas.push({ op: prop, args });
            return chain;
          };
        },
      },
    );
    return chain;
  };

  return {
    from,
    rpc: (nome: string, args: Linha) => {
      rpcs.push({ nome, ...args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

interface Cenario {
  /** Em qual número de WhatsApp a conversa está. */
  sessaoDaConversa: string;
  /** Stickiness do router gravada em `conversations.active_ai_agent_id`. */
  agenteGrudado?: string | null;
  /** Só o agente legado da clínica, sem versão publicada (instalação nova). */
  somenteLegado?: boolean;
}

function montarBanco(c: Cenario): Banco {
  const clinica: Linha = {
    id: AGENTE_CLINICA,
    organization_id: ORG,
    config: { sentiment_threshold: LIMIAR_CLINICA },
    kind: "rag_bot",
    is_active: true,
    is_default: true,
    priority: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    published_version_id: c.somenteLegado === true ? null : VERSAO_CLINICA,
    archived_at: null,
  };
  const tecnica: Linha = {
    id: AGENTE_TECNICA,
    organization_id: ORG,
    config: { sentiment_threshold: LIMIAR_TECNICA },
    kind: "mcp_agent",
    is_active: true,
    is_default: false,
    priority: 0,
    created_at: "2026-06-01T00:00:00.000Z",
    published_version_id: VERSAO_TECNICA,
    archived_at: null,
  };

  return {
    messages: [
      {
        id: MSG,
        organization_id: ORG,
        conversation_id: CONV,
        body: "meu aparelho voltou com o mesmo defeito",
        direction: "inbound",
        metadata: {},
      },
    ],
    conversations: [
      {
        id: CONV,
        organization_id: ORG,
        channel_session_id: c.sessaoDaConversa,
        active_ai_agent_id: c.agenteGrudado ?? null,
      },
    ],
    ai_agents: c.somenteLegado === true ? [clinica] : [clinica, tecnica],
    ai_agent_versions: [
      {
        id: VERSAO_CLINICA,
        organization_id: ORG,
        agent_id: AGENTE_CLINICA,
        channel_session_id: SESSAO_CLINICA,
        status: "published",
      },
      {
        id: VERSAO_TECNICA,
        organization_id: ORG,
        agent_id: AGENTE_TECNICA,
        channel_session_id: SESSAO_TECNICA,
        status: "published",
      },
    ],
  };
}

const evento = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  organization_id: ORG,
  entity_id: MSG,
  payload: { message_id: MSG, conversation_id: CONV },
} as unknown as EventRow;

/** O que o worker fez de observável: alertas emitidos e dono do custo. */
async function rodar(c: Cenario): Promise<{
  alertas: Linha[];
  limiarDoAlerta: number | null;
  agenteDoCusto: string | null;
}> {
  const rpcs: Linha[] = [];
  vi.mocked(createAdminClient).mockReturnValue(
    fazerAdmin(montarBanco(c), rpcs) as unknown as ReturnType<typeof createAdminClient>,
  );

  const resultado = await processSentiment(evento);
  expect(resultado.skipped, `o worker desistiu: ${resultado.reason ?? "-"}`).toBe(false);

  const alertas = rpcs.filter((r) => r["p_event_type"] === "ai.sentiment_alert");
  const meta = alertas[0]?.["p_metadata"] as { threshold?: number } | undefined;
  const chamadasDeLog = vi.mocked(logInvocation).mock.calls;
  const ultima = chamadasDeLog[chamadasDeLog.length - 1]?.[0];

  return {
    alertas,
    limiarDoAlerta: meta?.threshold ?? null,
    agenteDoCusto: ultima?.agent_id ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: "modelo-dublê",
    modelId: "anthropic/claude-haiku-4-5",
  } as unknown as Awaited<ReturnType<typeof resolverModeloDoPonto>>);
  vi.mocked(generateObject).mockResolvedValue({
    object: { sentiment_score: NOTA, reasoning_short: "cliente reclamando de recorrência" },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

describe("limiar de sentimento — o agente da conversa é quem manda (#486)", () => {
  it("o cenário sabe distinguir os dois limiares (controle positivo)", () => {
    // Sem esta cerca, alguém que iguale os limiares faz TODOS os casos abaixo
    // passarem sem conseguir separar comportamento nenhum.
    expect(LIMIAR_TECNICA).toBeLessThan(NOTA);
    expect(LIMIAR_CLINICA).toBeGreaterThan(NOTA);
    expect(LIMIAR_PADRAO).toBeLessThan(NOTA);
  });

  it("conversa no número da assistência técnica usa o limiar DELA, não o do agente mais antigo", async () => {
    const r = await rodar({ sessaoDaConversa: SESSAO_TECNICA });

    expect(
      r.alertas,
      `escalou uma conversa de assistência técnica com nota ${NOTA}: o limiar que valeu foi ${r.limiarDoAlerta} (o do agente da clínica), não o ${LIMIAR_TECNICA} configurado no agente que atende este número`,
    ).toHaveLength(0);
    expect(
      r.agenteDoCusto,
      "o custo da classificação foi atribuído ao agente errado na tela de consumo de IA",
    ).toBe(AGENTE_TECNICA);
  });

  it("conversa no número da clínica continua escalando pelo limiar da clínica", async () => {
    // Guarda de vacuidade: um conserto que passasse a devolver sempre o último
    // agente, ou sempre o padrão do produto, apagaria a escalação desta org.
    const r = await rodar({ sessaoDaConversa: SESSAO_CLINICA });

    expect(r.alertas, "a clínica deixou de ser avisada de um cliente insatisfeito").toHaveLength(1);
    expect(r.limiarDoAlerta).toBe(LIMIAR_CLINICA);
    expect(r.agenteDoCusto).toBe(AGENTE_CLINICA);
  });

  it("stickiness do router vence a sessão — o agente que já atende a conversa é o dono do limiar", async () => {
    // O Intent Router grava `conversations.active_ai_agent_id`; o agente-membro
    // pode não ter vínculo com a channel_session do turno (quem tem é o ROUTER).
    const r = await rodar({
      sessaoDaConversa: SESSAO_CLINICA,
      agenteGrudado: AGENTE_TECNICA,
    });

    expect(
      r.alertas,
      `o limiar em vigor foi ${r.limiarDoAlerta}, e quem atende esta conversa é o agente da técnica (${LIMIAR_TECNICA})`,
    ).toHaveLength(0);
    expect(r.agenteDoCusto).toBe(AGENTE_TECNICA);
  });

  it("organização de um agente legado só continua usando o limiar dele", async () => {
    // A instalação nova — `rag_bot` ativo, nenhuma versão publicada, nenhuma
    // ligação com a sessão. Não há ambiguidade nenhuma a resolver aqui, e cair
    // no padrão do produto seria trocar um defeito por uma regressão.
    const r = await rodar({ sessaoDaConversa: SESSAO_ORFA, somenteLegado: true });

    expect(r.alertas, "a única configuração de limiar da org deixou de valer").toHaveLength(1);
    expect(r.limiarDoAlerta).toBe(LIMIAR_CLINICA);
    expect(r.agenteDoCusto).toBe(AGENTE_CLINICA);
  });

  it("conversa que não resolve agente nenhum cai no padrão do produto, nunca no do vizinho", async () => {
    // Canal conectado depois, sem versão publicada apontando para ele: não dá
    // para saber de quem é a conversa. O padrão é honesto; o limiar do vizinho
    // é chute com cara de configuração.
    const r = await rodar({ sessaoDaConversa: SESSAO_ORFA });

    expect(
      r.alertas,
      `escalou pelo limiar ${r.limiarDoAlerta}, que é do agente da clínica — um agente que não tem nada a ver com esta conversa`,
    ).toHaveLength(0);
    expect(
      r.agenteDoCusto,
      "atribuiu o custo a um agente que não atende esta conversa",
    ).toBeNull();
  });
});
