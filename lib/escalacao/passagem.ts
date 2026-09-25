/**
 * O VOCABULÁRIO DA PASSAGEM IA → HUMANO, E A FRASE QUE UMA PESSOA LÊ.
 *
 * ─── O que esta entrega fecha ──────────────────────────────────────────────
 *
 * Toda passagem do atendimento automático para uma pessoa vira UMA LINHA DE
 * FATO em `public.passagens_de_atendimento` (migration 0291): por que a IA
 * passou, o que ela já tentou, o que o cliente quer, a última coisa que ele
 * escreveu, e se ele foi (ou não) avisado. Hoje nada disso sobrevive ao turno:
 * o motor A monta um resumo que morre no aviso da Central e o motor B abre o
 * aviso sem resumo nenhum.
 *
 * Este arquivo é a FONTE ÚNICA do vocabulário — as quatro colunas com CHECK da
 * tabela apontam para cá em `tests/invariants/vocabulario-banco-x-typescript.
 * test.ts`, e a lição daquela lista é a razão de o par nascer no mesmo commit da
 * migration: todos os que divergiram divergiram por terem nascido sozinhos.
 *
 * ─── Por que NÃO reaproveitar `HandoffReason` ──────────────────────────────
 *
 * `HandoffReason` (`lib/ai/handoff/orchestrator.ts`) é o contrato do motor B e
 * carrega `refund_mention`, que não tem emissor nenhum. `MOTIVOS_DA_PASSAGEM` é
 * superconjunto dele mais `caso_escalado` e `suspected_optout` — e é o que o
 * BANCO aceita. Amarrar os dois faria uma mudança de contrato do motor virar
 * `23514` num INSERT de caminho pouco exercitado.
 *
 * ─── A escrita, e por que ela mora aqui ────────────────────────────────────
 *
 * `registrarPassagem(db, p)` (no fim do arquivo) é quem grava a linha, chamada
 * pelos treze caminhos que passam conversa para humano. Ela aplica
 * `sanitizarTextoDoLead` a `title`, `notes` e `content` ANTES do insert: sem
 * isso, um agente externo escreve `https://…` no resumo e o cartão exibe um link
 * de phishing dentro da tela de quem vai atender. O schema Zod de `tentativas`
 * mora aqui porque ele é o que o CHECK do banco não consegue exprimir (o CHECK
 * garante só que é um array) e porque o par do invariante cita ESTE arquivo.
 */
import { z } from "zod";

import { sanitizarTextoDoLead } from "./sanitizar-texto-do-lead";

/**
 * Qual dos dois motores passou a conversa.
 *
 * `engine` = `lib/agent-engine` (fala com `pg.Pool`); `crm` = `lib/ai/handoff`
 * (fala com supabase-js). Os dois existem, os dois passam, e saber qual foi é o
 * que permite medir se um deles parou de gravar.
 */
export const MOTORES_DA_PASSAGEM = ["engine", "crm"] as const;
export type MotorDaPassagem = (typeof MOTORES_DA_PASSAGEM)[number];

/**
 * POR ONDE a passagem entrou — o caminho de código, não a razão humana.
 *
 * Distinto de `MOTIVOS_DA_PASSAGEM` de propósito: o mesmo motivo
 * (`requested_human`) chega por três origens diferentes (a detecção
 * determinística, a ferramenta do modelo e o MCP externo), e é a ORIGEM que
 * responde "que parte do sistema decidiu isto?" quando alguém duvida do número.
 * Os `legado_*` são os caminhos do motor B, que nomeia as suas razões antes de
 * chamar.
 */
export const ORIGENS_DA_PASSAGEM = [
  "pedido_explicito",
  "opt_out_provavel",
  "ferramenta_do_modelo",
  "teto_de_gasto",
  "caso_escalado",
  "sentimento",
  "legado_pedido",
  "legado_juridico",
  "legado_etapa",
  "legado_confianca",
  "legado_teto",
  "mcp_externo",
  "runtime_nativo",
] as const;
export type OrigemDaPassagem = (typeof ORIGENS_DA_PASSAGEM)[number];

/**
 * POR QUE a conversa saiu do automático. É o que vira frase na tela.
 *
 * Superconjunto de `HandoffReason` (ver o cabeçalho). `suspected_optout` e
 * `caso_escalado` não existem lá porque não são razões do motor B.
 */
export const MOTIVOS_DA_PASSAGEM = [
  "requested_human",
  "suspected_optout",
  "orcamento_de_ia",
  "low_sentiment",
  "low_confidence",
  "critical_stage",
  "legal_mention",
  "refund_mention",
  "caso_escalado",
] as const;
export type MotivoDaPassagem = (typeof MOTIVOS_DA_PASSAGEM)[number];

/**
 * POR QUE o cliente não foi avisado — vocabulário FECHADO, não texto livre.
 *
 * A coluna existe porque a promessa "o cliente JÁ foi avisado" era dita sem
 * ninguém olhar o desfecho do envio: `sendMessageHandler` devolve `failed` sem
 * lançar, e o caminho seguinte afirmava `avisado: true`. Quem assume precisa
 * saber se a pessoa do outro lado está esperando uma resposta ou está no escuro
 * — é a primeira frase que ele vai digitar.
 *
 * Fechado, e não `text` livre, porque a TELA traduz: uma frase gravada em
 * português no banco seria a segunda representação do mesmo fato, e a primeira
 * a ficar sem espanhol.
 */
export const MOTIVOS_DO_AVISO = [
  "na_fila_canal_fora",
  "falhou_no_envio",
  "sem_telefone",
  "pre_go_live",
  "canal_arquivado",
  "fora_da_janela",
] as const;
export type MotivoDoAviso = (typeof MOTIVOS_DO_AVISO)[number];

/**
 * A frase em PORTUGUÊS de cada motivo. A chave do dicionário É o texto pt.
 *
 * `satisfies` e não `:` — a anotação de tipo apagaria o literal e quem lesse
 * `FRASE_DO_MOTIVO.requested_human` receberia `string` em vez da frase. O
 * `satisfies` mantém as duas coisas: exaustividade cobrada pelo compilador e
 * tipo estreito na leitura.
 */
export const FRASE_DO_MOTIVO = {
  requested_human: "O cliente pediu para falar com uma pessoa",
  suspected_optout: "O cliente parece ter pedido para não receber mais mensagens",
  orcamento_de_ia: "O limite de gasto com IA foi atingido — o cliente não pediu uma pessoa",
  low_sentiment: "O cliente demonstrou irritação na conversa",
  low_confidence: "O assistente não teve confiança suficiente para responder",
  critical_stage: "O negócio chegou a uma etapa que pede uma pessoa",
  legal_mention: "A conversa tocou em assunto jurídico",
  refund_mention: "A conversa tocou em reembolso",
  caso_escalado: "Uma pessoa da equipe escalou um atendimento",
} satisfies Record<MotivoDaPassagem, string>;

/**
 * Quem percebeu a irritação foi o Jev (D11). Entra só no que a EQUIPE lê — o
 * resumo da passagem e o aviso da Central —, nunca no que vai para o cliente: é
 * o momento do dia a dia em que o Jev aparece trabalhando.
 */
export const MARCA_DO_JEV = "(percebido pelo Jev)";

/**
 * A frase do motivo com a marca, exatamente como o briefing a grava no `body`
 * da passagem (`briefing-da-passagem.ts`). É por ela que o cartão do Inbox sabe
 * que foi o Jev — a passagem não tem coluna para o motor.
 * ponytail: derivado do texto gravado; se o motor ganhar coluna, o cartão lê de lá.
 */
export const MOTIVO_PERCEBIDO_PELO_JEV = `${FRASE_DO_MOTIVO.low_sentiment} ${MARCA_DO_JEV}`;

/** A frase em português de cada motivo de o cliente NÃO ter sido avisado. */
export const FRASE_DO_MOTIVO_DO_AVISO = {
  na_fila_canal_fora: "A mensagem ficou na fila porque o canal está fora do ar",
  falhou_no_envio: "O canal recusou a mensagem de aviso",
  sem_telefone: "O contato não tem telefone cadastrado",
  pre_go_live: "O número ainda está em aquecimento e não envia mensagens",
  canal_arquivado: "O canal desta conversa foi arquivado",
  fora_da_janela: "Estamos fora do horário em que este canal envia mensagens",
} satisfies Record<MotivoDoAviso, string>;

/**
 * O TEXTO QUE SAI QUANDO NÃO HÁ CONTEXTO NENHUM. Uma frase, uma fonte.
 *
 * Ele é lido em dois lugares — a montagem do briefing (que o devolve quando
 * nenhum bloco foi impresso) e a escrita da linha (onde `body` é `not null`) —
 * e por isso mora no arquivo de vocabulário, não em nenhum dos dois. Duas
 * cópias da MESMA frase de tela envelhecem separadas, e a segunda a divergir é
 * sempre a que ninguém relê.
 *
 * Por que não string vazia: um briefing em branco na tela de quem assume AFIRMA
 * que não há contexto, quando o que houve foi a montagem não ter recebido nada.
 */
export const PISO_DO_BRIEFING =
  "Sem resumo acumulado ainda (conversa recente) — abra a conversa no CRM para o contexto completo.";

/**
 * Uma tentativa da IA, do jeito que o cartão a mostra: o que ela fez e no que
 * deu. `desfecho` é opcional porque a ferramenta pode declarar só a ação.
 *
 * Os tetos não são zelo: `tentativas` é `jsonb` gravado a partir do que o MODELO
 * (ou um agente MCP externo) escreveu. Sem limite, uma linha de banco cresce sem
 * teto num campo que ninguém lê inteiro — e o cartão, que é renderizado dentro
 * da conversa, vira uma página de texto.
 */
export const tentativaDaPassagemSchema = z.object({
  o_que: z.string().trim().min(1).max(280),
  desfecho: z.string().trim().min(1).max(280).optional(),
});
export type TentativaDaPassagem = z.infer<typeof tentativaDaPassagemSchema>;

/**
 * A lista inteira. É ESTE schema que `registrarPassagem` (no fim do arquivo) aplica
 * antes do insert — o CHECK do banco garante só que o valor é um array, porque
 * `jsonb` lido por path sem schema central é o anti-pattern nº 6.
 */
export const tentativasDaPassagemSchema = z.array(tentativaDaPassagemSchema).max(10);

/* ───────────────────────────────────────────────────────────────────────────
 * A ESCRITA DA LINHA — a onda dos call sites (migration 0293)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * O desfecho do aviso ao cliente, no vocabulário que a LINHA guarda.
 *
 * `null` (o campo ausente) = ninguém tentou avisar, e é diferente de "tentou e
 * não conseguiu". Quem assume precisa saber qual dos dois: no primeiro caso a
 * pessoa do outro lado não está esperando nada; no segundo ela está esperando
 * sem saber que alguém vem.
 */
export interface DesfechoDoAvisoDaPassagem {
  avisado: boolean;
  /** Por que NÃO foi avisado. Ignorado quando `avisado` é `true`. */
  motivoCodigo?: MotivoDoAviso | null;
}

/**
 * O MESMO desfecho, do jeito que os dois EMISSORES do aviso o devolvem.
 *
 * Mora aqui, e não em cada mundo, porque ele já divergiu: o motor de conversa
 * tinha uma união discriminada e o do CRM tinha um `{ avisado: boolean }` solto,
 * e o segundo é exatamente o tipo que deixou `avisado: true` passar sem ninguém
 * olhar o status da mensagem. União discriminada obriga quem devolve `false` a
 * dizer POR QUÊ — o compilador cobra o que a revisão esqueceu.
 *
 * `porque` é o código técnico (log, diagnóstico). `motivoCodigo` é o vocabulário
 * fechado que a linha da passagem guarda e que a tela traduz; opcional porque
 * nem todo veto tem par, e inventar um seria afirmar o que ninguém mediu.
 */
export type DesfechoDoAvisoAoCliente =
  | { avisado: true }
  | { avisado: false; porque: string; motivoCodigo?: MotivoDoAviso };

/** Os fatos de UMA passagem, do jeito que a linha os guarda. */
export interface PassagemNova {
  organizationId: string;
  contactId: string;
  conversationId: string;
  /** Só quando a passagem nasceu do "Não consigo → escalar" de um caso. */
  casoId?: string | null;
  motor: MotorDaPassagem;
  origem: OrigemDaPassagem;
  motivoCodigo: MotivoDaPassagem;
  /** O que `montarBriefingDaPassagem` devolveu — a montagem é dela, não daqui. */
  briefing: {
    body: string;
    title: string | null;
    notes: string | null;
    content: string | null;
    tentativas: readonly TentativaDaPassagem[];
  };
  /** Ausente = ninguém tentou avisar o cliente. */
  aviso?: DesfechoDoAvisoDaPassagem | null;
}

/**
 * Tetos por coluna. Não são zelo: `title`/`notes`/`content` vêm do MODELO ou de
 * um agente MCP externo, e uma linha sem teto vira uma página de texto dentro da
 * conversa de quem vai atender. `body` é NOSSA montagem e leva o teto mais largo
 * porque é ele que carrega o contexto acumulado.
 */
const TETOS_DA_PASSAGEM = { title: 300, notes: 2000, content: 1200, body: 8000 } as const;

/** A linha, pronta para o INSERT. As chaves são as colunas, de propósito. */
export interface LinhaDaPassagem {
  organization_id: string;
  contact_id: string;
  conversation_id: string;
  caso_id: string | null;
  motor: MotorDaPassagem;
  origem: OrigemDaPassagem;
  motivo_codigo: MotivoDaPassagem;
  title: string | null;
  body: string;
  notes: string | null;
  content: string | null;
  tentativas: TentativaDaPassagem[];
  cliente_avisado: boolean | null;
  aviso_motivo_codigo: MotivoDoAviso | null;
}

/**
 * Valida e higieniza — PURA, e é ela que os dois motores compartilham.
 *
 * Duas coisas acontecem aqui, e nenhuma pode acontecer no chamador:
 *
 *   1. **`tentativas` passa pelo Zod.** O CHECK do banco garante só que o valor
 *      é um array; o que há DENTRO dele vem do modelo. `jsonb` lido por path cru
 *      é o anti-pattern nº 6, e a defesa é ter um schema no caminho da escrita.
 *   2. **`title`, `notes` e `content` passam por `sanitizarTextoDoLead`.** Os
 *      três carregam texto de fora (o `por_que` que o modelo escreveu, a fala do
 *      cliente, o `reason` de um agente MCP) e vão ser renderizados na tela de
 *      quem atende. Sem isso, escrever `https://…` na conversa põe um link de
 *      phishing dentro do CRM — de graça, e com a autoridade da nossa interface.
 *
 * ⚠️ O que a higienização CUSTA, escrito porque ninguém o vê depois: ela apaga
 * corrida de 8+ dígitos. Um cliente que digite o próprio telefone perde esse
 * trecho em `notes`. O `body` — que é a nossa montagem e é onde a citação
 * completa mora — NÃO passa por ela, então a fala literal sobrevive lá; quem
 * renderiza o cartão é que não pode transformar texto em link.
 */
export function prepararLinhaDaPassagem(p: PassagemNova): LinhaDaPassagem {
  const tentativas = tentativasDaPassagemSchema.parse(p.briefing.tentativas ?? []);
  const corpo = p.briefing.body.trim();
  return {
    organization_id: p.organizationId,
    contact_id: p.contactId,
    conversation_id: p.conversationId,
    caso_id: p.casoId ?? null,
    motor: p.motor,
    origem: p.origem,
    motivo_codigo: p.motivoCodigo,
    title: sanitizarTextoDoLead(p.briefing.title, TETOS_DA_PASSAGEM.title),
    // `body` é `not null` na coluna: montagem vazia vira o piso, nunca `''`.
    body: (corpo === "" ? PISO_DO_BRIEFING : corpo).slice(0, TETOS_DA_PASSAGEM.body),
    notes: sanitizarTextoDoLead(p.briefing.notes, TETOS_DA_PASSAGEM.notes),
    content: sanitizarTextoDoLead(p.briefing.content, TETOS_DA_PASSAGEM.content),
    tentativas,
    cliente_avisado: p.aviso == null ? null : p.aviso.avisado,
    aviso_motivo_codigo:
      p.aviso == null || p.aviso.avisado ? null : (p.aviso.motivoCodigo ?? null),
  };
}


/** As colunas do INSERT, na ordem dos `$n`. Uma lista, dois motores. */
const COLUNAS_DA_PASSAGEM = [
  "organization_id",
  "contact_id",
  "conversation_id",
  "caso_id",
  "motor",
  "origem",
  "motivo_codigo",
  "title",
  "body",
  "notes",
  "content",
  "tentativas",
  "cliente_avisado",
  "aviso_motivo_codigo",
] as const;

/** O mínimo de `pg.Pool` que a escrita usa. Tipado aqui para não arrastar `pg`. */
interface PoolDoMotor {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}
/** O mínimo de `supabase-js` que a escrita usa. */
interface ClienteDoCrm {
  from(tabela: string): {
    insert(linha: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
}

export type ResultadoDaPassagem = { gravada: true } | { gravada: false; erro: string };

/**
 * GRAVA A PASSAGEM. Uma passagem = uma linha. **Sem dedup**: é o fato, e dois
 * fatos seguidos são dois fatos. Quem deduplica é o AVISO da Central, que é
 * alerta e não registro.
 *
 * ─── Por que ela não lança ─────────────────────────────────────────────────
 *
 * Porque a passagem já aconteceu quando esta linha roda: o `force_human` está
 * gravado, a conversa saiu do automático, o cliente já foi (ou não) avisado.
 * Deixar um erro de INSERT subir daqui derrubaria o turno DEPOIS do efeito, e o
 * retry replicaria tudo. Falhar fechado na AÇÃO, aberto na INFORMAÇÃO — e o erro
 * não é engolido: ele volta no retorno, e o chamador o registra com o logger que
 * ele tem (este módulo é dos dois mundos e não tem um).
 *
 * ─── Por que um nome e dois encanamentos ───────────────────────────────────
 *
 * O motor de conversa fala `pg.Pool` e o do CRM fala `supabase-js`; não há
 * cliente comum. O que NÃO pode divergir é o que se grava — e isso é
 * `prepararLinhaDaPassagem`, uma função só, que os dois caminhos atravessam.
 */
export async function registrarPassagem(
  db: PoolDoMotor | ClienteDoCrm,
  p: PassagemNova,
): Promise<ResultadoDaPassagem> {
  let linha: LinhaDaPassagem;
  try {
    linha = prepararLinhaDaPassagem(p);
  } catch (err) {
    // Payload que o modelo escreveu fora do schema. Não é erro de banco, e
    // também não pode derrubar a passagem.
    return { gravada: false, erro: err instanceof Error ? err.message.slice(0, 200) : "payload_invalido" };
  }

  try {
    if (typeof (db as PoolDoMotor).query === "function") {
      const valores = COLUNAS_DA_PASSAGEM.map((c) =>
        c === "tentativas" ? JSON.stringify(linha.tentativas) : linha[c],
      );
      await (db as PoolDoMotor).query(
        `insert into passagens_de_atendimento (${COLUNAS_DA_PASSAGEM.join(", ")})
         values (${COLUNAS_DA_PASSAGEM.map((_, i) => `$${i + 1}`).join(", ")})`,
        valores,
      );
      return { gravada: true };
    }
    const { error } = await (db as ClienteDoCrm)
      .from("passagens_de_atendimento")
      .insert(linha as unknown as Record<string, unknown>);
    if (error) return { gravada: false, erro: error.message.slice(0, 200) };
    return { gravada: true };
  } catch (err) {
    return { gravada: false, erro: err instanceof Error ? err.message.slice(0, 200) : "erro_desconhecido" };
  }
}

/**
 * O CORPO CURTO do aviso da Central — o que uma pessoa lê na lista de avisos.
 *
 * ⚠️ Ele NÃO carrega conteúdo da conversa, e isso é a decisão, não um descuido.
 * A rota da Central lê os avisos com o client de serviço e entrega `body` a
 * qualquer `agent` da organização — inclusive a quem a política de visibilidade
 * de conversa não deixaria abrir aquele atendimento. Enquanto o resumo morava
 * aqui, a Central era uma porta lateral para o texto da conversa. O briefing
 * mora na passagem, que é lida sob `fn_can_view_conversation`.
 *
 * O texto é traduzido AQUI, no servidor, no instante do insert: o corpo do aviso
 * é DADO (a tela o mostra cru, de propósito — é o que `central-avisos-mostra-o-
 * aviso-como-veio` guarda), então ele não passa por `t()` na renderização.
 */
export function corpoCurtoDoAviso(
  entrada: {
    motivoCodigo: MotivoDaPassagem;
    aviso?: DesfechoDoAvisoDaPassagem | null;
    percebidoPeloJev?: boolean;
  },
  traduzirTexto: (texto: string) => string,
): string {
  const motivo = traduzirTexto(FRASE_DO_MOTIVO[entrada.motivoCodigo]);
  const partes = [entrada.percebidoPeloJev === true ? `${motivo} ${traduzirTexto(MARCA_DO_JEV)}` : motivo];
  const linha = linhaDoAvisoAoCliente(entrada.aviso, traduzirTexto);
  if (linha !== null) partes.push(linha);
  partes.push(traduzirTexto("Abra a conversa para ver o contexto."));
  return partes.join(" · ");
}

/**
 * "Essa pessoa sabe que estou vindo?" — a pergunta que muda a primeira frase
 * que o atendente digita.
 *
 * ⚠️ **As duas primeiras frases são CONTRATO** e saem literalmente iguais ao que
 * existia antes desta entrega: `tests/invariants/handoff-avisa-o-lead.test.ts`
 * casa `/JÁ FOI avisado/` num turno real. A terceira é NOVA e existe porque o
 * estado que ela descreve não era distinguido: `queued` (o canal está fora do
 * ar) contava como "avisado", e o cliente não tinha recebido nada.
 */
export function linhaDoAvisoAoCliente(
  aviso: DesfechoDoAvisoDaPassagem | null | undefined,
  traduzirTexto: (texto: string) => string,
): string | null {
  if (aviso == null) return null;
  if (aviso.avisado) return traduzirTexto("O cliente JÁ FOI avisado de que uma pessoa vai assumir.");
  if (aviso.motivoCodigo === "na_fila_canal_fora") {
    return traduzirTexto("O aviso ficou na fila (o canal está fora do ar) — o cliente ainda não recebeu.");
  }
  const porque =
    aviso.motivoCodigo == null
      ? traduzirTexto("motivo desconhecido")
      : traduzirTexto(FRASE_DO_MOTIVO_DO_AVISO[aviso.motivoCodigo]);
  return `⚠️ ${traduzirTexto("O cliente NÃO foi avisado")} (${porque}) — ${traduzirTexto("ele está esperando sem saber.")}`;
}

/**
 * O texto livre que um agente externo mandou como `reason` vira um código do
 * nosso vocabulário quando corresponde a um; senão, `requested_human`.
 *
 * O texto NÃO se perde: ele vai para `content`, que é redigível pela cascata de
 * LGPD. Antes desta entrega ele ia para `api_audit_log.metadata`, tabela sem
 * `UPDATE`/`DELETE` para papel nenhum — texto livre de fora, gravado onde
 * ninguém consegue apagar.
 */
export function motivoCodigoDoTexto(texto: string | null | undefined): MotivoDaPassagem {
  const bruto = (texto ?? "").trim();
  return (MOTIVOS_DA_PASSAGEM as readonly string[]).includes(bruto)
    ? (bruto as MotivoDaPassagem)
    : "requested_human";
}
