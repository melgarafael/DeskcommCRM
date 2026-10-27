/**
 * O FLUXO QUE UMA EXTENSÃO DECLARA PARA AGIR DENTRO DA CONVERSA (#3076, item 5 da
 * issue, especificado em `docs/specs/extensoes-declarativas-v1.md`).
 *
 * ─── Por que um vocabulário, e não código ──────────────────────────────────
 *
 * Pacote é declarativo: sem JavaScript, sem SQL, sem acesso ao banco. O fluxo de
 * laudo do #3063 (#2885, parte 2) pergunta o tipo de exame e coleta nome, data e
 * médico — uma pergunta por vez — e depois passa para um humano. Esse
 * comportamento não pode morar no núcleo (doc 139: fluxo de um cliente vira
 * extensão), e uma extensão não pode executar código. Então ela DECLARA o fluxo
 * num vocabulário fechado — gatilhos, perguntas, campos, textos por idioma,
 * desfecho — e o HOST executa. Este arquivo é o vocabulário e a decisão pura: ele
 * não fala com banco, canal, logger nem relógio.
 *
 * ─── As quatro saídas possíveis de UMA mensagem ────────────────────────────
 *
 *   `devolver`   — não é comigo: o turno segue exatamente como hoje (IA responde).
 *   `perguntar`  — assumo: o host manda `texto`, e a IA não roda neste turno.
 *   `concluir`   — terminei o que tinha a perguntar: o host manda `texto` e a conversa volta
 *                  para a IA no turno seguinte. Exige a permissão `turn.send` e NÃO passa a
 *                  conversa para ninguém.
 *   `passar`     — passo para humano: a passagem leva os campos coletados. Exige `turn.send`
 *                  e `turn.handoff`.
 *
 * As duas últimas não são sinônimos, e é por isso que o vocabulário tem as duas: um fluxo que
 * só coleta e encerra não pede o direito de entregar a conversa a uma pessoa. A permissão
 * exigida é DERIVADA do desfecho (`lib/extensions/consentimento.ts`), nunca declarada pelo
 * pacote — dois lugares dizendo a mesma coisa divergem no primeiro dia em que um deles muda.
 *
 * Toda mensagem tem UMA saída. É o item 3 da issue, e a razão é medida: no #3063
 * uma pergunta se repetia sem saída. Aqui não existe caminho que não devolva,
 * pergunte ou passe — o teto de turnos sem progresso (`sem_progresso`) e a
 * mensagem fora do fluxo ("obrigado", "quanto custa?", "abrem sábado?") existem
 * para que o estado nunca fique preso.
 *
 * ─── Idioma: declarado, e o gatilho é estreito (item 5) ────────────────────
 *
 * O consumidor real fala inglês e híndi. O manifesto aceitava só `pt-BR` e `es`
 * — nota do mantenedor no #3076 —, e por isso os TEXTOS aqui têm vocabulário
 * próprio (`IDIOMAS_DO_TURNO`), com `pt-BR` obrigatório como recuo. Mensagem em
 * idioma fora da lista declarada vai para a IA: a extensão não tenta adivinhar.
 *
 * O gatilho carrega o IDIOMA junto (`{ idioma, texto }`). Sem isso, "report"
 * casaria dentro de uma frase em português — o defeito que a nota do mantenedor
 * pediu para não repetir. Três cercas, todas medidas por teste:
 *   1. o idioma DETECTADO da mensagem tem de ser igual ao do gatilho;
 *   2. o gatilho casa como FRASE (tokens contíguos), nunca como pedaço de palavra;
 *   3. a mensagem-gatilho é curta (`mensagemDoGatilho` tokens): uma frase longa
 *      que contém a palavra é conversa, não um pedido de fluxo.
 */
import { z } from "zod";

/**
 * Os idiomas que um fluxo pode cobrir. Lista FECHADA e espelha o que o produto
 * sabe detectar (`idiomaDaMensagem` abaixo): incluir um idioma aqui sem detector
 * faria o fluxo nunca disparar naquele idioma, o que é pior que recusar o pacote.
 */
export const IDIOMAS_DO_TURNO = ["pt-BR", "es", "en", "hi", "hi-Latn"] as const;
export type IdiomaDoTurno = (typeof IDIOMAS_DO_TURNO)[number];

/** O idioma do recuo: todo texto do fluxo tem `pt-BR`, e a instalação fala pt-BR. */
export const IDIOMA_DE_RECUO = "pt-BR" as const satisfies IdiomaDoTurno;

export const LIMITES_DO_FLUXO = {
  /** Gatilhos por fluxo. Acima disso o pacote está tentando cobrir conversa inteira. */
  gatilhos: 8,
  gatilhoCharacters: 60,
  /** Perguntas por turno de coleta — o fluxo do #3063 tem quatro. */
  perguntas: 6,
  perguntaCharacters: 300,
  /** Tokens de uma mensagem para ela valer como GATILHO (cerca 3 do cabeçalho). */
  mensagemDoGatilho: 12,
  /** Tokens de uma RESPOSTA aceita como valor de campo. */
  respostaDoCampo: 12,
  respostaCharacters: 120,
  /** Turnos seguidos sem progresso antes de escalar (item 3). */
  tetoDeTurnosSemProgresso: 5,
} as const;

/** Textos localizados do FLUXO: `pt-BR` obrigatório, um opcional por idioma coberto. */
export type TextoDoFluxo = {
  "pt-BR": string;
  es?: string;
  en?: string;
  hi?: string;
  "hi-Latn"?: string;
};

export interface CondicaoDeOpcao {
  campo: string;
  valores: string[];
}

export interface PerguntaDoFluxoDeclarado {
  /** O nome do campo que vai para a passagem (`camposColetados`). */
  campo: string;
  texto: TextoDoFluxo;
  /** Escolha finita; termos são frases literais, nunca expressão ou código. */
  opcoes?: Array<{ valor: string; termos: string[] }>;
  /** Só compara com uma escolha declarada ANTES desta pergunta. */
  quando?: CondicaoDeOpcao;
  extrair?: { tipo: "data" } | { tipo: "marcador"; termos: string[]; incluir_marcador?: boolean };
}

export interface GatilhoDoFluxo {
  idioma: IdiomaDoTurno;
  texto: string;
  /** Coocorrência literal que estreita a intenção sem expressão do pacote. */
  com_um_de?: string[];
}

/**
 * O que acontece quando não há mais pergunta.
 *
 * `assumir` — a extensão encerra a coleta e se despede: `texto` sai como bolha e o turno
 *             seguinte é da IA. Usa `turn.respond`.
 * `passar_para_humano` — a coleta vai para uma pessoa: `aviso` sai como bolha e a passagem
 *             leva os campos. Usa `turn.respond` e `turn.handoff`.
 */
export type DesfechoDoFluxo =
  | { tipo: "assumir"; texto: TextoDoFluxo }
  | { tipo: "passar_para_humano"; aviso: TextoDoFluxo };

export interface FluxoDoTurno {
  id: string;
  /** Os idiomas que o pacote COBRE. Mensagem fora desta lista vai para a IA. */
  idiomas: IdiomaDoTurno[];
  gatilhos: GatilhoDoFluxo[];
  perguntas: PerguntaDoFluxoDeclarado[];
  desfecho: DesfechoDoFluxo;
  /** Ausente = `LIMITES_DO_FLUXO.tetoDeTurnosSemProgresso`. */
  teto_de_turnos_sem_progresso?: number;
  /** Uma escolha pode levar direto ao mesmo desfecho, sem coletar os outros campos. */
  encerrar_quando?: CondicaoDeOpcao;
  /** O host resolve somente uma opção; nunca entrega histórico bruto ao pacote. */
  contexto?: { campo: string; marcadores: string[]; padrao: string };

}

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(2)
  .max(64);

function textoSchema(maxCharacters: number) {
  return z
    .string()
    .refine((texto) => texto.trim().length > 0 && [...texto].length <= maxCharacters, {
      message: `texto vazio ou acima de ${maxCharacters} caracteres`,
    });
}

/** Textos do fluxo: mesmas chaves do `TextoDoFluxo`, todas opcionais menos pt-BR. */
function textoDoFluxoSchema(maxCharacters: number) {
  const texto = textoSchema(maxCharacters);
  return z
    .object({
      "pt-BR": texto,
      es: texto.optional(),
      en: texto.optional(),
      hi: texto.optional(),
      "hi-Latn": texto.optional(),
    })
    .strict();
}

function temTextoEm(texto: TextoDoFluxo, idioma: IdiomaDoTurno): boolean {
  return typeof texto[idioma] === "string" && texto[idioma]!.trim() !== "";
}

const termosLiteraisSchema = z.array(textoSchema(LIMITES_DO_FLUXO.gatilhoCharacters)).min(1).max(32);
const condicaoDeOpcaoSchema = z.object({ campo: slugSchema, valores: z.array(slugSchema).min(1).max(8) }).strict();

export const fluxoDoTurnoSchema = z
  .object({
    id: slugSchema,
    idiomas: z
      .array(z.enum(IDIOMAS_DO_TURNO))
      .min(1)
      .max(IDIOMAS_DO_TURNO.length)
      .refine((lista) => new Set(lista).size === lista.length, { message: "idioma repetido" })
      // O recuo é pt-BR: um fluxo sem ele não teria para onde cair quando o
      // idioma da conversa não fosse detectado.
      .refine((lista) => lista.includes(IDIOMA_DE_RECUO), {
        message: "o fluxo precisa cobrir pt-BR (idioma de recuo)",
      }),
    gatilhos: z
      .array(
        z
          .object({
            idioma: z.enum(IDIOMAS_DO_TURNO),
            com_um_de: termosLiteraisSchema.optional(),
            texto: z
              .string()
              .refine((texto) => texto.trim().length > 0 && [...texto].length <= LIMITES_DO_FLUXO.gatilhoCharacters, {
                message: "gatilho vazio ou longo demais",
              }),
          })
          .strict(),
      )
      .min(1)
      .max(LIMITES_DO_FLUXO.gatilhos),
    perguntas: z
      .array(
        z
          .object({
            campo: slugSchema,
            texto: textoDoFluxoSchema(LIMITES_DO_FLUXO.perguntaCharacters),
            opcoes: z.array(z.object({ valor: slugSchema, termos: termosLiteraisSchema }).strict()).min(1).max(8).optional(),
            quando: condicaoDeOpcaoSchema.optional(),
            extrair: z.discriminatedUnion("tipo", [
              z.object({ tipo: z.literal("data") }).strict(),
              z.object({ tipo: z.literal("marcador"), termos: termosLiteraisSchema, incluir_marcador: z.boolean().optional() }).strict(),
            ]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(LIMITES_DO_FLUXO.perguntas)
      .refine((perguntas) => new Set(perguntas.map((p) => p.campo)).size === perguntas.length, {
        message: "campo repetido",
      }),
    // Os dois desfechos, cada um com o SEU texto: `assumir` se despede com uma frase,
    // `passar_para_humano` avisa antes de a passagem acontecer. Um campo só, com nome genérico,
    // faria o pacote escolher entre duas leituras — e o cliente receberia o texto errado.
    desfecho: z.discriminatedUnion("tipo", [
      z
        .object({
          tipo: z.literal("assumir"),
          texto: textoDoFluxoSchema(LIMITES_DO_FLUXO.perguntaCharacters),
        })
        .strict(),
      z
        .object({
          tipo: z.literal("passar_para_humano"),
          aviso: textoDoFluxoSchema(LIMITES_DO_FLUXO.perguntaCharacters),
        })
        .strict(),
    ]),
    encerrar_quando: condicaoDeOpcaoSchema.optional(),
    contexto: z.object({ campo: slugSchema, marcadores: termosLiteraisSchema, padrao: slugSchema }).strict().optional(),
    teto_de_turnos_sem_progresso: z
      .number()
      .int()
      .min(1)
      .max(LIMITES_DO_FLUXO.tetoDeTurnosSemProgresso)
      .optional(),
  })
  .strict()
  // Todo idioma DECLARADO tem de ter texto em toda pergunta e no aviso. Declarar
  // cobertura e não trazer o texto faria o host escolher um idioma e não ter o
  // que dizer — o cliente receberia uma bolha vazia, que é pior que a IA.
  .superRefine((fluxo, ctx) => {
    const textoDoDesfecho: [string, TextoDoFluxo] =
      fluxo.desfecho.tipo === "assumir"
        ? ["desfecho.texto", fluxo.desfecho.texto]
        : ["desfecho.aviso", fluxo.desfecho.aviso];
    const textos: Array<[string, TextoDoFluxo]> = [
      ...fluxo.perguntas.map((p): [string, TextoDoFluxo] => [`pergunta ${p.campo}`, p.texto]),
      textoDoDesfecho,
    ];
    for (const idioma of fluxo.idiomas) {
      for (const [nome, texto] of textos) {
        if (!temTextoEm(texto, idioma)) {
          ctx.addIssue({
            code: "custom",
            message: `${nome} sem texto em ${idioma}, que o fluxo declara cobrir`,
          });
        }
      }
    }
    // Só uma comparação de escolha anterior: sem referências futuras, ciclo ou expressão.
    const escolhas = new Map<string, Set<string>>();
    const validarCondicao = (condicao: CondicaoDeOpcao | undefined) => {
      if (condicao !== undefined && condicao.valores.some((valor) => !escolhas.get(condicao.campo)?.has(valor))) {
        ctx.addIssue({ code: "custom", message: "condição exige opção anterior declarada" });
      }
    };
    for (const pergunta of fluxo.perguntas) {
      validarCondicao(pergunta.quando);
      if (pergunta.opcoes !== undefined) {
        const valores = new Set(pergunta.opcoes.map((opcao) => opcao.valor));
        if (valores.size !== pergunta.opcoes.length || pergunta.extrair !== undefined) {
          ctx.addIssue({ code: "custom", message: "escolha repetida ou com extrator incompatível" });
        }
        escolhas.set(pergunta.campo, valores);
      }
    }
    validarCondicao(fluxo.encerrar_quando);
    if (fluxo.contexto !== undefined && !escolhas.get(fluxo.contexto.campo)?.has(fluxo.contexto.padrao)) {
      ctx.addIssue({ code: "custom", message: "contexto só resolve opção declarada" });
    }
    // Gatilho em idioma que o fluxo não cobre é gatilho que nunca pode disparar
    // (mensagem naquele idioma já vai para a IA). Recusar aqui evita um pacote
    // que "parece" cobrir inglês e não cobre.
    for (const gatilho of fluxo.gatilhos) {
      if (!fluxo.idiomas.includes(gatilho.idioma)) {
        ctx.addIssue({
          code: "custom",
          message: `gatilho em ${gatilho.idioma} fora dos idiomas declarados`,
        });
      }
    }
  });

export function parseFluxoDoTurno(valor: unknown): FluxoDoTurno {
  return fluxoDoTurnoSchema.parse(valor) as FluxoDoTurno;
}

/** O texto no idioma pedido, com recuo em pt-BR. Nunca vazio (o schema garante pt-BR). */
export function textoNoIdioma(texto: TextoDoFluxo, idioma: string | null): string {
  if (idioma !== null && idioma in texto) {
    const valor = texto[idioma as IdiomaDoTurno];
    if (typeof valor === "string" && valor.trim() !== "") return valor;
  }
  return texto[IDIOMA_DE_RECUO];
}

/** Minúsculas, sem acento e sem pontuação — a régua de comparação de gatilho. */
export function normalizarParaGatilho(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(texto: string): string[] {
  const normalizado = normalizarParaGatilho(texto);
  return normalizado === "" ? [] : normalizado.split(" ");
}

/**
 * As palavras de cada idioma que o detector conhece. Lista curta de propósito:
 * ela decide ENTRE ASSUMIR E DEIXAR A IA RESPONDER, e errar para o lado da IA é
 * o erro barato (o cliente é atendido do mesmo jeito). Palavras que existem nos
 * três idiomas ("por", "como", "esta") ficam FORA: elas somam para dois lados e
 * transformam o empate em sorteio.
 */
const PALAVRAS_DO_IDIOMA: Record<IdiomaDoTurno, readonly string[]> = {
  "pt-BR": [
    "nao", "sim", "voce", "obrigado", "obrigada", "meu", "minha", "laudo", "exame",
    "quero", "preciso", "favor", "qual", "onde", "quando", "estou", "meus", "minhas",
    "resultado", "doutor", "dra", "consulta", "marcado", "pronto", "sabado", "ainda",
  ],
  es: [
    "hola", "gracias", "mi", "mis", "quiero", "necesito", "favor", "cual", "donde",
    "cuando", "informe", "listo", "resultado", "examen", "doctor", "consulta", "esta",
    "sabado", "todavia",
  ],
  en: [
    "the", "is", "my", "please", "thanks", "thank", "you", "know", "ready", "hello",
    "can", "where", "when", "what", "report", "status", "need", "want", "results",
    "doctor", "appointment", "available", "open", "saturday", "still", "yet",
  ],
  hi: [],
  "hi-Latn": [
    "mera", "hai", "kya", "kaise", "kab", "kahan", "dhanyavad", "namaste", "aap",
    "mujhe", "chahiye", "taiyar", "report", "result", "doctor", "mil", "gaya", "miltajulta",
    // Escrita latina do #3063: frases curtas também precisam distinguir-se do inglês.
    "hain", "hoon", "karna", "kar", "hua", "hoga", "mere", "meri", "tum", "nahi", "nahin",
    "batao", "bata", "kitna", "kitne", "jaldi", "abhi", "lekin", "accha", "theek", "dena",
    "milegi", "milega", "mila", "mili",
  ],
};

/** Diacríticos que só aparecem em português (o espanhol não usa til nem cedilha). */
const DIACRITICOS_DO_PT = /[ãõçÃÕÇ]/;

/**
 * O idioma provável da mensagem, por escrito. `null` = não deu para saber — e
 * quem chama trata `null` como "não é comigo" (a IA responde).
 *
 * Três sinais, em ordem: escrita devanágari é híndi; til/cedilha é português;
 * senão, a contagem de palavras funcionais de cada idioma. Empate é `null`, e o
 * empate é FREQUENTE de propósito ("report" existe em en e hi) — desempatar por
 * ordem de lista faria o fluxo disparar em conversa que não é dele.
 */
export function idiomaDaMensagem(texto: string): IdiomaDoTurno | null {
  if (/[\u0900-\u097f]/.test(texto)) return "hi";
  if (DIACRITICOS_DO_PT.test(texto)) return "pt-BR";
  const palavras = tokens(texto);
  if (palavras.length === 0) return null;
  const contagem = new Map<IdiomaDoTurno, number>();
  for (const idioma of IDIOMAS_DO_TURNO) {
    const vocabulario = new Set(PALAVRAS_DO_IDIOMA[idioma]);
    const total = palavras.filter((p) => vocabulario.has(p)).length;
    if (total > 0) contagem.set(idioma, total);
  }
  if (contagem.size === 0) return null;
  const maior = Math.max(...contagem.values());
  const vencedores = [...contagem.entries()].filter(([, total]) => total === maior);
  return vencedores.length === 1 ? vencedores[0]![0] : null;
}

/**
 * Casa o gatilho como FRASE — tokens contíguos — e só no idioma dele. Devolve o
 * gatilho que casou, ou `null`. Ver as três cercas no cabeçalho do arquivo.
 */
export function gatilhoQueCasou(
  fluxo: Pick<FluxoDoTurno, "gatilhos">,
  texto: string,
  idioma: IdiomaDoTurno,
): GatilhoDoFluxo | null {
  const palavras = tokens(texto);
  if (palavras.length === 0 || palavras.length > LIMITES_DO_FLUXO.mensagemDoGatilho) return null;
  for (const gatilho of fluxo.gatilhos) {
    if (gatilho.idioma !== idioma) continue;
    const alvo = tokens(gatilho.texto);
    if (alvo.length === 0) continue;
    for (let i = 0; i + alvo.length <= palavras.length; i += 1) {
      if (alvo.every((palavra, j) => palavras[i + j] === palavra) &&
        (gatilho.com_um_de === undefined || gatilho.com_um_de.some((termo) => contemTermoLiteral(texto, termo)))) return gatilho;
    }
  }
  return null;
}

/**
 * As mensagens que NÃO são resposta de campo, mesmo com o fluxo em andamento:
 * agradecimento/encerramento fechado e pergunta. É o item 3 da issue com os
 * exemplos medidos ("obrigado", "quanto custa?", "abrem sábado?").
 *
 * A lista é fechada e curta, e a pergunta é detectada pelo `?` porque o
 * vocabulário do CRM já trata assim — quem pergunta quer informação, e quem tem
 * a informação é a IA, não o fluxo de coleta.
 */
const ENCERRAMENTOS = new Set([
  "obrigado", "obrigada", "valeu", "vlw", "ok", "okay", "certo", "beleza", "blz",
  "tchau", "ate", "adeus", "thanks", "thank", "you", "gracias", "dhanyavad", "bye",
  // Confirmações/saudações não úteis do #3063: nunca viram nome ou outro campo livre.
  "hi", "hello", "hey", "yes", "no", "haan", "han", "ji", "namaste", "namaskar",
  "shukriya", "theek", "acha", "accha", "good", "fine",
]);

export function mensagemForaDoFluxo(texto: string): boolean {
  const cru = texto.trim();
  if (cru === "") return true;
  if (cru.includes("?")) return true;
  const palavras = tokens(cru);
  if (palavras.length === 0) return true;
  if (palavras.length > LIMITES_DO_FLUXO.respostaDoCampo) return true;
  if (palavras.every((palavra) => ENCERRAMENTOS.has(palavra))) return true;
  return [...cru].length > LIMITES_DO_FLUXO.respostaCharacters;
}

/** O estado que o HOST guarda por conversa (`conversations.metadata`). */
export interface EstadoDoFluxo {
  /** `publisher/name` da extensão — o estado morre quando ela é desligada. */
  extensao: string;
  fluxo: string;
  /** Preenchida pelo host; ausente em estado legado, que não pode ser retomado. */
  revisao?: string;
  idioma: IdiomaDoTurno;
  /** Índice da pergunta PENDENTE em `perguntas`. */
  etapa: number;
  /** Campo → valor, na ordem em que foi coletado. */
  campos: Record<string, string>;
  /** Turnos seguidos sem progresso — teto do item 3. */
  sem_progresso: number;
  /** Janela de mensagens já reivindicadas (o claim do item 4). */
  mensagens: string[];
  iniciado_em: string;
}

export type MotivoDaDevolucao =
  | "sem_gatilho"
  | "idioma_fora"
  | "fora_do_fluxo"
  | "mensagem_vazia";

export type ResultadoDoFluxo =
  | { acao: "devolver"; porque: MotivoDaDevolucao }
  | {
      acao: "perguntar";
      estado: EstadoDoFluxo;
      texto: string;
      porque: "comecou" | "avancou" | "repetiu";
    }
  | {
      acao: "concluir";
      estado: EstadoDoFluxo;
      /** A despedida no idioma do fluxo. Vai como bolha e a IA responde no turno seguinte. */
      texto: string;
      porque: "coletou" | "teto";
    }
  | {
      acao: "passar";
      estado: EstadoDoFluxo;
      campos: Readonly<Record<string, string>>;
      aviso: string;
      porque: "coletou" | "teto";
    };

function clonar(estado: EstadoDoFluxo): EstadoDoFluxo {
  return { ...estado, campos: { ...estado.campos }, mensagens: [...estado.mensagens] };
}

function tetoDoFluxo(fluxo: FluxoDoTurno): number {
  return fluxo.teto_de_turnos_sem_progresso ?? LIMITES_DO_FLUXO.tetoDeTurnosSemProgresso;
}

/**
 * A DECISÃO da extensão para UMA mensagem. Função pura: sem banco, sem canal,
 * sem relógio — e é por isso que o teste dela consegue cobrir cada ramo sem
 * dublê de infraestrutura.
 *
 * `estado === null` = a conversa não está num fluxo: só um gatilho começa.
 * `estado !== null` = o fluxo está em andamento: a mensagem é resposta, e todo
 * caminho que não é resposta DEVOLVE (a IA responde) e ENCERRA o estado — menos
 * a mídia sem texto, que repete a pergunta e conta como turno sem progresso.
 *
 * `texto === null` = a mensagem não tem texto legível (foto, áudio sem legenda).
 */
export function decidirDoFluxo(
  fluxo: FluxoDoTurno,
  extensao: string,
  estado: EstadoDoFluxo | null,
  entrada: { texto: string | null; agora: string; camposIniciais?: Readonly<Record<string, string>> },
): ResultadoDoFluxo {
  const texto = entrada.texto === null ? "" : entrada.texto.trim();
  const idioma = idiomaDaMensagem(texto);

  if (estado === null) {
    if (texto === "") return { acao: "devolver", porque: "mensagem_vazia" };
    if (idioma === null || !fluxo.idiomas.includes(idioma)) {
      return { acao: "devolver", porque: "idioma_fora" };
    }
    if (gatilhoQueCasou(fluxo, texto, idioma) === null) {
      return { acao: "devolver", porque: "sem_gatilho" };
    }
    const novo: EstadoDoFluxo = {
      extensao,
      fluxo: fluxo.id,
      idioma,
      etapa: 0,
      campos: {},
      sem_progresso: 0,
      mensagens: [],
      iniciado_em: entrada.agora,
    };
    // Contexto só pode semear a opção declarada; nenhum valor livre é herdado.
    const contexto = fluxo.contexto;
    const inicial = contexto === undefined ? undefined : entrada.camposIniciais?.[contexto.campo];
    if (contexto !== undefined && inicial !== undefined && fluxo.perguntas.some((p) =>
      p.campo === contexto.campo && p.opcoes?.some((o) => o.valor === inicial))) novo.campos[contexto.campo] = inicial;
    preencherDeclarados(fluxo, novo, texto, false);
    if (condicaoAtendida(fluxo.encerrar_quando, novo.campos)) return encerrar(fluxo, novo, "coletou");
    novo.etapa = proximaPendente(fluxo, novo.campos);
    if (novo.etapa < 0) return encerrar(fluxo, novo, "coletou");
    return {
      acao: "perguntar", estado: novo,
      texto: textoNoIdioma(fluxo.perguntas[novo.etapa]!.texto, idioma), porque: "comecou",
    };
  }

  // O fluxo em andamento só continua se ainda for do MESMO pacote e a
  // mensagem estiver num idioma que ele cobre. Troca de idioma no meio é
  // conversa, não coleta: a IA assume.
  if (estado.fluxo !== fluxo.id || estado.extensao !== extensao) {
    return { acao: "devolver", porque: "sem_gatilho" };
  }
  if (idioma !== null && !fluxo.idiomas.includes(idioma)) {
    return { acao: "devolver", porque: "idioma_fora" };
  }

  // Mídia sem texto (foto do laudo, áudio sem transcrição): a conversa não fica
  // calada nem presa. Repete a pergunta pendente e conta turno sem progresso —
  // o teto abaixo garante a saída.
  if (texto === "") {
    const seguinte = clonar(estado);
    seguinte.sem_progresso += 1;
    if (seguinte.sem_progresso > tetoDoFluxo(fluxo)) {
      return encerrar(fluxo, seguinte, "teto");
    }
    return {
      acao: "perguntar",
      estado: seguinte,
      texto: textoNoIdioma(fluxo.perguntas[seguinte.etapa]!.texto, seguinte.idioma),
      porque: "repetiu",
    };
  }

  // Mensagem fora do fluxo DEVOLVE para a IA e encerra o estado: "obrigado",
  // "quanto custa?", "abrem sábado?" não são respostas de campo.
  if (mensagemForaDoFluxo(texto)) {
    return { acao: "devolver", porque: "fora_do_fluxo" };
  }

  // Mudar de opção no meio não transforma o nome de outro ramo num dado pessoal.
  if (fluxo.perguntas.some((p) => {
    const valor = opcaoNoTexto(p, texto);
    return valor !== null && estado.campos[p.campo] !== undefined && estado.campos[p.campo] !== valor;
  })) return { acao: "devolver", porque: "fora_do_fluxo" };
  const seguinte = clonar(estado);
  const antes = Object.keys(seguinte.campos).length;
  preencherDeclarados(fluxo, seguinte, texto, true);
  if (condicaoAtendida(fluxo.encerrar_quando, seguinte.campos)) return encerrar(fluxo, seguinte, "coletou");
  const pendente = proximaPendente(fluxo, seguinte.campos);
  if (pendente < 0) return encerrar(fluxo, seguinte, "coletou");
  if (Object.keys(seguinte.campos).length === antes) {
    seguinte.sem_progresso += 1;
    if (seguinte.sem_progresso > tetoDoFluxo(fluxo)) return encerrar(fluxo, seguinte, "teto");
    return { acao: "perguntar", estado: seguinte,
      texto: textoNoIdioma(fluxo.perguntas[pendente]!.texto, seguinte.idioma), porque: "repetiu" };
  }
  seguinte.sem_progresso = 0;
  seguinte.etapa = pendente;
  return {
    acao: "perguntar",
    estado: seguinte,
    texto: textoNoIdioma(fluxo.perguntas[seguinte.etapa]!.texto, seguinte.idioma),
    porque: "avancou",
  };
}

/** Compara uma frase literal, com limite de tokens e sem regex do pacote. */
export function contemTermoLiteral(texto: string, termo: string): boolean {
  const alvo = tokens(termo);
  const palavras = tokens(texto);
  if (alvo.length === 0) return false;
  if (/^\d+$/.test(termo.trim())) return texto.trim() === termo.trim();
  return palavras.some((_, i) => alvo.every((palavra, j) => palavras[i + j] === palavra));
}

function opcaoNoTexto(pergunta: PerguntaDoFluxoDeclarado, texto: string): string | null {
  const opcoes = pergunta.opcoes?.filter((o) => o.termos.some((t) => contemTermoLiteral(texto, t))) ?? [];
  return opcoes.length === 1 ? opcoes[0]!.valor : null;
}

function condicaoAtendida(condicao: CondicaoDeOpcao | undefined, campos: Readonly<Record<string, string>>): boolean {
  return condicao !== undefined && condicao.valores.includes(campos[condicao.campo] ?? "");
}

function aplicavel(pergunta: PerguntaDoFluxoDeclarado, campos: Readonly<Record<string, string>>): boolean {
  return pergunta.quando === undefined || condicaoAtendida(pergunta.quando, campos);
}

function proximaPendente(fluxo: FluxoDoTurno, campos: Readonly<Record<string, string>>): number {
  return fluxo.perguntas.findIndex((p) => aplicavel(p, campos) && campos[p.campo] === undefined);
}

/** Extração determinística do #3063, só da mensagem atual; devolve o trecho, sem estimar data. */
function datasDoTexto(texto: string): string[] {
  const latim = texto.match(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/gi);
  const devanagari = texto.match(/(\d{1,2}\s*)?(जनवरी|फ़रवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर)/g);
  return [...(latim ?? []), ...(devanagari ?? [])];
}

function preencherDeclarados(fluxo: FluxoDoTurno, estado: EstadoDoFluxo, texto: string, responderPendente: boolean): void {
  // Resolver opções primeiro permite aplicar somente os extratores do ramo escolhido.
  for (const pergunta of fluxo.perguntas) {
    if (!aplicavel(pergunta, estado.campos)) continue;
    const opcao = opcaoNoTexto(pergunta, texto);
    if (opcao !== null) estado.campos[pergunta.campo] = opcao;
  }
  if (condicaoAtendida(fluxo.encerrar_quando, estado.campos)) return;
  let restante = texto;
  const extratores = [...fluxo.perguntas].sort((a, b) => Number(b.extrair?.tipo === "data") - Number(a.extrair?.tipo === "data"));
  for (const pergunta of extratores) {
    if (!aplicavel(pergunta, estado.campos) || estado.campos[pergunta.campo] !== undefined) continue;
    const extrator = pergunta.extrair;
    let valor: string | null = null;
    let consumido: string | null = null;
    if (extrator?.tipo === "data") {
      const datas = datasDoTexto(texto);
      if (datas.length === 1) valor = consumido = datas[0]!;
    } else if (extrator?.tipo === "marcador") {
      for (const termo of extrator.termos) {
        const inicio = restante.toLocaleLowerCase().indexOf(termo.toLocaleLowerCase());
        if (inicio < 0 || (inicio > 0 && /[\p{L}\p{N}]/u.test(restante[inicio - 1]!))) continue;
        let trecho = restante.slice(inicio).split(/[;,\n]/, 1)[0]!.trim();
        for (const outra of extratores) {
          if (outra === pergunta || !aplicavel(outra, estado.campos) || outra.extrair?.tipo !== "marcador") continue;
          for (const marcador of outra.extrair.termos) {
            const proximo = trecho.toLocaleLowerCase().indexOf(marcador.toLocaleLowerCase(), termo.length);
            if (proximo > 0 && !/[\p{L}\p{N}]/u.test(trecho[proximo - 1]!)) trecho = trecho.slice(0, proximo).trim();
          }
        }
        const candidato = (extrator.incluir_marcador ? trecho : trecho.slice(termo.length)).trim();
        if (candidato !== "") { valor = candidato; consumido = trecho; break; }
      }
    }
    if (valor !== null && [...valor].length <= LIMITES_DO_FLUXO.respostaCharacters) {
      estado.campos[pergunta.campo] = valor;
      if (consumido !== null) restante = restante.replace(consumido, " ");
    }
  }
  const pergunta = fluxo.perguntas[estado.etapa];
  if (responderPendente && pergunta !== undefined && pergunta.opcoes === undefined &&
    pergunta.extrair?.tipo !== "data" && aplicavel(pergunta, estado.campos) && estado.campos[pergunta.campo] === undefined) {
    const valor = restante.replace(/^[,;:\s]+|[,;:\s]+$/g, "").trim();
    if (valor !== "") estado.campos[pergunta.campo] = valor;
  }
}

/**
 * O fim da coleta, no desfecho que o pacote declarou. Um lugar só decide entre `concluir` e
 * `passar`, para que a permissão exigida (`lib/extensions/consentimento.ts`, derivada daqui) e o
 * efeito do host nunca possam divergir: quem muda o desfecho muda o ramo por construção.
 */
function encerrar(
  fluxo: FluxoDoTurno,
  estado: EstadoDoFluxo,
  porque: "coletou" | "teto",
): ResultadoDoFluxo {
  if (fluxo.desfecho.tipo === "assumir") {
    return {
      acao: "concluir",
      estado,
      texto: textoNoIdioma(fluxo.desfecho.texto, estado.idioma),
      porque,
    };
  }
  return {
    acao: "passar",
    estado,
    campos: { ...estado.campos },
    aviso: textoNoIdioma(fluxo.desfecho.aviso, estado.idioma),
    porque,
  };
}
