/**
 * #3836 — O ÁUDIO QUE CHEGA NO MEIO DO TURNO.
 *
 * Relato medido em produção (01/11/2026): 09:33:40 o cliente escreve "bom dia"
 * e o turno começa; 09:34:10 e 09:34:17 chegam dois áudios; 09:34:19 o agente
 * responde "recebi o seu áudio, mas não consegui ouvir o conteúdo" — e segundos
 * depois a transcrição dos DOIS estava pronta, com a reclamação inteira.
 *
 * A espera que existia (`lib/agent-engine/edge/crm/drain.ts`) vale para a mídia
 * que já está na conversa quando o turno é DESPACHADO. A que chega DEPOIS disso
 * entrava no prompt como o marcador `[audio]`, e o modelo só podia dizer que
 * não ouviu.
 *
 * Este arquivo roda o turno REAL (`runAgentTurn`, com `getLeadContext` real e o
 * corpo composto por `corpoDaMensagem`) e mede o que o PROMPT recebe:
 *
 *  1. áudio que chega durante o turno — o turno espera a derivação e o contexto
 *     traz a TRANSCRIÇÃO, nunca `[audio]` (o caso do relato);
 *  2. mídia travada além do teto — o turno NÃO fica preso: segue em tempo, e o
 *     desfecho sai NOMEADO no log, não em silêncio.
 *
 * O ponto de parada dos dois casos é a primeira chamada de modelo (org sem
 * config de LLM), que é o mesmo de `filtro-de-palavra-chave-no-turno`: chegar
 * ali prova que o turno atravessou a abertura com o contexto já composto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Cada contexto que o turno recebeu — é o material do PROMPT. */
  contextos: [] as unknown[],
}));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", async (importOriginal) => {
  const real = (await importOriginal()) as unknown as {
    getLeadContext: (...args: never[]) => Promise<unknown>;
  } & Record<string, unknown>;
  return {
    ...real,
    getLeadContext: async (...args: never[]) => {
      const resultado = await real.getLeadContext(...args);
      mocks.contextos.push(resultado);
      return resultado;
    },
  };
});

import { corpoDaMensagem } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

/**
 * A hora do relato, num dia de semana (domingo mudaria a janela de atendimento
 * e o turno nem chegaria à abertura). 15:33:40Z = 12:33 BRT.
 */
const INICIO = Date.UTC(2026, 9, 6, 15, 33, 40);

const TRANSCRICAO_1 = "oi, estou no hotel e o quarto estava sujo, quero reclamar";
const TRANSCRICAO_2 = "e ninguém apareceu para limpar até agora";

interface Linha {
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_derived_text: string | null;
  sent_at: Date;
}

function texto(direction: Linha["direction"], body: string, emMs: number): Linha {
  return {
    direction,
    type: "text",
    body,
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: new Date(INICIO + emMs),
  };
}

/** Áudio como o ingest grava: `body` NULL, conteúdo só no derivado (que ainda não veio). */
function audio(emMs: number, id: string): Linha & { id: string } {
  return {
    id,
    direction: "inbound",
    type: "audio",
    body: null,
    media_url: `https://cdn.example/${id}.ogg`,
    media_storage_path: null,
    media_mime: "audio/ogg",
    media_derived_text: null,
    sent_at: new Date(INICIO + emMs),
  };
}

const LINHA_DO_CONTATO = {
  name: "Cliente",
  display_name: null,
  email: null,
  phone_number: "5511999999999",
  tags: [],
  is_blocked: false,
  is_personal: false,
  source: "whatsapp",
  consent: null,
  is_anonymized: false,
};

interface Estado {
  /** Quantas consultas de mídia pendente o turno já fez. */
  consultasDeMidia: number;
  /** Na Nª consulta a derivação "termina" (o worker grava `ready` + o texto). */
  prontaNaConsulta: number;
  /** Quando o histórico foi lido: guarda o estado da derivação naquele instante. */
  derivacaoProntaQuandoLeu: boolean | null;
  fixada: Linha & { id: string };
  linhas: () => Linha[];
  /** Idade da mídia pendente, em ms — é a âncora do teto. */
  idadeDaMidiaMs: number;
  /** Ordem dos fatos que o caso da resposta dupla mede. */
  eventos: string[];
}

/**
 * Pool fingido com o formato de CADA consulta que a abertura faz — o mesmo
 * molde de `tests/unit/filtro-de-palavra-chave-no-turno.test.ts`, mais a
 * consulta de mídia derivável, que é o que este arquivo mede.
 */
function poolDoTurno(estado: Estado) {
  const query = vi.fn(async (sql: string) => {
    // A consulta da ESPERA — tem de vir antes de qualquer `from messages`:
    // é a única que pergunta pelo estado da derivação.
    if (sql.includes("media_derived_status")) {
      estado.consultasDeMidia += 1;
      if (estado.consultasDeMidia >= estado.prontaNaConsulta) {
        estado.eventos.push("midia-pronta");
        return { rows: [] };
      }
      return {
        rows: [
          {
            type: "audio",
            media_derived_status: "pending",
            quando: new Date(Date.now() - estado.idadeDaMidiaMs).toISOString(),
          },
        ],
      };
    }
    if (/update job_queue/.test(sql) && sql.includes("ultima_inbound_vista_em")) {
      estado.eventos.push("anotou");
      return { rows: [] };
    }
    if (sql.includes("m.metadata->>'ai_actor_id'")) return { rows: [{ respondeu: false }] };
    if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
      return { rows: [LINHA_DO_CONTATO] };
    }
    if (sql.includes("from messages") && /and id = \$3/.test(sql)) {
      return { rows: [estado.fixada] };
    }
    if (sql.includes("from messages") && sql.includes("media_mime")) {
      estado.derivacaoProntaQuandoLeu = estado.consultasDeMidia >= estado.prontaNaConsulta;
      estado.eventos.push("leu");
      // O produtor pede DESC e inverte — devolve DESC, como o banco.
      return { rows: [...estado.linhas()].reverse() };
    }
    if (sql.includes("playbook_pointers")) {
      return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
    }
    return { rows: [] };
  });
  return { query } as never;
}

function logFalso() {
  const info = vi.fn();
  const warn = vi.fn();
  return {
    info,
    warn,
    error: vi.fn(),
    frases: () => [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])),
  };
}

/** O turno REAL, que para na primeira chamada de modelo (org sem config de LLM). */
async function turno(
  estado: Estado,
  log: ReturnType<typeof logFalso>,
  dormir: (ms: number) => Promise<void>,
): Promise<void> {
  const job = {
    id: JOB,
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "inbound_turn",
    payload: {},
    attempts: 1,
    claimed_by: "w",
    claimed_at: new Date(),
  };
  const deps = {
    log,
    llmCfg: {},
    crmCfg: {},
    knobs: { maxSteps: 1 },
    clock: () => new Date(Date.now()),
    sleep: dormir,
    channel: () => ({ send: vi.fn(async () => ({ kind: "sent" })) }),
  };
  await runAgentTurn(deps as never, job as never, poolDoTurno(estado), { workerId: "w" }, {
    resolvedAgent: {
      config: {
        agentId: "agente-1",
        versionId: "v1",
        operationMode: "automatic",
        pausedAt: null,
        systemPrompt: "persona",
        toolIds: [],
        casesEnabled: false,
        historyMessageWindow: 20,
        historyTokenWindow: 1000,
        handoffKeywords: [],
        filtroDePalavraChave: null,
      },
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: "fallback",
    },
    channelSessionId: CANAL,
    conversationId: CONVERSA,
    inboundMessageId: MENSAGEM,
    buildOpening: () => "",
  } as never);
}

/** A última mensagem do CLIENTE no contexto que o turno montou — o que o modelo lê. */
function ultimaInboundNoPrompt(): { body: string; type?: string } {
  const contexto = mocks.contextos.at(-1) as
    | { ok: true; context: { messages: { direction: string; body: string; type?: string }[] } }
    | undefined;
  expect(contexto?.ok, "o turno não chegou a montar contexto").toBe(true);
  const ultima = (contexto as { context: { messages: { direction: string; body: string }[] } }).context.messages.findLast(
    (m) => m.direction === "inbound",
  );
  expect(ultima, "o contexto não tem mensagem do cliente").toBeDefined();
  return ultima as { body: string };
}

/** O caso do relato: o "bom dia" dispara o turno e os dois áudios chegam depois. */
function estadoDoRelato(): Estado {
  const bomDia = texto("inbound", "bom dia", 0);
  const audio1 = audio(30_000, "audio-1");
  const audio2 = audio(37_000, "audio-2");
  const estado: Estado = {
    consultasDeMidia: 0,
    // Terceira consulta: a derivação termina, como no relato (segundos depois).
    prontaNaConsulta: 3,
    derivacaoProntaQuandoLeu: null,
    fixada: bomDia as Linha & { id: string },
    idadeDaMidiaMs: 30_000,
    eventos: [],
    linhas: () => [
      texto("outbound", "Oi! Como posso ajudar?", -20_000),
      bomDia,
      audio1,
      audio2,
    ],
  };
  return estado;
}

afterEach(() => {
  mocks.contextos.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("#3836 — áudio que chega DURANTE o turno", () => {
  it("(guarda da fixture) sem transcrição o prompt receberia o marcador [audio]", () => {
    // É ESTE o material que fazia o modelo responder "não consegui ouvir": sem
    // derivado, `corpoDaMensagem` compõe o marcador, e o prompt não tem o texto.
    const semDerivado: Linha = { ...audio(30_000, "audio-1") };
    expect(corpoDaMensagem(semDerivado)).toBe("[audio]");
    const comDerivado: Linha = { ...semDerivado, media_derived_text: TRANSCRICAO_1 };
    expect(corpoDaMensagem(comDerivado)).toContain(TRANSCRICAO_1);
  });

  it("o turno espera a derivação e o prompt leva a TRANSCRIÇÃO, nunca [audio]", async () => {
    const estado = estadoDoRelato();
    // A derivação "termina" depois de duas consultas: o histórico só pode ser
    // lido com o texto pronto.
    estado.linhas = () => {
      const pronta = estado.consultasDeMidia >= estado.prontaNaConsulta;
      return [
        texto("outbound", "Oi! Como posso ajudar?", -20_000),
        texto("inbound", "bom dia", 0),
        { ...audio(30_000, "audio-1"), media_derived_text: pronta ? TRANSCRICAO_1 : null },
        { ...audio(37_000, "audio-2"), media_derived_text: pronta ? TRANSCRICAO_2 : null },
      ];
    };
    const dormir = vi.fn(async () => {});

    await expect(turno(estado, logFalso(), dormir)).rejects.toThrow(/config LLM/);

    const ultima = ultimaInboundNoPrompt();
    expect(ultima.body).toContain(TRANSCRICAO_2);
    expect(ultima.body).not.toContain("[audio]");
    // E a espera ACONTECEU: sem consultar duas vezes, o histórico sairia antes
    // de a derivação terminar (é o defeito, e é o que este caso reprova).
    expect(estado.consultasDeMidia).toBeGreaterThanOrEqual(3);
    expect(dormir).toHaveBeenCalled();
  });

  it("o que chegou durante a espera fica coberto pela anotação — o job da mensagem nova não responde de novo", async () => {
    // A anotação `ultima_inbound_vista_em` é feita antes do turno. Os áudios que
    // chegaram durante a espera (até 120s) são lidos e respondidos por ESTE
    // turno; sem reanotar depois da espera, o job deles compara contra a
    // anotação velha (`ultimaInboundJaRespondida`) e responde uma segunda vez.
    const estado = estadoDoRelato();
    const dormir = vi.fn(async () => {});

    await expect(turno(estado, logFalso(), dormir)).rejects.toThrow(/config LLM/);

    const fim = estado.eventos.indexOf("midia-pronta");
    expect(fim, "a espera não terminou").toBeGreaterThan(-1);
    const depois = estado.eventos.slice(fim);
    expect(depois, "não reanotou depois da espera").toContain("anotou");
    // E reanotou ANTES de ler a conversa: a anotação nunca promete mais do que
    // o turno leu.
    expect(depois.indexOf("anotou")).toBeLessThan(depois.indexOf("leu"));
  });

  it("sem mídia pendente não há espera e nada é reanotado", async () => {
    const estado = estadoDoRelato();
    estado.prontaNaConsulta = 1;
    await expect(turno(estado, logFalso(), vi.fn(async () => {}))).rejects.toThrow(/config LLM/);
    expect(estado.eventos).not.toContain("anotou");
  });

  it("a espera estourou o teto: nada é reanotado — o job do áudio ainda responde por ele", async () => {
    // O áudio chegou durante a espera e não derivou a tempo: este turno o lê
    // como `[audio]`. Reanotar cobriria o áudio com essa resposta, e o job dele
    // seria pulado por `ultimaInboundJaRespondida` — a resposta à transcrição
    // nunca sairia.
    const estado = estadoDoRelato();
    estado.prontaNaConsulta = Number.POSITIVE_INFINITY;
    const dormir = vi.fn(async () => {});
    const log = logFalso();

    await expect(turno(estado, log, dormir)).rejects.toThrow(/config LLM/);

    expect(dormir).toHaveBeenCalled();
    expect(log.frases().some((f) => f.includes("não derivou dentro do teto da espera"))).toBe(true);
    expect(estado.eventos).not.toContain("anotou");
  });

  it("mídia travada além do teto: o turno segue EM TEMPO e o desfecho é nomeado", async () => {
    // Mídia que já passou do teto de espera na chegada: esperar por ela é
    // segurar o cliente por uma derivação que não é deste turno.
    const estado = estadoDoRelato();
    estado.prontaNaConsulta = Number.POSITIVE_INFINITY;
    estado.idadeDaMidiaMs = 600_000;
    const dormir = vi.fn(async () => {});
    const log = logFalso();
    const comecou = Date.now();

    await expect(turno(estado, log, dormir)).rejects.toThrow(/config LLM/);

    // Não dormiu nada: o turno terminou em tempo.
    expect(dormir).not.toHaveBeenCalled();
    expect(Date.now() - comecou).toBeLessThan(5_000);
    // E o desfecho não é silencioso: o log diz que a espera foi recusada.
    expect(log.frases().some((f) => f.includes("teto da espera"))).toBe(true);
    // O prompt segue com o marcador — a mídia NÃO está transcrita mesmo, e é
    // sobre isso que a resposta tem de ser honesta.
    expect(ultimaInboundNoPrompt().body).toBe("[audio]");
  });
});
