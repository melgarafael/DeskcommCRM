import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";

/**
 * A INGESTÃO MARCA A CONVERSA COM O AGENTE DA CAMPANHA DE ENTRADA (#4024).
 *
 * ─── O que estava acontecendo ───────────────────────────────────────────────
 *
 * A frase do anúncio casava a campanha e o contato ficava ELEGÍVEL
 * (`ai_authorized_reason = campanha:<id>`) — e só. O `agent_id` que a config da
 * campanha declara desde a 0203 era aceito pelo schema e ignorado por todo
 * mundo: quem respondia era o agente do número.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * O terceiro efeito da campanha: gravar `conversations.campaign_entry_agent_id`
 * para o `resolve-turn-agent` ler. E os lados opostos — campanha sem `agent_id`,
 * mensagem que não casa campanha, e a conversa que já foi marcada: nada é
 * sobrescrito, porque o cliente já foi recebido por aquele agente.
 */

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: vi.fn(async () => ({ lead: {}, jaEstava: false })) }));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: vi.fn(async () => ({ criado: true, leadId: "lead-1" })),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/leads/origem-por-horario", () => ({ casarOrigemPorHorario: vi.fn(async () => {}) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: vi.fn(async () => {}),
  drenarEventosDoInbound: vi.fn(async () => {}),
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));

const AGENTE = "3f1c8c1e-0d2a-4a51-9a1e-1f6b7c8d9e01";
const CONVERSA = "conversa-1";
const ORG = "org-1";

/** Uma escrita registrada: a tabela, o payload e os filtros que a acompanharam. */
interface Escrita {
  tabela: string;
  payload: Record<string, unknown>;
  filtros: Record<string, unknown>;
}

let escritas: Escrita[] = [];
/** O que o `maybeSingle()` de cada tabela devolve. */
let linhas: Record<string, unknown> = {};

/**
 * O cliente admin de mentira: builder encadeável do PostgREST. `maybeSingle()`
 * responde a linha da tabela; aguardar a cadeia direto (o `update` sem
 * `select`, e o `select` de lista) registra a escrita ou devolve lista vazia.
 */
function adminFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let payload: Record<string, unknown> | null = null;
      const cadeia: Record<string, unknown> = {
        eq(coluna: string, valor: unknown) {
          filtros[coluna] = valor;
          return cadeia;
        },
        is(coluna: string, valor: unknown) {
          filtros[coluna] = valor;
          return cadeia;
        },
        in(coluna: string, valor: unknown) {
          filtros[coluna] = valor;
          return cadeia;
        },
        order() {
          return cadeia;
        },
        limit() {
          return cadeia;
        },
        update(dados: Record<string, unknown>) {
          payload = dados;
          return cadeia;
        },
        select() {
          return cadeia;
        },
        async maybeSingle() {
          return { data: linhas[tabela] ?? null, error: null, count: 1 };
        },
        then(resolve: (v: unknown) => void) {
          if (payload !== null) escritas.push({ tabela, payload, filtros: { ...filtros } });
          return Promise.resolve({ data: [], error: null, count: null }).then(resolve);
        },
      };
      return cadeia;
    },
    async rpc() {
      return { error: null };
    },
  };
}

const ENTRADA: EntradaDeMensagem = {
  organizationId: ORG,
  contactId: "contato-1",
  conversationId: CONVERSA,
  messageId: "msg-1",
  channelSessionId: "sessao-1",
  texto: "Quero saber mais sobre implantes",
  nomeDoContato: "Cliente",
  requestId: "req-1",
  origem: "canal_de_teste",
};

function campanha(over: Record<string, unknown> = {}) {
  return {
    id: "implantes",
    label: "Implantes",
    match: { tipo: "contains", valor: "quero saber mais sobre implantes" },
    agent_id: AGENTE,
    ...over,
  };
}

async function rodar(over: Partial<EntradaDeMensagem> = {}) {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(adminFalso() as never, { ...ENTRADA, ...over });
}

/** A escrita que grava o agente da campanha na conversa, se houve. */
function marcacaoDaConversa(): Escrita | undefined {
  return escritas.find(
    (e) => e.tabela === "conversations" && e.payload.campaign_entry_agent_id !== undefined,
  );
}

beforeEach(() => {
  escritas = [];
  linhas = {
    channel_sessions: { metadata: { ai_gate: "allowlist" } },
    contacts: { ai_authorized_at: null, is_personal: false, is_blocked: false },
    organizations: { settings: { campanhas_whatsapp: [campanha()] } },
    messages: { id: "msg-1" },
  };
});

describe("o agente da campanha de entrada vai para a CONVERSA", () => {
  it("grava o `agent_id` da campanha, recortado por organização e pela conversa", async () => {
    await rodar();

    const marcacao = marcacaoDaConversa();
    expect(marcacao, "a conversa não foi marcada com o agente da campanha").toBeDefined();
    expect(marcacao!.payload.campaign_entry_agent_id).toBe(AGENTE);
    // Sem o filtro por organização, um `conversationId` de outra empresa
    // receberia o agente desta; sem o `id`, o update varreria a tabela.
    expect(marcacao!.filtros).toMatchObject({ organization_id: ORG, id: CONVERSA });
    // A primeira campanha que casou é a que trouxe o cliente: uma frase de
    // outro anúncio, dias depois, não troca quem já abriu o atendimento.
    expect(marcacao!.filtros.campaign_entry_agent_id).toBeNull();
  });

  it("campanha SEM `agent_id` continua como hoje: elegível, e nada é gravado na conversa", async () => {
    linhas.organizations = { settings: { campanhas_whatsapp: [campanha({ agent_id: undefined })] } };

    await rodar();

    expect(marcacaoDaConversa()).toBeUndefined();
  });

  it("mensagem que não casa campanha nenhuma não toca a conversa", async () => {
    linhas.organizations = { settings: { campanhas_whatsapp: [campanha()] } };

    await rodar({ texto: "oi, tudo bem?" });

    expect(marcacaoDaConversa()).toBeUndefined();
  });

  it("canal com o gate ABERTO não consulta campanha nenhuma — e não marca (comportamento de hoje)", async () => {
    // O gate 'open' já entrega todo inbound à IA, e é o caminho em que a
    // ingestão NUNCA leu `organizations.settings`: manter a leitura fora dali é
    // o que impede uma leitura de jsonb por mensagem em quem nem usa o gate.
    // Consequência declarada: a campanha de entrada age nos canais em allowlist.
    linhas.channel_sessions = { metadata: { ai_gate: "open" } };

    await rodar();

    expect(marcacaoDaConversa()).toBeUndefined();
  });

  it("falha ao gravar não derruba a ingestão nem o despacho", async () => {
    const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
    const quebrado = {
      from(tabela: string) {
        if (tabela === "conversations") {
          return {
            update() {
              throw new Error("permission denied");
            },
          };
        }
        return adminFalso().from(tabela);
      },
      async rpc() {
        return { error: null };
      },
    };

    await expect(
      aplicarEfeitosPosEntrada(quebrado as never, { ...ENTRADA }),
    ).resolves.toBeUndefined();
  });
});
