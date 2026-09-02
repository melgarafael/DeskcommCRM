/**
 * O que aconteceu no follow-up, em português.
 *
 * `followup_enrollment_events` grava a história do motor em vocabulário de
 * motor: `node_advanced`, `classify_enqueued`, `wait-2`. Isso é o certo para o
 * banco e é ilegível para quem opera — e uma tela que despeja o cru não é
 * "log visível", é dump. A diferença entre as duas coisas é este arquivo.
 *
 * ⚠️ PONTO DE TROCA. O vocabulário pt-br canônico do follow-up está sendo
 * escrito em `lib/followup/vocabulario.ts` (Wave 0). Quando ele existir, as
 * tabelas daqui saem e a tradução passa a importar de lá — dois dicionários
 * divergem em uma semana, e o que diverge em silêncio é o da tela. A fronteira
 * está desenhada para essa troca: quem consome chama `descreveEvento` /
 * `resumoDoNo`, nunca lê as tabelas direto.
 *
 * ⚠️ O ALVO ANDA JUNTO COM O QUE ACONTECEU. Guardar "falhou: timeout" e
 * descartar ONDE falhou produz uma tela que parece completa e não serve para
 * diagnosticar nada. Toda descrição daqui carrega o nó (e o dossiê carrega o
 * contato) — quando o nó sumiu do grafo pinado, o id cru aparece dito como id,
 * porque um alvo feio é melhor que alvo nenhum.
 */
import {
  CONDITION_FALSE_BRANCH_ID,
  CONDITION_TRUE_BRANCH_ID,
  FALLBACK_BRANCH_ID,
  NO_REPLY_BRANCH_ID,
  type FlowEdge,
  type FlowNode,
} from "./graph-schema";
import {
  RAMOS_RESERVADOS_EM_FRASE,
  fraseDaClasse,
  fraseDaRegraNomeada,
  fraseDaRegraSemNome,
  fraseDoRamo,
} from "./vocabulario";

// ---------------------------------------------------------------------------
// Duração
// ---------------------------------------------------------------------------

/** "45 minutos", "4 horas", "2 dias" — arredondado para a maior unidade inteira. */
export function duracaoLegivel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "tempo indefinido";
  const minutos = Math.round(ms / 60_000);
  if (minutos < 1) return "menos de um minuto";
  if (minutos < 60) return `${minutos} ${minutos === 1 ? "minuto" : "minutos"}`;
  const horas = minutos / 60;
  if (horas < 24) {
    const h = Number.isInteger(horas) ? horas : Math.round(horas * 10) / 10;
    return `${h} ${h === 1 ? "hora" : "horas"}`;
  }
  const dias = horas / 24;
  const d = Number.isInteger(dias) ? dias : Math.round(dias * 10) / 10;
  return `${d} ${d === 1 ? "dia" : "dias"}`;
}

// ---------------------------------------------------------------------------
// O estado do follow-up
// ---------------------------------------------------------------------------

/** O tom do marcador de estado — os mesmos nomes que `<Badge variant>` aceita. */
export type TomDoStatus = "neutral" | "success" | "warning" | "error" | "info";

/**
 * Como cada estado se chama e se pinta na tela — em um lugar só.
 *
 * A fila e o dossiê mostram o MESMO status, e a tabela vivia dentro do
 * componente da fila: a segunda tela nasceria com a segunda cópia, e a divergência
 * entre elas seria a mesma que `activity-vocabulary.ts` já pagou uma vez.
 *
 * `paused_handoff` e `paused_manual` NÃO compartilham rótulo: os dois pararam o
 * fluxo, mas um é "alguém está atendendo agora" e o outro é "alguém mandou
 * segurar". Quem lê a fila decide coisas diferentes em cada caso.
 */
const STATUS: Record<string, { rotulo: string; tom: TomDoStatus }> = {
  active: { rotulo: "Ativo", tom: "success" },
  waiting_reply: { rotulo: "Aguardando resposta", tom: "info" },
  paused_handoff: { rotulo: "Pausado (atendimento humano)", tom: "warning" },
  paused_manual: { rotulo: "Pausado por uma pessoa", tom: "warning" },
  completed: { rotulo: "Concluído", tom: "neutral" },
  cancelled: { rotulo: "Cancelado", tom: "neutral" },
  dead: { rotulo: "Parou de tentar", tom: "error" },
  // Os três da PROMESSA (`cron_jobs`), que a fila mostra lado a lado com os
  // enrollments — o vocabulário da tela é um só, mesmo vindo de duas tabelas.
  agendada: { rotulo: "Agendada", tom: "info" },
  "concluída": { rotulo: "Concluída", tom: "neutral" },
  cancelada: { rotulo: "Cancelada", tom: "neutral" },
};

export function rotuloDoStatus(status: string): string {
  return STATUS[status]?.rotulo ?? status;
}

export function tomDoStatus(status: string): TomDoStatus {
  return STATUS[status]?.tom ?? "neutral";
}

// ---------------------------------------------------------------------------
// Os nós do fluxo pinado
// ---------------------------------------------------------------------------

/**
 * Um nó como o dossiê o mostra.
 *
 * É de propósito uma PROJEÇÃO, não o nó inteiro: a fila é de qualquer membro
 * (`viewer`) e o `config` carrega o `prompt_hint`, que é a instrução que o dono
 * do fluxo escreveu para o agente. Editar fluxo é `manager`; mandar o config
 * cru para a tela de leitura entregaria a viewer o que ele não pode nem abrir.
 */
export interface NoDoDossie {
  id: string;
  tipo: FlowNode["type"];
  /** O nome que a pessoa deu ao nó no construtor. */
  rotulo: string;
  /** O que o nó faz, em uma linha, sem instrução de prompt. */
  resumo: string;
}

const TIPO_DO_NO: Record<FlowNode["type"], string> = {
  trigger: "Início",
  wait: "Espera",
  condition: "Condição",
  ai_classify: "Interpretação da resposta",
  action: "Mensagem",
  end: "Fim",
};

const DESFECHO: Record<string, string> = {
  converted: "converteu",
  replied: "respondeu",
  exhausted: "esgotou as tentativas",
  opted_out: "pediu para parar",
  handoff: "passou para uma pessoa",
  custom: "desfecho próprio",
};

/** O rótulo do tipo, para o cabeçalho do passo. */
export function tipoDoNo(tipo: FlowNode["type"]): string {
  return TIPO_DO_NO[tipo] ?? "Passo";
}

export function resumoDoNo(node: FlowNode): NoDoDossie {
  const base = { id: node.id, tipo: node.type, rotulo: node.label };
  switch (node.type) {
    case "trigger":
      return { ...base, resumo: "onde o follow-up começa" };
    case "wait":
      return {
        ...base,
        resumo:
          node.config.mode === "fixed"
            ? `espera ${duracaoLegivel(node.config.duration_ms)}`
            : `espera adaptativa, entre ${duracaoLegivel(node.config.min_ms)} e ${duracaoLegivel(node.config.max_ms)}`,
      };
    case "condition":
      return {
        ...base,
        resumo: `confere ${node.config.checks.length} ${node.config.checks.length === 1 ? "critério" : "critérios"} do negócio`,
      };
    case "ai_classify":
      return { ...base, resumo: `classifica a resposta em: ${node.config.classes.join(", ")}` };
    case "action":
      return {
        ...base,
        resumo:
          node.config.mode === "ai_message"
            ? "o agente escreve e envia a mensagem"
            : "envia uma mensagem de modelo pronto",
      };
    case "end":
      return { ...base, resumo: `encerra — ${DESFECHO[node.config.outcome] ?? node.config.outcome}` };
  }
}

/**
 * Quando este caminho é seguido — o que a pessoa lê ao escolher um ramo para pular.
 *
 * ⚠️ AS FRASES NÃO MORAM AQUI. Vieram para `lib/followup/vocabulario.ts`, que é
 * o dicionário do follow-up — este arquivo sempre declarou no cabeçalho que era
 * um PONTO DE TROCA até ele existir, e a troca é esta. O risco que ela mata é
 * concreto no grafo v2: o MESMO ramo chega como `class_match` (v1) ou como
 * `branch_id` (v2), e com dois dicionários o mesmo fluxo seria lido de dois
 * jeitos conforme a versão em que foi publicado.
 *
 * ⚠️ E O RAMO SEM NOME DEIXOU DE ECOAR O ID. A versão anterior mostrava
 * "pelo ramo b3f1", com o argumento de que um alvo feio é melhor que alvo
 * nenhum. O dono do vocabulário tem a regra oposta e é a certa aqui:
 * `branch_id` é identificador INTERNO e não pode chegar à tela. O que dava a
 * distinguibilidade continua existindo por outro campo — a lista de saídas do
 * dossiê mostra o RÓTULO DO DESTINO ao lado da frase, e é ele que separa duas
 * opções na hora de escolher por onde pular.
 */
export function rotuloDaAresta(edge: FlowEdge, origem?: FlowNode): string {
  const c = edge.condition;
  if (c.type === "always") return RAMOS_RESERVADOS_EM_FRASE[FALLBACK_BRANCH_ID];
  if (c.type === "cond_result") {
    return RAMOS_RESERVADOS_EM_FRASE[c.value ? CONDITION_TRUE_BRANCH_ID : CONDITION_FALSE_BRANCH_ID];
  }
  // v1: a classe é o próprio identificador do ramo.
  if (c.type === "class_match") {
    return c.value === NO_REPLY_BRANCH_ID
      ? RAMOS_RESERVADOS_EM_FRASE[NO_REPLY_BRANCH_ID]
      : fraseDaClasse(c.value);
  }

  // v2: reservado tem frase própria; declarado precisa do NÓ, porque é lá que a
  // identidade do ramo mora — e o molde depende do tipo do nó (classe da IA e
  // regra do negócio não se leem igual).
  return fraseDoRamo(c.branch_id) ?? fraseDoRamoDeclarado(origem, c.branch_id);
}

const RAMO_SEM_NOME = "por um caminho sem nome";

/** O molde certo para o ramo que o usuário declarou, escolhido pelo tipo do nó. */
function fraseDoRamoDeclarado(origem: FlowNode | undefined, branchId: string): string {
  if (!origem) return RAMO_SEM_NOME;

  if (origem.type === "ai_classify") {
    const label = origem.config.branches?.find((b) => b.id === branchId)?.label;
    return label ? fraseDaClasse(label) : RAMO_SEM_NOME;
  }

  if (origem.type === "condition") {
    const check = origem.config.checks.find((c) => c.id === branchId);
    if (!check) return RAMO_SEM_NOME;
    // Regra batizada usa o nome que a pessoa deu; sem nome, a condição por
    // extenso — `regra-2` na tela do operador é o que o vocabulário proíbe.
    return check.label
      ? fraseDaRegraNomeada(check.label)
      : fraseDaRegraSemNome(check.field, check.op, check.value);
  }

  return RAMO_SEM_NOME;
}

/** O nó como aparece numa frase; id cru quando ele não está mais no grafo pinado. */
export function refDoNo(nodeId: string | null, nos: Record<string, NoDoDossie>): string {
  if (!nodeId) return "sem passo associado";
  const no = nos[nodeId];
  // ⚠️ AQUI o id CRU aparece de propósito, e não contradiz a regra do ramo.
  //
  // A distinção, na formulação do dono do vocabulário (`@QAVivo`), que é melhor
  // que a que eu tinha: a pergunta não é "id na tela, sim ou não" — é se existe
  // NOME DISPONÍVEL em outro lugar. Ramo tem nome no nó, então ecoar o
  // `branch_id` é preguiça. Passo apagado do grafo não tem nome em lugar nenhum,
  // e o id vira o único gancho que sobrou.
  //
  // E ele é apresentado EXPLICITAMENTE como id, com "não existe mais neste
  // fluxo" ao lado, para ninguém o ler como nome: **id disfarçado de nome é o
  // defeito; id assumido como id, quando não há nome, é informação.**
  return no ? no.rotulo : `passo ${nodeId} (não existe mais neste fluxo)`;
}

// ---------------------------------------------------------------------------
// Os eventos
// ---------------------------------------------------------------------------

export interface EventoDeEnrollment {
  id: string;
  node_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EventoLegivel {
  /** O QUE aconteceu. */
  titulo: string;
  /** O detalhe — destino, classe, prazo, erro. `null` quando não há o que dizer. */
  detalhe: string | null;
  /** ONDE aconteceu (o nó), sempre presente. */
  onde: string;
  /** Quem provocou: o motor, uma pessoa, o cliente. Decide a forma do marcador. */
  autor: "motor" | "pessoa" | "cliente";
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function quandoLegivel(iso: unknown): string | null {
  const s = texto(iso);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat("pt-PT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

/**
 * O passo do motor virado frase.
 *
 * O `default` NÃO devolve o `event_type` disfarçado de frase — mas também não o
 * esconde. Tipo desconhecido significa "o motor ganhou um passo que esta tela
 * ainda não aprendeu", e é exatamente aí que quem diagnostica precisa do código:
 * omitir produz uma linha que afirma menos do que se sabe. É a mesma escolha do
 * `refDoNo` acima — feio e verdadeiro ganha de bonito e mudo.
 */
export function descreveEvento(
  evento: EventoDeEnrollment,
  nos: Record<string, NoDoDossie>,
): EventoLegivel {
  const onde = refDoNo(evento.node_id, nos);
  const p = evento.payload ?? {};
  const motor = { onde, autor: "motor" as const };
  const pessoa = { onde, autor: "pessoa" as const };
  const cliente = { onde, autor: "cliente" as const };

  switch (evento.event_type) {
    case "node_advanced":
      return { titulo: "Seguiu em frente", detalhe: `foi para ${refDoNo(texto(p.next_node_id), nos)}`, ...motor };
    case "wait_started": {
      const ate = quandoLegivel(p.next_eval_at);
      const modo = texto(p.mode) === "smart" ? " (tempo escolhido pelo agente)" : "";
      return { titulo: "Começou a esperar", detalhe: ate ? `volta a olhar em ${ate}${modo}` : null, ...motor };
    }
    case "turn_enqueued":
      // O MESMO event_type serve a dois pedidos diferentes, e o `purpose` no
      // payload é o que os separa. Sem olhar para ele, o passo de PLANEJAMENTO
      // aparecia como "escrever a mensagem" — uma linha que descreve o passo
      // errado é pior que uma linha genérica, porque não parece errada.
      return texto(p.purpose) === "plan_timing"
        ? { titulo: "Pediu ao agente para planejar os tempos de espera", detalhe: null, ...motor }
        : { titulo: "Pediu ao agente para escrever a mensagem", detalhe: null, ...motor };
    case "classify_enqueued":
      return { titulo: "Pediu ao agente para interpretar a resposta", detalhe: null, ...motor };
    case "action_recheck": {
      const ate = quandoLegivel(p.next_eval_at);
      return {
        titulo: "Conferiu se a mensagem já tinha saído",
        detalhe: ate ? `confere de novo em ${ate}` : null,
        ...motor,
      };
    }
    case "action_sent":
      return { titulo: "Mensagem enviada", detalhe: null, ...motor };
    case "ai_classified":
      return {
        titulo: "O agente interpretou a resposta",
        detalhe: texto(p.class) ? `classificou como “${texto(p.class)}”` : null,
        ...motor,
      };
    case "flow_completed": {
      const desfecho = texto(p.outcome);
      const nota = texto(p.cancel_reason);
      return {
        titulo: "Fluxo concluído",
        detalhe: desfecho ? (DESFECHO[desfecho] ?? desfecho) : nota,
        ...motor,
      };
    }
    case "flow_dead":
      return { titulo: "O fluxo parou de tentar", detalhe: texto(p.reason), ...motor };
    case "node_failed":
      return { titulo: "Falhou neste passo", detalhe: texto(p.error), ...motor };
    case "inbound_woke":
      return { titulo: "O cliente respondeu — o fluxo acordou na hora", detalhe: null, ...cliente };
    case "reactivity_replied":
      return { titulo: "Encerrado porque o cliente respondeu", detalhe: null, ...cliente };
    case "reactivity_opted_out":
      return { titulo: "Encerrado porque o cliente pediu para parar", detalhe: null, ...cliente };
    case "reactivity_handoff_cancel":
      return { titulo: "Encerrado porque uma pessoa assumiu a conversa", detalhe: null, ...pessoa };
    case "handoff_paused":
      return { titulo: "Pausado porque uma pessoa assumiu a conversa", detalhe: null, ...pessoa };
    case "handoff_resumed":
      return { titulo: "Retomado: o atendimento voltou para o agente", detalhe: null, ...motor };
    case "timing_plan_decidido": {
      const quantas = Object.keys((p.esperas as Record<string, unknown> | undefined) ?? {}).length;
      return {
        titulo: "O agente decidiu quanto esperar em cada passo",
        detalhe: quantas > 0 ? `${quantas} ${quantas === 1 ? "espera planejada" : "esperas planejadas"}` : null,
        ...motor,
      };
    }
    case "timing_plan_desistido":
      // Seguir sem plano é um FATO, não a ausência de um: cada espera cai no
      // máximo, e quem lê o dossiê precisa saber por que o fluxo ficou lento.
      return {
        titulo: "Seguiu sem o plano de tempo",
        detalhe: "o agente não respondeu a tempo; cada espera usa o máximo configurado",
        ...motor,
      };
    case "cancelled_manual":
      return { titulo: "Cancelado por uma pessoa da equipe", detalhe: null, ...pessoa };
    case "paused_manual":
      return { titulo: "Pausado por uma pessoa da equipe", detalhe: texto(p.motivo), ...pessoa };
    case "resumed_manual": {
      const volta = quandoLegivel(p.next_eval_at);
      return { titulo: "Retomado por uma pessoa da equipe", detalhe: volta ? `volta a andar em ${volta}` : null, ...pessoa };
    }
    case "snoozed_manual": {
      const para = quandoLegivel(p.next_eval_at);
      return { titulo: "Adiado por uma pessoa da equipe", detalhe: para ? `adiado para ${para}` : null, ...pessoa };
    }
    case "skipped_manual":
      return {
        titulo: "Passo pulado por uma pessoa da equipe",
        detalhe: `seguiu para ${refDoNo(texto(p.next_node_id), nos)}`,
        ...pessoa,
      };
    // ── POR QUE ESTE CONTATO ESTÁ AQUI ────────────────────────────────────
    // As linhas de PROVENIÊNCIA são a primeira coisa que o operador procura ao
    // abrir um dossiê, e as três abaixo caíam no `default` — apareciam como
    // "Passo registrado pelo motor, código: enrolled_by_stage_change". O dado
    // existia e a tela mostrava o nome da variável.
    case "enrolled_by_stage_change":
      return {
        titulo: "Começou porque o negócio entrou numa etapa",
        detalhe: "a etapa escolhida no gatilho deste fluxo",
        ...motor,
      };
    case "enrolled_by_case_opened":
      return {
        titulo: "Começou porque o agente pediu ajuda de um humano",
        // `source` separa o caso que o agente DECIDIU abrir daquele que uma
        // trava do sistema abriu sozinha. São situações diferentes para quem
        // vai atender, e a distinção não existe em nenhum outro lugar da tela.
        detalhe:
          texto(p.source) === "guardrail_autofallback"
            ? "o caso foi aberto por uma trava de segurança, não por decisão do agente"
            : "o agente abriu um caso de atendimento",
        ...motor,
      };
    case "cancelled_by_case_closed":
      return {
        titulo: "Cancelado porque o caso foi resolvido",
        detalhe: "o follow-up existia para esse caso e parou junto com ele",
        ...motor,
      };
    default:
      return { titulo: "Passo registrado pelo motor", detalhe: `código: ${evento.event_type}`, ...motor };
  }
}
