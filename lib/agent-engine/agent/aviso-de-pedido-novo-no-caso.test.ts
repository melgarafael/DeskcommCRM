/**
 * PEDIDO NOVO NUM CASO JÁ ABERTO: NINGUÉM É AVISADO — ENTÃO A IA NÃO PODE DIZER
 * QUE AVISOU (issue #3097).
 *
 * ═══ O defeito, como o autor mediu (v1.86.0) ═════════════════════════════════
 *
 * Com um caso em `awaiting_human` (a equipe resolveu o assunto direto na
 * conversa, sem fechar o caso), o PEDIDO NOVO do cliente é recusado pela guarda
 * de caso aberto (`openCase` → `case_already_open`). O agente então anota no caso
 * antigo (`agent_noted`) e responde ao cliente que anotou para a equipe — mas
 * `agent_noted` não gera `alert_sent` e não nasce linha em
 * `entregas_de_aviso_de_caso`, que é a ÚNICA superfície desta feature capaz de
 * avisar alguém. O cliente fica esperando quem nunca foi chamado.
 *
 * ═══ O que este arquivo prende ══════════════════════════════════════════════
 *
 * A saída escolhida no PR é a (b): a recusa devolve ao agente INSTRUÇÃO que o
 * impede de prometer que a equipe foi acionada, e a frase ao cliente muda junto.
 * O teste prende as duas pontas:
 *
 *   1. a recusa real (`openCase` de verdade) traz a instrução e a frase;
 *   2. o caminho do pedido novo NÃO produz aviso nenhum — nem evento, nem linha
 *      de entrega, nem envio — o que é o FATO que torna a promessa uma mentira;
 *   3. os dois controles pedidos: o primeiro pedido continua igual e o aviso
 *      inicial não se repete a cada mensagem.
 *
 * ═══ O que NÃO é provado aqui, para não confundir medição com relato ════════
 *
 * O pool do engine é um DUBLÊ (mesmo desenho de `tests/unit/mcp-escalacao-tools.
 * test.ts`): ele prende o CONTRATO — 0 linha devolvida pelo statement atômico é
 * recusa, nunca sucesso falso. Que o `where not exists` realmente proteja o
 * estado é coisa de Postgres de verdade, e está em
 * `tests/invariants/human-cases.test.ts`. O lado do AVISO (item 2) roda a REGRA
 * de produção inteira (`aplicaAvisoDeCaso`), que nasceu pura e testável com
 * banco, relógio e transporte falsos.
 */
import { describe, expect, it } from "vitest";

import {
  EVENTO_CASO_ABERTO,
  aplicaAvisoDeCaso,
  type AvisoDb,
  type AvisoDeps,
  type EntregaDoAviso,
} from "@/lib/escalacao/aviso-ao-suporte";
import type { EventRow } from "@/lib/event-log/dispatcher";

import {
  FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO,
  openCase,
  registrarNotaDoAgente,
  type CaseIds,
} from "./human-cases";

const AGORA = new Date("2026-10-21T14:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CASO_ANTIGO = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const DESTINO = "+553****6398";

const ids: CaseIds = { tenantId: ORG, conversationId: CONVERSA };

/** Payload do pedido novo — o mesmo formato do closure do turno. */
const PEDIDO_NOVO = {
  title: "Liberar acesso ao painel novo",
  summary: "O cliente pediu outra coisa depois do caso já aberto.",
  blocker: "Precisa de uma pessoa para liberar.",
};

/**
 * Dublê do pool do engine: devolve o que o statement atômico devolveria e
 * registra cada consulta, para o teste poder afirmar o que foi escrito.
 */
function poolDoEngine(linhas: Array<{ case_id: string }>, rowCount = linhas.length) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: (sql: string, params: unknown[]) => {
      consultas.push({ sql, params });
      return Promise.resolve({ rows: linhas, rowCount });
    },
  } as never;
  return { pool, consultas };
}

/** Uma linha de `entregas_de_aviso_de_caso` como o adapter a devolve. */
function entrega(over: Partial<EntregaDoAviso> = {}): EntregaDoAviso {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organization_id: ORG,
    case_id: CASO_ANTIGO,
    destino: DESTINO,
    status: "pendente",
    tentativas: 0,
    created_at: new Date(AGORA.getTime() - 60_000).toISOString(),
    updated_at: new Date(AGORA.getTime() - 60_000).toISOString(),
    ...over,
  };
}

/**
 * O banco do aviso em memória, com as TRÊS coisas que este arquivo mede: as
 * linhas de entrega, os envios que de fato saíram e as linhas de
 * `agent_case_events` (é por aqui que `alert_sent` aparece — ou não).
 */
function montaAviso() {
  const entregas = new Map<string, EntregaDoAviso>();
  const eventosDoCaso: Array<{ kind: string; actorKind: string }> = [];
  const envios: string[] = [];

  const db: AvisoDb = {
    async carregaConfig() {
      return {
        organization_id: ORG,
        channel_session_id: CANAL,
        telefone_destino: DESTINO,
        destino_jid: null,
        ligado: true,
        resposta_whatsapp_habilitada: false,
      };
    },
    async carregaCaso() {
      return {
        id: CASO_ANTIGO,
        organization_id: ORG,
        conversation_id: CONVERSA,
        kind: "acesso",
        source: "agent",
        status: "awaiting_human",
        title: PEDIDO_NOVO.title,
        summary: PEDIDO_NOVO.summary,
        blocker: PEDIDO_NOVO.blocker,
      };
    },
    async contatoAnonimizado() {
      return false;
    },
    // O adapter real faz o INSERT e, no `23505` da `unique (organization_id,
    // case_id, destino)`, relê a linha. Aqui o Map encena os DOIS desfechos — é
    // este controle de repetição que o reenvio teria de reusar (e é ele que faz
    // o segundo pedido não avisar ninguém).
    async reivindicaEntrega(entrada) {
      const chave = `${entrada.caseId}:${entrada.destino}`;
      const existente = entregas.get(chave);
      if (existente) return { criada: false, entrega: existente };
      const nova = entrega({ destino: entrada.destino, case_id: entrada.caseId });
      entregas.set(chave, nova);
      return { criada: true, entrega: nova };
    },
    async atualizaEntrega(_org, entregaId, patch) {
      for (const [chave, linha] of entregas) {
        if (linha.id !== entregaId) continue;
        entregas.set(chave, { ...linha, ...patch } as EntregaDoAviso);
      }
    },
    async cancelaPendentesDoCaso() {
      return 0;
    },
    async carregaCanal() {
      return { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true };
    },
    async destinoEhDaPropriaOrganizacao() {
      return false;
    },
    async avisaNaCentral() {},
    async registraEventoDoCaso({ kind, actorKind }) {
      eventosDoCaso.push({ kind, actorKind });
    },
    async registraJidDoAviso() {},
    async nomeDoContato() {
      return "Maria";
    },
    async marcaDaOrganizacao() {
      return { nome: "Acme", idioma: "pt-BR" };
    },
  };

  const deps: AvisoDeps = {
    db,
    transporte: {
      async configurado() {
        return true;
      },
      async resolveDestino(_org, _canal, telefone) {
        return `${telefone.replace(/\D/g, "")}@c.us`;
      },
      async envia(_org, _canal, to) {
        envios.push(to);
        return { externalId: "wamid.X" };
      },
    },
    pacing: {
      async decide() {
        return { liberado: true };
      },
      async registraEnvio() {},
    },
    clock: () => AGORA,
    urlPublica: "https://crm.exemplo.com.br",
    origemDoDreno: () => "worker",
    audita: () => {},
  };

  return { deps, entregas, eventosDoCaso, envios };
}

/** A linha do `event_log` que a trigger do banco emite ao abrir o caso. */
const ROW_DO_CASO: EventRow = {
  id: "66666666-6666-4666-8666-666666666666",
  organization_id: ORG,
  event_type: EVENTO_CASO_ABERTO,
  entity_kind: "agent_case",
  entity_id: CASO_ANTIGO,
  payload: {
    case_id: CASO_ANTIGO,
    conversation_id: CONVERSA,
    contact_id: "77777777-7777-4777-8777-777777777777",
    source: "agent",
  },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date(AGORA.getTime() - 30_000).toISOString(),
};

describe("pedido novo num caso já aberto (#3097)", () => {
  it("a recusa da guarda devolve INSTRUÇÃO: proíbe prometer que a equipe foi acionada e diz o que o cliente pode ouvir", async () => {
    // O statement atômico não devolveu linha: a guarda de caso aberto recusou —
    // é a sequência exata do relato (caso em awaiting_human, pedido novo).
    const { pool } = poolDoEngine([]);

    const res = await openCase(pool, ids, PEDIDO_NOVO);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("a guarda de caso aberto deveria recusar");
    expect(res.error.code).toBe("case_already_open");

    const instrucao = res.error.message;
    // A verdade do caminho: ninguém foi avisado agora.
    expect(instrucao).toContain("NÃO foi avisada");
    // A proibição da promessa que o relato flagrou.
    expect(instrucao).toContain("NÃO diga ao cliente que a equipe foi acionada");
    expect(instrucao).toContain("não prometa prazo");
    // A guarda recusa QUALQUER caso aberto da conversa, sem comparar assunto:
    // afirmar "outro assunto" seria falso quando o cliente insiste no mesmo.
    expect(instrucao).not.toContain("outro assunto");
    // E o que fazer no lugar: registrar no caso aberto SÓ com a ferramenta que
    // registra de fato, vetando o desvio pela provide_case_update — e a frase ao
    // cliente, que muda junto (é ela que o modelo manda).
    expect(instrucao).toContain("Se você tiver a ferramenta crm_add_case_note");
    expect(instrucao).toContain("NÃO use provide_case_update");
    expect(instrucao).toContain("Só diga ao cliente que o pedido ficou registrado no caso se você registrou de fato");
    expect(instrucao).toContain(FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO);
    // A frase precisa ser verdadeira mesmo quando o registro NÃO aconteceu.
    expect(FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO).not.toContain("registrado no caso");
  });

  it("controle — o primeiro pedido continua igual: sem caso aberto, o caso abre, e nada carrega instrução", async () => {
    const { pool, consultas } = poolDoEngine([{ case_id: CASO_ANTIGO }]);

    const res = await openCase(pool, ids, PEDIDO_NOVO);

    expect(res).toEqual({ ok: true, caseId: CASO_ANTIGO });
    // O caso e o evento `opened` nascem no MESMO statement atômico — uma ida ao
    // pool, como antes da mudança (a linha em si é do Postgres; ver o invariante).
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toContain("insert into agent_cases");
    expect(consultas[0]!.sql).toContain("'opened'");
  });

  it("o registro do agente no caso aberto grava agent_noted e NUNCA alert_sent — anotar não avisa ninguém", async () => {
    const { pool, consultas } = poolDoEngine([], 1);

    const registrou = await registrarNotaDoAgente(pool, ORG, CASO_ANTIGO, "pedido novo do cliente");

    expect(registrou).toBe(true);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toContain("'agent_noted'");
    // O fato medido pelo autor: `agent_noted` não gera `alert_sent`. Se algum
    // caminho do pedido novo escrevesse o aviso, ele apareceria aqui.
    expect(consultas.some((c) => c.sql.includes("alert_sent"))).toBe(false);
  });

  it("controle — o aviso sai UMA vez por caso, e o pedido novo no mesmo caso não cria linha nem segundo aviso", async () => {
    const { deps, entregas, eventosDoCaso, envios } = montaAviso();

    // O aviso inicial do caso (o único momento em que a equipe é avisada).
    const primeiro = await aplicaAvisoDeCaso(deps, ROW_DO_CASO);
    expect(primeiro.status).toBe("ok");
    expect(entregas.size).toBe(1);
    expect(envios).toHaveLength(1);
    expect(eventosDoCaso).toEqual([{ kind: "alert_sent", actorKind: "system" }]);

    // O dreno reentrega o MESMO evento (retry/outro processo) — não repete o
    // aviso: o controle de repetição é a reivindicação da entrega.
    const segundo = await aplicaAvisoDeCaso(deps, ROW_DO_CASO);
    expect(segundo.status).toBe("skipped");
    expect(segundo.detail).toContain("ja_resolvido:enviado");
    expect(entregas.size).toBe(1);
    expect(envios).toHaveLength(1);
    expect(eventosDoCaso).toHaveLength(1);

    // E o pedido novo do cliente não tem evento no barramento: a abertura
    // (`ai.case_opened`) nasce de INSERT em agent_cases — e a guarda de caso
    // aberto não deixa nascer outro. Nada novo chega à equipe por este caminho,
    // que é exatamente por que a recusa precisa proibir a promessa.
    expect(eventosDoCaso.filter((e) => e.kind !== "alert_sent")).toHaveLength(0);
  });
});
