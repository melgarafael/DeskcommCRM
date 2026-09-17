/**
 * O DRENO NÃO PERDE EVENTO — nem por travar, nem por calar.
 *
 * Dois defeitos que se encontraram na prova de tela desta frente, e que juntos
 * apagam o material que a pessoa acabou de cadastrar:
 *
 * **1. Evento preso em `processing` não voltava.** `drainEventLog` marca a
 * linha `processing` ANTES de chamar o handler, e nada no produto a devolvia.
 * Handler que não retorna — processo derrubado, OOM, ida a serviço externo sem
 * timeout — deixava o evento preso para SEMPRE. `job_queue` tem reaper desde
 * sempre; o `event_log` não tinha. Medido: `status=processing`, `attempts=0`,
 * `consumed_by` vazio, e o material nunca preparado.
 *
 * **2. `skipped` descartava o motivo.** Ele conta como sucesso, e deve mesmo —
 * o handler decidiu que não era caso dele. Mas o `detail` era jogado fora por
 * construção, e com ele a única evidência de por que um evento não fez nada:
 * quem investigasse "cadastrei e não aconteceu nada" achava uma linha `done`
 * sem uma palavra de explicação.
 *
 * O dublê do Supabase é mínimo de propósito: o que se mede é o SQL que o dreno
 * pede, não o comportamento do PostgREST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));

const handlers = vi.fn();
const dispatch = vi.fn();
vi.mock("@/lib/event-log/dispatcher", () => ({
  getRegisteredHandlers: () => handlers(),
  dispatchEvent: (row: unknown) => dispatch(row),
}));

import { DETALHE_TECNICO, IA_QUE_NAO_RESPONDEU } from "@/lib/event-log/aviso-de-evento-morto";
import { drainEventLog } from "@/lib/event-log/drain";

interface Chamada {
  tabela: string;
  op: string;
  payload?: Record<string, unknown>;
  filtros: Array<[string, string, unknown]>;
}

/**
 * Dublê que REGISTRA o que foi pedido. Devolve linhas só para o `select` do
 * dreno; os `update` devolvem o que o código precisa para seguir.
 */
function dublarAdmin(
  linhas: Array<Record<string, unknown>>,
  /**
   * O que a Central já tem aberto do mesmo kind. `null` = nada aberto. Uma
   * função responde pelo que o próprio dreno já inseriu nesta rodada.
   */
  avisoAberto:
    | Record<string, unknown>
    | null
    | ((chamadas: Chamada[]) => Record<string, unknown> | null) = null,
) {
  const chamadas: Chamada[] = [];

  function cadeia(tabela: string) {
    const registro: Chamada = { tabela, op: "select", filtros: [] };
    let ehUpdateDeReclamacao = false;
    let ehClaim = false;

    const self: Record<string, unknown> = {
      select: () => {
        // `.select()` depois de `.update()` é o retorno do update, não uma
        // consulta nova: não sobrescreve a operação registrada.
        if (registro.op === "select") chamadas.push(registro);
        return self;
      },
      update: (payload: Record<string, unknown>) => {
        registro.op = "update";
        registro.payload = payload;
        chamadas.push(registro);
        ehUpdateDeReclamacao = payload.status === "pending" && payload.updated_at !== undefined;
        ehClaim = payload.status === "processing";
        return self;
      },
      eq: (c: string, v: unknown) => {
        registro.filtros.push(["eq", c, v]);
        return self;
      },
      neq: (c: string, v: unknown) => {
        registro.filtros.push(["neq", c, v]);
        return self;
      },
      lt: (c: string, v: unknown) => {
        registro.filtros.push(["lt", c, v]);
        return self;
      },
      or: (v: unknown) => {
        registro.filtros.push(["or", "", v]);
        return self;
      },
      in: (c: string, v: unknown) => {
        registro.filtros.push(["in", c, v]);
        return self;
      },
      insert: (payload: Record<string, unknown>) => {
        registro.op = "insert";
        registro.payload = payload;
        chamadas.push(registro);
        return self;
      },
      order: () => self,
      limit: () => self,
      maybeSingle: () => self,
      then: (resolve: (r: unknown) => void) => {
        if (registro.op === "insert") {
          resolve({ error: null });
          return;
        }
        if (registro.op === "update") {
          // Reclamação de órfão devolve lista vazia; claim devolve a linha.
          resolve({ data: ehClaim ? [{ id: "e1" }] : ehUpdateDeReclamacao ? [] : [{ id: "e1" }] });
          return;
        }
        // A Central responde pelo que ELA tem — devolver `linhas` aqui faria o
        // dedupe enxergar um evento como se fosse aviso aberto, e o teste do
        // aviso passaria por engano.
        if (tabela === "agent_inbox_items") {
          resolve({
            data: typeof avisoAberto === "function" ? avisoAberto(chamadas) : avisoAberto,
            error: null,
          });
          return;
        }
        resolve({ data: linhas, error: null });
      },
    };
    return self;
  }

  return { admin: { from: (t: string) => cadeia(t) }, chamadas };
}

const LINHA = {
  id: "e1",
  organization_id: "org-1",
  event_type: "knowledge_source.updated",
  entity_kind: "ai_knowledge_source",
  entity_id: "ks-1",
  payload: {},
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  handlers.mockReset();
  dispatch.mockReset();
  handlers.mockReturnValue([{ key: "k", events: ["knowledge_source.updated"] }]);
});

describe("drainEventLog — evento preso volta para a fila", () => {
  it("devolve `processing` velho para `pending` ANTES de selecionar", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "ok" }]);
    const { admin, chamadas } = dublarAdmin([]);

    await drainEventLog(admin as never);

    const reclamacao = chamadas.find(
      (c) =>
        c.op === "update" &&
        c.payload?.status === "pending" &&
        c.filtros.some(([tipo, col, val]) => tipo === "eq" && col === "status" && val === "processing"),
    );
    expect(reclamacao, "nada devolve evento preso em processing").toBeDefined();
    // A janela existe: sem ela, a reclamação pegaria o evento que ESTÁ sendo
    // processado agora e dois workers agiriam sobre o mesmo evento.
    expect(
      reclamacao!.filtros.some(([tipo, col]) => tipo === "lt" && col === "updated_at"),
      "reclamou sem janela de tempo — trocaria evento parado por efeito em dobro",
    ).toBe(true);
  });

  it("a reclamação acontece ANTES da seleção, senão o evento devolvido só rodaria no próximo tique", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "ok" }]);
    const { admin, chamadas } = dublarAdmin([]);

    await drainEventLog(admin as never);

    const iReclama = chamadas.findIndex((c) => c.op === "update" && c.payload?.status === "pending");
    const iSeleciona = chamadas.findIndex((c) => c.op === "select");
    expect(iReclama).toBeGreaterThanOrEqual(0);
    expect(iSeleciona).toBeGreaterThan(iReclama);
  });
});

describe("drainEventLog — o motivo de um `skipped` sobrevive à linha", () => {
  it("grava o detail do skip em last_error, sem mudar o desfecho", async () => {
    dispatch.mockResolvedValue([
      { consumer_key: "rag-indexer.v1", status: "skipped", detail: "conversas_tem_pipeline_proprio" },
    ]);
    const { admin, chamadas } = dublarAdmin([LINHA]);

    const resumo = await drainEventLog(admin as never);

    expect(resumo.done, "skipped continua contando como concluído").toBe(1);
    const final = chamadas.filter((c) => c.op === "update" && c.payload?.status === "done").pop();
    expect(final, "o evento não foi concluído").toBeDefined();
    expect(String(final!.payload?.last_error)).toContain("conversas_tem_pipeline_proprio");
  });

  it("skip SEM detail não inventa last_error (controle)", async () => {
    // Sem este controle, o caso acima passaria com o dreno escrevendo qualquer
    // coisa em `last_error` — inclusive `undefined` virando texto.
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "skipped" }]);
    const { admin, chamadas } = dublarAdmin([LINHA]);

    await drainEventLog(admin as never);

    const final = chamadas.filter((c) => c.op === "update" && c.payload?.status === "done").pop();
    expect(final!.payload).not.toHaveProperty("last_error");
  });
});

/**
 * O EVENTO QUE MORRE AVISA ALGUÉM.
 *
 * O kind `event_dead` estava na constraint de `agent_inbox_items`, na cópia e
 * na política de destino desde a migration 0050 — e **sem um único produtor**.
 * Evento que esgotava as tentativas virava `status='dead'` e sumia. Medido numa
 * VPS em produção: quatro `media.derive_requested` mortos, cliente ouvindo "não
 * consigo ouvir áudio", ninguém do lado de cá sabendo.
 */
describe("drainEventLog — evento morto abre aviso na Central", () => {
  const MORIBUNDO = { ...LINHA, attempts: 4 }; // a 5ª falha é a que mata

  function avisos(chamadas: Chamada[]) {
    return chamadas.filter((c) => c.op === "insert" && c.tabela === "agent_inbox_items");
  }

  it("na tentativa que mata, insere `event_dead` com o motivo e a organização", async () => {
    dispatch.mockResolvedValue([
      { consumer_key: "media-derive.v1", status: "error", detail: "transcription_401" },
    ]);
    const { admin, chamadas } = dublarAdmin([MORIBUNDO]);

    const resumo = await drainEventLog(admin as never);

    expect(resumo.dead, "o evento não foi dado como morto").toBe(1);
    const [aviso] = avisos(chamadas);
    expect(aviso, "evento morreu sem abrir aviso na Central").toBeDefined();
    expect(aviso!.payload).toMatchObject({
      organization_id: "org-1",
      kind: "event_dead",
      severity: "critical",
    });
    expect(String(aviso!.payload?.body)).toContain("transcription_401");
    // O nome do evento sai do título (quem lê a Central não programa) e fica no corpo, no detalhe técnico.
    expect(String(aviso!.payload?.title)).not.toContain(MORIBUNDO.event_type);
    expect(String(aviso!.payload?.body)).toContain(MORIBUNDO.event_type);
    // No corpo, o nome do evento vai para o detalhe técnico, no fim — o começo é
    // lido por quem não programa (ver `aviso-de-evento-morto.ts`).
    const corpo = String(aviso!.payload?.body);
    expect(corpo.indexOf(DETALHE_TECNICO), "o corpo sem o rótulo de detalhe técnico").toBeGreaterThan(0);
    expect(corpo.slice(corpo.indexOf(DETALHE_TECNICO))).toContain(MORIBUNDO.event_type);
    // O corpo só pede o que a tela oferece: não existe tela de `event_log` nem
    // botão de reprocessar. O que existe é "Marcar resolvido" — e é ele que
    // rearma o aviso, porque o dedupe é por kind.
    expect(String(aviso!.payload?.body)).not.toMatch(/reprocess/i);
    expect(String(aviso!.payload?.body)).toContain("marque-o como resolvido");
    // `refs: []` é a política de `event_dead` (lib/ai/inbox-destino.ts): não há
    // tela de `event_log`, e um ref sem destino viraria botão que não leva a
    // lugar nenhum.
    expect(aviso!.payload).not.toHaveProperty("ref_kind");
  });

  it("falha que ainda VAI tentar de novo não avisa (controle)", async () => {
    // Sem este controle, o caso acima passaria com o dreno abrindo aviso a cada
    // tentativa — cinco avisos por evento, que é como a Central deixa de ser lida.
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "error", detail: "timeout" }]);
    const { admin, chamadas } = dublarAdmin([{ ...LINHA, attempts: 0 }]);

    const resumo = await drainEventLog(admin as never);

    expect(resumo.failed).toBe(1);
    expect(resumo.dead).toBe(0);
    expect(avisos(chamadas), "avisou antes de o evento morrer").toHaveLength(0);
  });

  it("com aviso do mesmo kind já aberto, não abre outro", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "error", detail: "boom" }]);
    const { admin, chamadas } = dublarAdmin([MORIBUNDO], { id: "aviso-1" });

    await drainEventLog(admin as never);

    expect(avisos(chamadas), "Central inundada é Central que ninguém abre").toHaveLength(0);
  });

  it("o aviso aberto da IA que deixou de responder NÃO cala o de outro processamento", async () => {
    // A Central deste dublê tem aberto só o `event_dead` da IA, e responde à
    // consulta do dreno pelos FILTROS que ela trouxe: se a consulta não excluir
    // o título da IA, ela o enxerga como "já há aviso aberto" e o de mídia some
    // — o mesmo engolimento que calava a IA, na direção oposta.
    dispatch.mockResolvedValue([{ consumer_key: "media-derive.v1", status: "error", detail: "timeout" }]);
    const soOAvisoDaIaAberto = (feitas: Chamada[]) => {
      const consulta = [...feitas]
        .reverse()
        .find((c) => c.tabela === "agent_inbox_items" && c.op === "select");
      const excluiAIa = consulta?.filtros.some(
        ([op, coluna, valor]) => op === "neq" && coluna === "title" && valor === IA_QUE_NAO_RESPONDEU.titulo,
      );
      return excluiAIa ? null : { id: "aviso-da-ia" };
    };
    const { admin, chamadas } = dublarAdmin([MORIBUNDO], soOAvisoDaIaAberto);

    await drainEventLog(admin as never);

    const [aviso] = avisos(chamadas);
    expect(aviso, "o aviso aberto da IA engoliu a morte de outro processamento").toBeDefined();
    // O nome do evento sai do título (quem lê a Central não programa) e fica no corpo, no detalhe técnico.
    expect(String(aviso!.payload?.title)).not.toContain(MORIBUNDO.event_type);
    expect(String(aviso!.payload?.body)).toContain(MORIBUNDO.event_type);
    expect(String(aviso!.payload?.body)).toContain("abre o seu próprio");
  });

  it("mil eventos mortos na mesma rodada abrem UM aviso, não mil", async () => {
    // O dublê responde "já há aviso aberto?" pelo que o PRÓPRIO dreno inseriu
    // até ali — é o que mede a sequência de verdade (cada morte consulta depois
    // de a anterior ter inserido), em vez de afirmar o dedupe com um aviso
    // aberto de antemão, que é o caso de cima.
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "error", detail: "boom" }]);
    const mil = Array.from({ length: 1000 }, (_, i) => ({ ...MORIBUNDO, id: `e${i}` }));
    const { admin, chamadas } = dublarAdmin(mil, (feitas) =>
      feitas.some((c) => c.op === "insert" && c.tabela === "agent_inbox_items") ? { id: "aviso-1" } : null,
    );

    const resumo = await drainEventLog(admin as never, { limit: 1000 });

    expect(resumo.dead, "o dublê não matou os mil").toBe(1000);
    expect(avisos(chamadas), "Central inundada é Central que ninguém abre").toHaveLength(1);
  });

  it("recusa do INSERT não derruba o dreno", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "error", detail: "boom" }]);
    const { admin } = dublarAdmin([MORIBUNDO]);
    const original = admin.from;
    admin.from = (t: string) => {
      const c = original(t) as Record<string, unknown>;
      if (t === "agent_inbox_items") {
        const insert = c.insert as (p: unknown) => unknown;
        c.insert = (p: unknown) => {
          insert(p);
          return { then: (r: (x: unknown) => void) => r({ error: { message: "23514" } }) };
        };
      }
      return c as never;
    };

    const resumo = await drainEventLog(admin as never);

    expect(resumo.dead, "aviso recusado derrubou o dreno").toBe(1);
  });
});
