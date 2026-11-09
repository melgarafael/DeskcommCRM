/**
 * workers/voice-agent/audioSocketBridge.ts
 *
 * Ponte de áudio via Asterisk AudioSocket (TCP), não RTP/externalMedia.
 *
 * Por quê: testado ao vivo (madrugada de 28/08) — um único OU dois canais
 * externalMedia numa bridge ARI "mixing" recebem nosso áudio de volta
 * corretamente (confirmado por captura: payload real chega no Asterisk),
 * mas o Asterisk NUNCA relay isso pra ponta PJSIP — só manda silêncio
 * (0xff cru) pro trunk, em todas as variações tentadas (1 canal, 2 canais,
 * canais com portas únicas, marker bit RTP). É limitação conhecida do
 * chan_rtp/externalMedia + bridge de mixing do Asterisk pra esse padrão de
 * uso, não bug nosso — confirmado por pesquisa na comunidade Asterisk.
 *
 * AudioSocket evita o problema por completo: o Asterisk CONECTA em nós via
 * TCP simples (AudioSocket() no dialplan, não ARI/Stasis) e o áudio flui
 * DIRETO no path do canal, sem bridge-mixing nenhum no meio. Formato é
 * SLIN16 (PCM 16-bit, 8kHz) — convertido daqui pra μ-law e vice-versa
 * (lib/voip/ulaw.ts), porque a sessão OpenAI já está provada funcionando
 * com audio/pcmu.
 *
 * Framing (protocolo AudioSocket): 1 byte tipo + 2 bytes tamanho (BE) +
 * payload.
 *   0x01 UUID     — primeira mensagem, 16 bytes binários
 *   0x10 ÁUDIO     — PCM16 8kHz mono, tipicamente 320 bytes (20ms)
 *   0x00 HANGUP    — Asterisk avisando que a chamada terminou
 */

import WebSocket from "ws";
import type { Socket } from "node:net";
import { pcm16ToUlaw, ulawToPcm16 } from "@/lib/voip/ulaw";
import { somarUsoDaResposta, usoVazio, type UsoDaSessao } from "./uso-da-sessao";
import { esperaDaVez } from "./espera-da-vez";
// Só TIPO: a ponte não importa o módulo da agenda em runtime. Quem monta as
// cinco operações (com o handler de verdade) é o worker — ver
// `agenda-da-voz.ts` e o comentário de `AudioSocketCallContext.agenda`.
import type { AgendaDaVoz, PreparoDaVoz } from "./agenda-da-voz";

// Fallback só pra quem ainda não configurou nada na aba Voz do agente
// (config.voice_model) -- normalmente this.ctx.voiceModel já vem preenchido
// pelo worker, que lê do agente antes de instanciar esta classe.
// `??` NÃO serve aqui: o `.env.example` entrega `OPENAI_REALTIME_MODEL=` VAZIA,
// e quem copia o exemplo receberia a string vazia no lugar do padrão — o nome
// do modelo iria vazio para a API. Vazio (ou só espaço) conta como ausente,
// mesma regra de `graphVersion()` em lib/graph-version.ts.
const REALTIME_MODEL_FALLBACK = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

// Quanto esperar antes de responder (ver ./espera-da-vez.ts). Padrão "low".
const ESPERA_DA_VEZ = esperaDaVez(process.env.VOICE_VAD_EAGERNESS);

const FRAME_TYPE = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10 } as const;

/**
 * Sem isto a ligação só termina quando o CLIENTE desliga — a IA nunca
 * desliga sozinha, mesmo tendo se despedido (ouvido ao vivo: a chamada
 * ficava pendurada em silêncio até o cliente encerrar do lado dele). O
 * modelo chama esta function DEPOIS de dizer a despedida; o áudio da
 * resposta ainda é tocado até o fim — só então a ligação é encerrada (ver
 * `pumpOutboundQueue`, que drena a fila pendente antes de fechar o socket).
 */
const ENCERRAR_CHAMADA_TOOL_NAME = "encerrar_chamada";
const CONSULTAR_CONHECIMENTO_TOOL_NAME = "consultar_conhecimento";

/**
 * A AGENDA NA LIGAÇÃO (#4221) — os nomes são os que o modelo vê, e são de
 * propósito diferentes dos do MCP do texto (`crm_*`): quem atende ao telefone
 * não escolhe entre 40 ferramentas, escolhe entre cinco, e o nome tem de caber
 * na boca de quem fala. A escrita é em DOIS PASSOS (`preparar_` → `confirmar_`)
 * para que nada seja gravado antes de a pessoa ouvir o resumo e dizer sim.
 */
const LISTAR_TIPOS_TOOL_NAME = "listar_tipos_de_atendimento";
const ACHAR_HORARIO_TOOL_NAME = "achar_horario_livre";
const LISTAR_COMPROMISSOS_TOOL_NAME = "listar_compromissos";
const PREPARAR_AGENDAMENTO_TOOL_NAME = "preparar_agendamento";
const CONFIRMAR_AGENDAMENTO_TOOL_NAME = "confirmar_agendamento";

/** Nome de tool de agenda → true. Um só lugar para o despacho e o tools[]. */
const NOMES_DE_AGENDA: ReadonlySet<string> = new Set([
  LISTAR_TIPOS_TOOL_NAME,
  ACHAR_HORARIO_TOOL_NAME,
  LISTAR_COMPROMISSOS_TOOL_NAME,
  PREPARAR_AGENDAMENTO_TOOL_NAME,
  CONFIRMAR_AGENDAMENTO_TOOL_NAME,
]);


const INSTRUCAO_ENCERRAR_CHAMADA = `

Quando a conversa chegar a uma conclusão natural (o cliente se despediu, o
assunto foi resolvido, ou não há mais nada a tratar), diga a despedida em
voz e, na mesma resposta, chame a function "${ENCERRAR_CHAMADA_TOOL_NAME}"
para desligar a ligação. Não chame antes de terminar de falar a despedida.

Quando o cliente perguntar algo específico da empresa (preço, política,
horário, procedimento, catálogo) que você não tem certeza, chame a function
"${CONSULTAR_CONHECIMENTO_TOOL_NAME}" com a pergunta antes de responder — não
invente. Se a busca não achar nada, diga que vai verificar e retornar, não
afirme um fato sem fonte.`;

/**
 * Ligação RECEBIDA: quem atende fala primeiro. Sem isto a IA ficava calada até
 * ouvir voz — o semantic_vad só cria resposta quando detecta fala — e quem
 * ligava ouvia silêncio, achando que ninguém tinha atendido (medido ao vivo em
 * 03/11/2026: 36 s e 12 s de silêncio até o cliente falar "alô"). Na ligação
 * que NÓS fazemos é o contrário: quem atende diz "alô" e a IA responde a isso,
 * então a abertura não vale para a saída.
 */
const INSTRUCAO_FALA_PRIMEIRO = `

Esta é uma ligação que o cliente fez para a empresa, e você acabou de atender.
Fale primeiro, sem esperar o cliente: cumprimente e se apresente numa frase
curta, do jeito que suas instruções acima pedem, e pergunte como pode ajudar.`;

/**
 * A agenda, dita em voz. Entra na sessão SÓ quando o worker injeta
 * `ctx.agenda` — mesma disciplina do `consultar_conhecimento`, que só aparece
 * quando há acervo: ferramenta que não existe não é oferecida ao modelo.
 *
 * As três regras que não podem faltar: horário só vem da ferramenta (o modelo
 * da Realtime não sabe que dia é hoje), nada é dito como marcado antes de
 * `confirmar_agendamento` voltar com o horário, e o resumo do preparo é LIDO
 * em voz alta seguido da PERGUNTA — sem o sim da pessoa, não há escrita.
 */
const INSTRUCAO_AGENDA = `

Nesta ligação você também cuida da agenda da empresa. Antes de oferecer um
horário, chame "${ACHAR_HORARIO_TOOL_NAME}" — nunca ofereça horário que não
veio da ferramenta, e como você não sabe a data de hoje use o campo
dias_a_frente em vez de inventar datas. Para marcar, chame
"${PREPARAR_AGENDAMENTO_TOOL_NAME}" com o tipo e o horário combinados; ele
devolve um resumo curto com dia e hora. Leia esse resumo em voz alta e
PERGUNTE se pode confirmar. Só chame "${CONFIRMAR_AGENDAMENTO_TOOL_NAME}"
depois do sim da pessoa, passando o código que veio no preparo — não fale o
código em voz alta, ele é para a ferramenta. Nunca diga que está marcado antes
de a confirmação voltar com o horário. Se a confirmação for recusada, ofereça
os horários alternativos que ela trouxer e não repita o horário recusado. Se a
pessoa já tem compromisso e quer outro dia, chame o preparo com remarcar
ligado — é o MESMO compromisso mudando de hora.`;

/**
 * As cinco tools de agenda como a Realtime API as recebe.
 *
 * Os `parameters` são o contrato MÍNIMO da fala: tipo, dia, hora e o código do
 * preparo. Não há `organization_id`, `org_id` nem `supabase` aqui — e a ponte
 * também não lê esses campos dos argumentos (ver `handleAgendaCall`), porque a
 * organização é a da ligação. `dia` é opcional de propósito: o modelo não sabe
 * que dia é hoje, então o caminho normal é `dias_a_frente`.
 */
const AGENDA_TOOLS = [
  {
    type: "function" as const,
    name: LISTAR_TIPOS_TOOL_NAME,
    description:
      "Lista os tipos de atendimento que a empresa agenda, com a duração de cada um. Use antes de falar de horário.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: ACHAR_HORARIO_TOOL_NAME,
    description:
      "Mostra até três horários livres de um tipo de atendimento. Use ANTES de oferecer qualquer horário à pessoa.",
    parameters: {
      type: "object",
      properties: {
        tipo: { type: "string", description: "o tipo de atendimento, como voltou em listar_tipos_de_atendimento." },
        dias_a_frente: {
          type: "number",
          description: "quantos dias olhar a partir de hoje (padrão 7). Use quando não houver um dia certo.",
        },
        dia: { type: "string", description: "dia certo, em AAAA-MM-DD, só quando a pessoa nomear a data." },
      },
      required: ["tipo"],
    },
  },
  {
    type: "function" as const,
    name: LISTAR_COMPROMISSOS_TOOL_NAME,
    description:
      "Lista os compromissos que esta pessoa já tem marcados. Use antes de marcar de novo ou quando ela falar de um compromisso existente.",
    parameters: {
      type: "object",
      properties: {
        dia: { type: "string", description: "dia certo, em AAAA-MM-DD, só quando a pessoa nomear a data." },
      },
      required: [],
    },
  },
  {
    type: "function" as const,
    name: PREPARAR_AGENDAMENTO_TOOL_NAME,
    description:
      "Prepara a marcação (ou a remarcação) e devolve um resumo com dia e hora para você LER à pessoa e perguntar se pode confirmar. NÃO grava nada sozinho.",
    parameters: {
      type: "object",
      properties: {
        tipo: { type: "string", description: "o tipo de atendimento combinado." },
        hora: { type: "string", description: "a hora combinada, como 14:00." },
        dias_a_frente: { type: "number", description: "quantos dias olhar a partir de hoje (padrão 7)." },
        dia: { type: "string", description: "dia certo, em AAAA-MM-DD, só quando a pessoa nomear a data." },
        remarcar: { type: "boolean", description: "true quando a pessoa já tem compromisso e quer mudar o horário dele." },
      },
      required: ["tipo", "hora"],
    },
  },
  {
    type: "function" as const,
    name: CONFIRMAR_AGENDAMENTO_TOOL_NAME,
    description:
      "Confirma o que foi preparado e grava na agenda. Chame SÓ depois de a pessoa dizer sim, com o código que veio do preparo.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "o código devolvido por preparar_agendamento." },
      },
      required: ["id"],
    },
  },
] as const;

export interface AudioSocketCallContext {
  callId: string;
  organizationId: string;
  agentInstructions: string;
  /** Voz da Realtime API (marin, cedar, alloy, ...) -- configuravel por
   *  agente em Configuracoes > Agente > aba Voz. */
  voice: string;
  /** 0.25-1.5, 1.0 = padrao do modelo. */
  voiceSpeed: number;
  /** Modelo Realtime (gpt-realtime, gpt-realtime-2.1, ...) -- ver guardrails-schema.ts. */
  voiceModel?: string;
  /** Chave da OpenAI pra esta org -- ver resolverChaveOpenAiDaVoz em lib/ai/agents.ts. */
  apiKey?: string;
  onTranscriptTurn: (turn: { speaker: "agent" | "customer"; text: string }) => void;
  onCallEnded: () => void;
  /**
   * true na ligação RECEBIDA: a IA abre a conversa assim que a sessão fica
   * pronta (ver INSTRUCAO_FALA_PRIMEIRO). Ausente ou false: espera o cliente
   * falar, que é o certo na ligação que nós fazemos.
   */
  falaPrimeiro?: boolean;
  /**
   * Resolvida em PARALELO com a abertura deste WebSocket (index.ts dispara
   * os dois ao mesmo tempo, não aguarda uma coisa antes da outra) — o
   * session.update só é enviado depois que isto resolve, pra saber se
   * oferece a tool de RAG ao modelo. Antes disto rodava em série (aguardado
   * em index.ts antes até de abrir o WS), e a soma dos dois round-trips era
   * demora real sentida antes da primeira interação.
   */
  knowledgeSourceIdsPromise: Promise<string[]>;
  /**
   * Busca na base de conhecimento da org (mesmo acervo do agente de texto).
   * Sempre fornecida — quem decide OFERECER a tool ao modelo ou não é o
   * tools[] montado em setupRealtime a partir de knowledgeSourceIdsPromise,
   * não a presença desta função.
   */
  searchKnowledge: (pergunta: string) => Promise<{
    trechos: Array<{ content: string; source_name?: string | null }>;
  }>;
  /**
   * A AGENDA desta ligação (#4221) — injetada pelo worker, do mesmo jeito que
   * `searchKnowledge`. A ponte NÃO cria cliente Supabase nem conhece tabela:
   * ela só declara as cinco tools, guarda o preparo pendente da ligação e
   * devolve TEXTO curto para o modelo falar. Quem executa é o handler de
   * verdade da tool de texto, montado em `agenda-da-voz.ts` com a organização
   * e o contato DA LINHA — nunca com o que o modelo escreveu.
   *
   * Ausente = a agenda não é oferecida: as cinco tools não são declaradas e
   * `INSTRUCAO_AGENDA` não entra na sessão.
   */
  agenda?: AgendaDaVoz;
}

/**
 * Leitura dos argumentos da agenda — CAMPO A CAMPO, de propósito.
 *
 * O JSON vem do modelo; nada aqui repassa o objeto cru. Assim um
 * `organization_id` (ou `org_id`, ou `supabase`) que o modelo invente não
 * encontra caminho: a organização e o cliente da escrita são os da LIGAÇÃO.
 */
function lerTexto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

function lerDias(valor: unknown): number | undefined {
  const n = typeof valor === "number" ? valor : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  const inteiro = Math.trunc(n);
  return inteiro >= 1 ? inteiro : undefined;
}

/** Monta um frame AudioSocket (tipo + tamanho BE + payload). */
function buildFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header[0] = type;
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const FRAME_MS = 20;
const FRAME_BYTES = 320; // 20ms @ 8kHz, PCM16 mono

export class AudioSocketCallBridge {
  private realtimeWs: WebSocket;
  private recvBuffer = Buffer.alloc(0);
  private isTalkspurtStart = true;
  private closed = false;
  /** setado quando o modelo chama a function de encerrar — a fila de
   *  áudio pendente ainda drena normalmente antes do hangup de fato. */
  private endCallRequested = false;
  /** call_id -> nome da function, preenchido em response.output_item.added
   *  (onde o nome chega) e consumido em response.function_call_arguments.done
   *  (onde os argumentos chegam completos, mas sem o nome de novo). */
  private pendingFunctionCalls = new Map<string, string>();

  /**
   * O QUE FOI PREPARADO NESTA LIGAÇÃO (#4221), por código opaco.
   *
   * `preparar_agendamento` NÃO escreve: valida, lê a agenda e guarda aqui os
   * argumentos já resolvidos (o `starts_at` que veio da consulta, o
   * compromisso a mover). `confirmar_agendamento` só aceita um código que
   * esteja AQUI — código desconhecido não tem o que executar, então a escrita
   * nem é tentada (é o caso (c) dos testes). O mapa morre com a ligação: o
   * preparo de uma chamada nunca confirma em outra.
   */
  private agendaPendente = new Map<
    string,
    { operacao: PreparoDaVoz["operacao"]; args: Record<string, unknown> }
  >();
  /** Só o contador: o código é `prep-1`, `prep-2` — opaco, curto e nunca um UUID. */
  private agendaSeq = 0;

  /**
   * false até o session.update ser enviado com sucesso (ver setupRealtime,
   * evento "open"). Áudio do cliente que chega ANTES disso (handshake TLS +
   * round-trip de knowledgeSourceIdsPromise) ia direto pro método antigo, que
   * só mandava pra OpenAI se `readyState === OPEN` — e descartava em
   * silêncio o resto. Reportado ao vivo como "demora na primeira interação":
   * quem falava assim que a ligação atendia tinha a fala inicial jogada
   * fora. Agora esse áudio fica em `preOpenAudioBuffer` e é drenado assim
   * que a sessão fica pronta.
   */
  private realtimeReady = false;
  private preOpenAudioBuffer: Buffer[] = [];

  // Fila de PCM16 pendente pra mandar pro Asterisk + um pacer que dreia um
  // frame de 320 bytes a cada 20ms — SEM isto, "response.output_audio.delta"
  // chega em rajadas (a OpenAI gera mais rápido que tempo real) e escrever
  // tudo de uma vez no TCP faz o Asterisk tocar mais rápido que o normal.
  // Ouvido ao vivo: "conversa acelerada e picada". RTP não tem esse problema
  // porque carrega timestamp — jitter buffer do outro lado reconstrói o
  // tempo certo sozinho; AudioSocket é só bytes crus, o pacing é nosso.
  private outboundQueue = Buffer.alloc(0);
  private pacerTimer: NodeJS.Timeout | null = null;

  private readonly realtimeModel: string;

  /**
   * O uso medido da sessão, somado a cada `response.done` — vira a linha de
   * `llm_calls` no fim da ligação (`index.ts`, `finalizeAudioSocketCall`). Ver
   * `./uso-da-sessao.ts` para o que é medido e o que NÃO é (o preço).
   */
  private uso: UsoDaSessao = usoVazio();
  /** Handshake recusado pela OpenAI: a sessão nem abriu, e a linha sai como erro. */
  private erroDeAbertura: { message: string; status?: number } | null = null;

  /** O que a ligação consumiu até agora, e se a sessão falhou ao abrir. */
  usoDaSessao(): { modelo: string; uso: UsoDaSessao; erro: { message: string; status?: number } | null } {
    return { modelo: this.realtimeModel, uso: this.uso, erro: this.erroDeAbertura };
  }

  constructor(
    private socket: Socket,
    private ctx: AudioSocketCallContext,
  ) {
    this.realtimeModel = ctx.voiceModel ?? REALTIME_MODEL_FALLBACK;
    const apiKey = ctx.apiKey || process.env.OPENAI_API_KEY!;
    const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${this.realtimeModel}`;
    this.realtimeWs = new WebSocket(realtimeUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // Sem isto o algoritmo de Nagle empaca nossos writes pequenos e
    // frequentes (frames de 323 bytes a cada 20ms) esperando encher um
    // buffer maior antes de mandar — ouvido ao vivo como áudio picado
    // mesmo com os frames certos chegando no Asterisk.
    this.socket.setNoDelay(true);

    this.setupSocket();
    this.setupRealtime();

    this.pacerTimer = setInterval(() => this.pumpOutboundQueue(), FRAME_MS);
  }

  /** Roda a cada 20ms — manda NO MÁXIMO um frame por tick, nunca a fila inteira de uma vez. */
  private pumpOutboundQueue() {
    if (this.socket.destroyed) return;

    if (this.outboundQueue.length >= FRAME_BYTES) {
      const frame = this.outboundQueue.subarray(0, FRAME_BYTES);
      this.outboundQueue = this.outboundQueue.subarray(FRAME_BYTES);
      this.socket.write(buildFrame(FRAME_TYPE.AUDIO, frame));
      this.isTalkspurtStart = false;
      return;
    }

    // Sem áudio cheio de 320 bytes pendente: só encerra se o modelo já
    // pediu (endCallRequested) — a despedida some do meio da frase se a
    // gente fechar sem antes drenar o restinho que sobrou (< 1 frame).
    if (!this.endCallRequested) return;
    if (this.outboundQueue.length > 0) {
      this.socket.write(buildFrame(FRAME_TYPE.AUDIO, this.outboundQueue));
      this.outboundQueue = Buffer.alloc(0);
      return; // mais um tick de 20ms pro Asterisk tocar isto antes do hangup
    }
    this.handleEnd("ia encerrou a chamada");
  }

  private setupSocket() {
    this.socket.on("data", (chunk) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
      this.drainFrames();
    });
    this.socket.on("close", () => this.handleEnd("socket fechado"));
    this.socket.on("error", (err) => console.error(`[audiosocket] call=${this.ctx.callId} erro no socket:`, err.message));
  }

  /** Consome quantos frames completos já estiverem no buffer acumulado. */
  private drainFrames() {
    while (this.recvBuffer.length >= 3) {
      const type = this.recvBuffer[0];
      const len = this.recvBuffer.readUInt16BE(1);
      if (this.recvBuffer.length < 3 + len) return; // frame incompleto, espera mais dados

      const payload = this.recvBuffer.subarray(3, 3 + len);
      this.recvBuffer = this.recvBuffer.subarray(3 + len);

      if (type === FRAME_TYPE.AUDIO) {
        this.sendAudioToRealtime(pcm16ToUlaw(payload));
      } else if (type === FRAME_TYPE.HANGUP) {
        this.handleEnd("hangup frame");
      }
      // UUID (0x01) já foi consumido por quem aceitou a conexão, antes de
      // instanciar esta classe — DTMF (0x03) ignorado, sem uso ainda.
    }
  }

  private handleEnd(reason: string) {
    if (this.closed) return;
    this.closed = true;
    console.info(`[audiosocket] call=${this.ctx.callId} encerrando (${reason})`);
    this.ctx.onCallEnded();
    this.close();
  }

  private setupRealtime() {
    this.realtimeWs.on("open", async () => {
      // Roda em paralelo com o handshake deste WS (index.ts dispara os dois
      // ao mesmo tempo) — só espera aqui, no momento em que já precisamos
      // saber se oferece a tool de RAG ou não.
      const knowledgeSourceIds = await this.ctx.knowledgeSourceIdsPromise;

      console.info(`[realtime] call=${this.ctx.callId} websocket aberto, enviando session.update`);
      this.realtimeWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: this.realtimeModel,
            output_modalities: ["audio"],
            instructions:
              this.ctx.agentInstructions +
              INSTRUCAO_ENCERRAR_CHAMADA +
              (this.ctx.agenda ? INSTRUCAO_AGENDA : "") +
              (this.ctx.falaPrimeiro ? INSTRUCAO_FALA_PRIMEIRO : ""),
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                // server_vad com threshold alto ainda disparava com ruído de
                // linha/eco de viva-voz -- ele julga só volume, sem saber se o
                // som é fala de verdade. semantic_vad usa um classificador que
                // avalia o CONTEÚDO (é fala? faz sentido como turno
                // terminado?), não só amplitude -- muito mais resistente a
                // ruído/eco. eagerness padrão "low": espera mais confiança antes
                // de considerar que a pessoa terminou de falar, custa latência
                // (pode passar de segundos) mas evita a IA emendar resposta em
                // cima de nada. Linha limpa: VOICE_VAD_EAGERNESS=auto.
                turn_detection: { type: "semantic_vad", eagerness: ESPERA_DA_VEZ },
                // Sem `language`, o Whisper detecta automaticamente a cada
                // trecho -- e erra de vez em quando (ruído de linha, palavra
                // ambígua), transcrevendo em outro idioma no meio da
                // ligação. Forçar "pt" corta a detecção errada de vez.
                transcription: { model: "whisper-1", language: "pt" },
              },
              output: {
                format: { type: "audio/pcmu" },
                // Configuráveis por agente (Configurações > Agente > aba
                // Voz) -- default "marin"/0.85, ver AGENT_CONFIG_DEFAULTS.
                voice: this.ctx.voice,
                speed: this.ctx.voiceSpeed,
              },
            },
            tools: [
              {
                type: "function",
                name: ENCERRAR_CHAMADA_TOOL_NAME,
                description:
                  "Encerra a ligação. Use depois de dizer a despedida final ao cliente, quando a conversa chegou a uma conclusão natural.",
                parameters: { type: "object", properties: {}, required: [] },
              },
              ...(knowledgeSourceIds.length > 0
                ? [
                    {
                      type: "function" as const,
                      name: CONSULTAR_CONHECIMENTO_TOOL_NAME,
                      description:
                        "Busca na base de conhecimento da empresa (documentos, FAQ, políticas, catálogo) por uma pergunta específica do cliente. Use antes de responder algo que dependa de informação da empresa que você não tem certeza.",
                      parameters: {
                        type: "object",
                        properties: {
                          pergunta: {
                            type: "string",
                            description: "A pergunta ou tópico a buscar na base de conhecimento.",
                          },
                        },
                        required: ["pergunta"],
                      },
                    },
                  ]
                : []),
              // Agenda: declarada SÓ com `ctx.agenda` (ver INSTRUCAO_AGENDA).
              ...(this.ctx.agenda ? AGENDA_TOOLS : []),
            ],
            tool_choice: "auto",
          },
        }),
      );

      // Ligação recebida: a IA abre a conversa. Vai ANTES de drenar o áudio
      // acumulado — se a fala do cliente fosse primeiro, o VAD poderia criar
      // uma resposta ao mesmo tempo que esta, e a API recusa a segunda
      // ("conversation_already_has_active_response"). Se o cliente falar por
      // cima da saudação, o semantic_vad a interrompe, como em qualquer turno.
      if (this.ctx.falaPrimeiro) {
        console.info(`[realtime] call=${this.ctx.callId} ligação recebida: IA abre a conversa`);
        this.realtimeWs.send(JSON.stringify({ type: "response.create" }));
      }

      // Sessão configurada — agora sim dá pra mandar áudio pra API. Drena o
      // que ficou acumulado em preOpenAudioBuffer enquanto o WS ainda abria
      // (ver comentário do campo).
      this.realtimeReady = true;
      for (const chunk of this.preOpenAudioBuffer) {
        this.realtimeWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
      }
      this.preOpenAudioBuffer = [];
    });

    this.realtimeWs.on("message", (raw) => {
      const event = JSON.parse(raw.toString());

      if (event.type !== "response.output_audio.delta") {
        console.info(`[realtime] call=${this.ctx.callId} evento: ${event.type}`);
      }

      switch (event.type) {
        case "response.created":
          this.isTalkspurtStart = true;
          break;
        case "response.output_audio.delta":
          this.sendAudioToAsterisk(Buffer.from(event.delta, "base64"));
          break;
        case "response.output_audio_transcript.done": {
          // Visto ao vivo em 17/09: o modelo às vezes NARRA a function em vez
          // de chamá-la de verdade -- duas variações JÁ vistas na mesma
          // sessão de testes: "...Até mais! \n\n(functions.encerrar_chamada)"
          // e "...\n\n{chamar função: encerrar_chamada}" -- sem nenhum
          // response.function_call_arguments.done correspondente em nenhuma
          // das duas. Não é um formato fixo (parênteses/chaves, inglês/
          // português variam), então a detecção é só pelo NOME da tool
          // aparecer no texto -- um identificador técnico que não ocorre em
          // fala natural -- em vez de casar uma sintaxe específica. Sem isto
          // a ligação nunca desliga sozinha nesses casos: response.done
          // (abaixo) só vê function_call de verdade quando o mecanismo
          // estruturado da Realtime API é usado, que aqui não aconteceu.
          const narracaoDeEncerrar = new RegExp(ENCERRAR_CHAMADA_TOOL_NAME, "i").test(event.transcript);
          if (narracaoDeEncerrar) {
            console.info(`[realtime] call=${this.ctx.callId} modelo narrou a function de encerrar em texto (fallback ativado)`);
            this.endCallRequested = true;
          }
          // A limpeza tira qualquer trecho entre parênteses/chaves que
          // mencione a tool, mais a forma solta sem wrapper nenhum -- não dá
          // pra saber de antemão qual sintaxe o modelo vai improvisar.
          const transcriptLimpo = event.transcript
            .replace(new RegExp(`[\\(\\{][^)}]*${ENCERRAR_CHAMADA_TOOL_NAME}[^)}]*[\\)\\}]`, "gi"), "")
            .replace(new RegExp(`functions?\\.${ENCERRAR_CHAMADA_TOOL_NAME}`, "gi"), "")
            .trim();
          this.ctx.onTranscriptTurn({ speaker: "agent", text: transcriptLimpo });
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          this.ctx.onTranscriptTurn({ speaker: "customer", text: event.transcript });
          break;
        case "response.output_item.added": {
          const item = event.item as { type?: string; call_id?: string; name?: string } | undefined;
          if (item?.type === "function_call" && item.call_id && item.name) {
            this.pendingFunctionCalls.set(item.call_id, item.name);
          }
          break;
        }
        case "response.function_call_arguments.done": {
          const nome = this.pendingFunctionCalls.get(event.call_id);
          this.pendingFunctionCalls.delete(event.call_id);
          if (nome === CONSULTAR_CONHECIMENTO_TOOL_NAME) {
            void this.handleKnowledgeQuery(event.call_id, event.arguments);
          } else if (nome !== undefined && NOMES_DE_AGENDA.has(nome)) {
            void this.handleAgendaCall(nome, event.call_id, event.arguments);
          }
          break;
        }
        case "response.done": {
          this.uso = somarUsoDaResposta(this.uso, event.response?.usage);
          const output = (event.response?.output ?? []) as Array<{ type?: string; name?: string }>;
          const pediuEncerrar = output.some(
            (item) => item.type === "function_call" && item.name === ENCERRAR_CHAMADA_TOOL_NAME,
          );
          if (pediuEncerrar) {
            console.info(`[realtime] call=${this.ctx.callId} agente pediu pra encerrar a chamada`);
            this.endCallRequested = true;
          }
          break;
        }
        case "error":
          console.error(`[realtime] call=${this.ctx.callId} erro:`, JSON.stringify(event.error));
          break;
      }
    });

    this.realtimeWs.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        this.erroDeAbertura = {
          message: `handshake rejeitado: ${body}`.slice(0, 500),
          ...(typeof res.statusCode === "number" ? { status: res.statusCode } : {}),
        };
        console.error(`[realtime] call=${this.ctx.callId} handshake rejeitado, HTTP ${res.statusCode}: ${body}`);
      });
    });

    this.realtimeWs.on("close", (code, reason) => {
      console.info(`[realtime] call=${this.ctx.callId} ws fechado, code=${code} reason=${reason}`);
      this.handleEnd("openai ws fechado");
    });
  }

  private sendAudioToRealtime(ulawChunk: Buffer) {
    if (!this.realtimeReady) {
      this.preOpenAudioBuffer.push(ulawChunk);
      return;
    }
    if (this.realtimeWs.readyState !== WebSocket.OPEN) return;
    this.realtimeWs.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: ulawChunk.toString("base64") }),
    );
  }

  /**
   * Roda a busca, devolve o resultado como function_call_output e pede uma
   * NOVA resposta (response.create) pro modelo continuar falando com a
   * informação em mãos — sem isto o turno fica parado esperando algo que
   * nunca chega, porque o resultado da function sozinho não dispara resposta.
   */
  private async handleKnowledgeQuery(callId: string, argsJson: string) {
    let pergunta = "";
    try {
      pergunta = (JSON.parse(argsJson) as { pergunta?: string }).pergunta ?? "";
    } catch {
      // argumentos malformados -- segue com pergunta vazia, cai no "nada encontrado" abaixo
    }

    let output: string;
    try {
      const resultado = pergunta.trim() === "" ? { trechos: [] } : await this.ctx.searchKnowledge(pergunta);
      output =
        resultado.trechos.length > 0
          ? resultado.trechos.map((t) => `[${t.source_name ?? "material"}] ${t.content}`).join("\n\n")
          : "Nada encontrado na base de conhecimento para esta pergunta -- responda com o que você já sabe e não invente fatos.";
    } catch (err) {
      console.error(
        `[realtime] call=${this.ctx.callId} busca de conhecimento falhou:`,
        err instanceof Error ? err.message : err,
      );
      output = "A base de conhecimento está indisponível agora -- responda com o que você já sabe e não invente fatos.";
    }

    this.responderFunctionCall(callId, output);
  }

  /**
   * Devolve o resultado de QUALQUER function call e pede a resposta seguinte.
   *
   * É o mesmo par que `handleKnowledgeQuery` já fazia (function_call_output +
   * response.create) — sem o `response.create` o turno fica parado esperando
   * algo que nunca chega, porque o resultado da function sozinho não dispara
   * resposta.
   */
  private responderFunctionCall(callId: string, output: string) {
    if (this.realtimeWs.readyState !== WebSocket.OPEN) return;
    this.realtimeWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
    this.realtimeWs.send(JSON.stringify({ type: "response.create" }));
  }

  /**
   * As cinco tools de agenda (#4221).
   *
   * O que sai daqui para o modelo é TEXTO curto — nunca `JSON.stringify` e
   * nunca um UUID: o modelo lê o texto, e o que ele lê ele pode falar. O
   * código do preparo (`prep-1`) é a ÚNICA coisa técnica que atravessa a
   * fronteira, e a instrução manda não dizê-lo em voz alta; o que ele
   * identifica fica no mapa desta ligação, não na conversa.
   *
   * ⚠️ Argumentos vindos do modelo são LIDOS CAMPO A CAMPO (`lerTexto`,
   * `lerDias`). Nada de espalhar o objeto cru: um `organization_id` enviado
   * junto não é encaminhado a lugar nenhum — a organização é sempre a de
   * `this.ctx`, que vem da linha de `voice_calls`.
   */
  private async handleAgendaCall(nome: string, callId: string, argsJson: string) {
    const agenda = this.ctx.agenda;
    if (!agenda) return;

    let args: Record<string, unknown> = {};
    try {
      const bruto = JSON.parse(argsJson) as unknown;
      if (bruto !== null && typeof bruto === "object") args = bruto as Record<string, unknown>;
    } catch {
      // argumentos malformados: cada branch trata o que falta como vazio
    }

    let output: string;
    try {
      output = await this.executarAgenda(agenda, nome, args);
    } catch (err) {
      console.error(
        `[realtime] call=${this.ctx.callId} agenda (${nome}) falhou:`,
        err instanceof Error ? err.message : err,
      );
      output =
        "A agenda não respondeu agora. Diga que vai verificar e peça para a pessoa aguardar um instante.";
    }
    this.responderFunctionCall(callId, output);
  }

  /** Despacho de UMA tool de agenda → o texto que o modelo fala em seguida. */
  private async executarAgenda(
    agenda: AgendaDaVoz,
    nome: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const tipo = lerTexto(args.tipo);
    const dia = lerTexto(args.dia);
    const diasAFrente = lerDias(args.dias_a_frente);

    switch (nome) {
      case LISTAR_TIPOS_TOOL_NAME:
        return agenda.listarTipos();

      case ACHAR_HORARIO_TOOL_NAME:
        return agenda.horariosLivres({
          tipo,
          ...(dia !== "" ? { dia } : {}),
          ...(diasAFrente !== undefined ? { dias_a_frente: diasAFrente } : {}),
        });

      case LISTAR_COMPROMISSOS_TOOL_NAME:
        return agenda.listarCompromissos({ ...(dia !== "" ? { dia } : {}) });

      case PREPARAR_AGENDAMENTO_TOOL_NAME: {
        const preparo = await agenda.preparar({
          tipo,
          hora: lerTexto(args.hora),
          ...(dia !== "" ? { dia } : {}),
          ...(diasAFrente !== undefined ? { dias_a_frente: diasAFrente } : {}),
          ...(args.remarcar === true ? { remarcar: true } : {}),
        });
        if ("recusa" in preparo) return preparo.recusa;

        const id = `prep-${++this.agendaSeq}`;
        this.agendaPendente.set(id, { operacao: preparo.operacao, args: preparo.args });
        return (
          `${preparo.resumo} ` +
          `Leia isso à pessoa e pergunte se pode confirmar; se ela disser sim, chame "${CONFIRMAR_AGENDAMENTO_TOOL_NAME}" ` +
          `com o código ${id} — não diga o código em voz alta.`
        );
      }

      case CONFIRMAR_AGENDAMENTO_TOOL_NAME: {
        const id = lerTexto(args.id);
        const pendente = this.agendaPendente.get(id);
        if (!pendente) {
          // Código desconhecido (inventado, de outra ligação ou já usado):
          // NADA é escrito. Uma preparação = uma confirmação: o código sai do
          // mapa ANTES da escrita, então repetir a chamada não marca duas vezes.
          return "Não tenho nada preparado com esse código, e nada foi marcado. Posso olhar os horários de novo.";
        }
        this.agendaPendente.delete(id);
        return agenda.executar(pendente.operacao, pendente.args);
      }

      default:
        return "Não consegui usar a agenda agora. Diga que vai verificar.";
    }
  }

  private outboundFramesLogged = false;

  /** NÃO escreve direto — só enfileira. Quem escreve é o pacer (pumpOutboundQueue), um frame por tick de 20ms. */
  private sendAudioToAsterisk(ulawChunk: Buffer) {
    if (!this.outboundFramesLogged) {
      this.outboundFramesLogged = true;
      console.info(`[audiosocket] call=${this.ctx.callId} primeiro trecho de resposta enfileirado (pacing a 20ms/frame)`);
    }
    this.outboundQueue = Buffer.concat([this.outboundQueue, ulawToPcm16(ulawChunk)]);
  }

  close() {
    if (this.pacerTimer) clearInterval(this.pacerTimer);
    // O preparo morre com a ligação: código de uma chamada nunca confirma em outra.
    this.agendaPendente.clear();
    this.realtimeWs.close();
    if (!this.socket.destroyed) this.socket.end();
  }
}
