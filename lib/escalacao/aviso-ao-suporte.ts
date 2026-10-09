/**
 * O WHATSAPP DA EQUIPE É AVISADO QUANDO A IA ABRE UM CASO.
 *
 * ## O que este arquivo é
 *
 * A REGRA do consumidor de `ai.case_opened` / `ai.case_closed`, pura e testável
 * com relógio, banco e transporte falsos. O adapter de produção mora no fim, e
 * a ligação com o dispatcher em `./aviso-ao-suporte.handler.ts` — mesmo desenho
 * de `lib/followup/gatilho-caso.ts`.
 *
 * ## UM HANDLER PARA OS DOIS EVENTOS, e não dois
 *
 * Quem cria precisa saber cancelar. Um caso pode abrir às 23h e ser resolvido
 * às 23h05 — se a entrega estivesse represada por espaçamento, a equipe
 * receberia depois um aviso sobre algo já resolvido. `ai.case_closed` cancela a
 * entrega `pendente` e a rodada seguinte a encontra resolvida.
 *
 * ## ⚠️ A JANELA DE HORÁRIO NÃO SE APLICA AQUI — decisão do dono do produto
 *
 * O motor anti-ban tem janela horária (7h-22h no fuso do tenant), e todo envio
 * do produto a respeita. Este NÃO: **a janela protege o CLIENTE de receber
 * mensagem fora de hora; a equipe de suporte é interna e pediu para ser avisada
 * NA HORA.** Um caso que abre às 23h é justamente o que mais precisa de aviso, e
 * represá-lo até as 7h entrega um recado sobre alguém que já esperou oito horas.
 *
 * O que CONTINUA valendo do anti-ban é o resto, e não é detalhe: o espaçamento
 * entre mensagens do mesmo número e o teto diário do warm-up. Eles não são
 * cortesia com o destinatário — são o que impede o número de ser banido, e um
 * número banido leva junto o atendimento de todos os clientes daquela
 * organização. O aviso também CONTA no `pacing_ledger` pelo mesmo motivo: ele
 * gastou uma mensagem daquele número.
 *
 * ## NENHUM DESFECHO É `error`. Nunca.
 *
 * `lib/event-log/drain.ts` incrementa `attempts` quando um handler devolve
 * `error` e, na 5ª, mata o evento e abre um aviso de evento morto. Como a
 * instalação TÍPICA não tem aviso configurado, um `error` em "sem configuração"
 * faria todo caso aberto de toda organização virar cinco tentativas e um evento
 * morto — e deixaria vermelhos os três e2e que exigem `failed + dead === 0`.
 *
 * `skipped` conta como sucesso e PRESERVA o `detail` na linha do `event_log`
 * (o `ok` o descarta), e é esse detalhe que responde depois "por que não saiu".
 * Por isso só o envio de verdade devolve `ok`: ele é o único desfecho cujo
 * efeito está no mundo, e não numa linha do banco.
 *
 * ## E o handler NUNCA DORME
 *
 * Espaçamento e teto viram `retry_at`. O dreno leva 50 linhas por tick; uma
 * espera de 1,2 s por aviso atrasaria todo mundo atrás dele. O ramo de `retry`
 * do dreno grava `status:'pending'` + `next_attempt_at` e **não conta
 * tentativa** — é o mecanismo certo para adiamento benigno.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { canalDesativado } from "@/lib/channels/desativado";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import type { EventRow } from "@/lib/event-log/dispatcher";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

import { normalizaPatamaresDeTarefa, patamarDaEspera } from "./lembretes-tarefa";
import { montarAvisoDeCaso, montarLembreteDeCaso } from "./texto-do-aviso";
import { linkDoCaso, urlPublicaUsavel } from "./url-publica";
import {
  FRASE_DO_ERRO_DO_AVISO,
  type ErroDaEntregaDeAviso,
  type StatusDaEntregaDeAviso,
} from "./vocabulario-do-aviso";

/** Os dois eventos deste consumidor — os MESMOS literais de `gatilho-caso.ts`. */
export const EVENTO_CASO_ABERTO = "ai.case_opened";
export const EVENTO_CASO_FECHADO = "ai.case_closed";
export const EVENTO_LEMBRETE_DE_CASO = "ai.case_task_reminder_due";

/**
 * Teto de idade do EVENTO: 30 minutos.
 *
 * Metade do teto do gatilho de follow-up (60 min), e a diferença é o propósito:
 * um follow-up velho ainda cumpre a função; um AVISO velho é ruído. Se a imagem
 * subir depois de um acúmulo de `pending` — cenário real neste produto, onde o
 * deploy publica código sem gate de schema —, o primeiro dreno mandaria de uma
 * vez os avisos de todos os casos das últimas horas, no celular de quem já viu
 * aqueles casos na tela.
 */
export const IDADE_MAXIMA_DO_EVENTO_MS = 30 * 60 * 1000;

/**
 * Validade da ENTREGA: 24 horas.
 *
 * É o backstop global. Uma entrega que não conseguiu sair em um dia inteiro não
 * vai sair — e o que precisa aparecer não é mais uma tentativa: é o item na
 * Central dizendo que aquele caso nunca foi avisado.
 */
export const VALIDADE_DA_ENTREGA_MS = 24 * 60 * 60 * 1000;

/**
 * Janela em que uma reivindicação recente é lida como "outro processo está
 * enviando agora".
 *
 * Existe para o caso caro: o processo morreu ENTRE o transporte e a gravação do
 * `enviado`, e a mensagem já está no celular de alguém. Reenviar é o desfecho
 * caro (a equipe aprende a ignorar um canal que repete); esperar é o barato.
 */
export const JANELA_DE_REIVINDICACAO_MS = 2 * 60 * 1000;

/** Tentativas de canal fora do ar antes de desistir. ~30 min de indisponibilidade. */
export const TETO_DE_TENTATIVAS_DO_CANAL = 6;
/** Tentativas com o transporte recusando o envio antes de desistir. */
export const TETO_DE_TENTATIVAS_DE_ENVIO = 3;
/**
 * Teto ABSOLUTO — a rede embaixo de todas as outras.
 *
 * Uma entrega que chegou aqui foi retomada dez vezes sem que nenhum ramo
 * específico a tenha condenado. `indeterminado` é a resposta honesta: o sistema
 * não sabe por quê, e dizer isso é melhor que escolher um código bonito.
 */
export const TETO_ABSOLUTO_DE_TENTATIVAS = 10;

/** Adiamento quando o dreno está rodando DENTRO de uma requisição HTTP. */
export const ADIAMENTO_DO_DRENO_EM_REQUEST_MS = 15 * 1000;
/** Adiamento enquanto o canal não volta. */
export const ADIAMENTO_DO_CANAL_MS = 5 * 60 * 1000;
/** Uma organização pausada preserva o evento; a próxima tentativa revalida o marco vigente. */
export const ADIAMENTO_DA_ORG_PAUSADA_MS = 5 * 60 * 1000;

/** As duas origens de caso que merecem aviso. */
const ORIGENS_ACEITAS = new Set(["agent", "guardrail_autofallback"]);
/** Os dois estados em que o caso ainda espera alguém. */
const STATUS_ABERTOS = new Set(["awaiting_human", "awaiting_lead"]);

export interface ConfigDoAviso {
  organization_id: string;
  channel_session_id: string | null;
  telefone_destino: string;
  destino_jid: string | null;
  ligado: boolean;
  sem_link?: boolean;
  repetir_lembretes_whatsapp?: boolean;
  minutos_lembrete_equipe?: number[] | null;
}

export interface CasoDoAviso {
  id: string;
  organization_id: string;
  conversation_id: string | null;
  kind: string | null;
  source: string | null;
  status: string;
  title: string | null;
  summary: string | null;
  blocker: string | null;
  task_kind?: string | null;
  task_state?: string | null;
  wait_generation?: number | null;
  wait_started_at?: string | null;
}

export interface EntregaDoAviso {
  id: string;
  organization_id: string;
  case_id: string;
  destino: string;
  status: StatusDaEntregaDeAviso | string;
  tentativas: number;
  created_at: string;
  updated_at: string;
  wait_generation?: number | null;
  reminder_minute?: number | null;
  channel_session_id?: string | null;
}

export interface CanalDoAviso {
  id: string;
  status: string;
  archived_at: string | null;
  /** CAPACIDADE, nunca o nome do provedor — quem resolve é `lib/channels/`. */
  aceitaMensagemLivre: boolean;
  /** Pausado pelo operador (`metadata.disabled`). Ausente = ligado, a leitura estrita de `canalDesativado`. */
  desativado?: boolean;
}

export interface PatchDaEntrega {
  status?: StatusDaEntregaDeAviso;
  tentativas?: number;
  erro_codigo?: ErroDaEntregaDeAviso | null;
  erro_detalhe?: string | null;
  channel_session_id?: string | null;
  external_id?: string | null;
  corpo_hash?: string | null;
  enviado_em?: string | null;
}

export interface AvisoDb {
  carregaConfig(orgId: string): Promise<ConfigDoAviso | null>;
  carregaCaso(orgId: string, caseId: string): Promise<CasoDoAviso | null>;
  contatoAnonimizado(orgId: string, contactId: string): Promise<boolean>;
  /** INSERT com a `unique`; `criada:false` = outro processo chegou primeiro. */
  reivindicaEntrega(entrada: {
    organizationId: string;
    caseId: string;
    destino: string;
    channelSessionId: string | null;
    waitGeneration?: number | null;
    reminderMinute?: number | null;
  }): Promise<{ criada: boolean; entrega: EntregaDoAviso | null }>;
  atualizaEntrega(orgId: string, entregaId: string, patch: PatchDaEntrega): Promise<void>;
  /** Devolve quantas entregas `pendente` daquele caso viraram `cancelado`. */
  cancelaPendentesDoCaso(orgId: string, caseId: string): Promise<number>;
  /** Cancela recibos antigos do mesmo marco que ficaram pendentes após troca do destino. */
  cancelaPendentesDeLembreteComOutroDestino(
    orgId: string,
    caseId: string,
    waitGeneration: number,
    minute: number,
    destinoAtual: string,
  ): Promise<number>;
  /** Cancela só recibos pendentes do marco validado, sempre no escopo da org/caso/geração/minuto. */
  cancelaEntregaPendenteDoLembrete(
    orgId: string,
    caseId: string,
    waitGeneration: number,
    minute: number,
  ): Promise<number>;
  carregaCanal(orgId: string, channelSessionId: string): Promise<CanalDoAviso | null>;
  /** Confere o vínculo durável evento ↔ marco do relógio, sempre dentro da org. */
  carregaLembreteWhatsApp?(
    orgId: string,
    caseId: string,
    waitGeneration: number,
    minute: number,
    eventId: string,
  ): Promise<boolean>;
  /** Status atual da organização, espelho da régua `fn_org_operante`. */
  organizacaoOperante?(orgId: string): Promise<boolean>;
  /**
   * O número de destino é de uma conexão ATIVA desta organização AGORA?
   *
   * Não é um campo de `CanalDoAviso`: a pergunta é sobre o NÚMERO, não sobre a
   * conexão que envia, e a resposta pode mudar entre definir o aviso e enviá-lo
   * — é exatamente essa janela que ela fecha. Quem responde é uma consulta a
   * `channel_sessions`, a MESMA que `fn_definir_aviso_de_caso` faz.
   */
  destinoEhDaPropriaOrganizacao(orgId: string, telefone: string): Promise<boolean>;
  avisaNaCentral(entrada: {
    organizationId: string;
    caseId: string;
    titulo: string;
    corpo: string;
  }): Promise<void>;
  registraEventoDoCaso(entrada: {
    organizationId: string;
    caseId: string;
    kind: "alert_sent";
    actorKind: "system";
    metadata: Record<string, unknown>;
  }): Promise<void>;
  registraJidDoAviso(orgId: string, jid: string): Promise<void>;
  nomeDoContato(orgId: string, contactId: string): Promise<string | null>;
  marcaDaOrganizacao(orgId: string): Promise<{ nome: string; idioma: Idioma }>;
}

/**
 * A porta do transporte — três perguntas, nenhuma delas "qual provedor é este?".
 *
 * `organizationId` é OBRIGATÓRIO em todas: `sessionRef` sozinho não identifica
 * uma linha (ele é um identificador do PROVIDER, e nada impede duas
 * organizações de terem o mesmo). Quem resolvia credencial só por ele fazia a
 * mensagem sair pela conta do `.env` em vez da conta da organização — issue
 * #236. O valor vem da linha do `event_log`, que é fonte confiável.
 *
 * As três são `async` porque a implementação de produção precisa ler a linha do
 * canal para saber por onde falar, e um contrato síncrono forçaria essa leitura
 * para dentro do chamador — que é exatamente o lugar que não pode conhecer
 * provedor.
 */
export interface TransporteDoAviso {
  configurado(organizationId: string, canal: CanalDoAviso): Promise<boolean>;
  /** `null` = não há endereço possível para este número neste canal. */
  resolveDestino(
    organizationId: string,
    canal: CanalDoAviso,
    telefone: string,
  ): Promise<string | null>;
  envia(
    organizationId: string,
    canal: CanalDoAviso,
    to: string,
    body: string,
  ): Promise<{ externalId: string | null }>;
}

export type DecisaoDePacing =
  { liberado: true } | { liberado: false; motivo: "espacamento" | "teto_diario"; liberaEm: Date };

export interface PacingDoAviso {
  decide(orgId: string, channelSessionId: string, agora: Date): Promise<DecisaoDePacing>;
  registraEnvio(orgId: string, channelSessionId: string, quando: Date): Promise<void>;
}

export interface AvisoDeps {
  db: AvisoDb;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock: () => Date;
  /**
   * `env.NEXT_PUBLIC_APP_URL` já LIDO pelo chamador. O módulo não importa
   * `@/lib/env` no topo de propósito: ele valida o ambiente ao carregar e
   * lança, e um teste puro deste arquivo morreria antes da primeira asserção.
   */
  urlPublica: string;
  origemDoDreno: () => "worker" | "request";
  /** Fire-and-forget: auditar nunca pode segurar o aviso. */
  audita: (entrada: {
    action: "ai.case_alert_sent" | "ai.case_alert_failed";
    organizationId: string;
    caseId: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export interface DesfechoDoAviso {
  /** NUNCA `error` — ver o cabeçalho. */
  status: "ok" | "skipped" | "retry";
  detail: string;
  retry_at?: string;
}

function skipped(detail: string): DesfechoDoAviso {
  return { status: "skipped", detail };
}
function retry(quando: Date, detail: string): DesfechoDoAviso {
  return { status: "retry", detail, retry_at: quando.toISOString() };
}
function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * `true` quando dá para AFIRMAR que o evento passou do teto.
 *
 * Sem `created_at` devolve `false` — falhar ABERTO na informação: sem a idade
 * não dá para dizer que o evento é velho, e descartar na dúvida perderia um
 * aviso bom. `EventRow.created_at` é opcional porque dezenas de arquivos montam
 * fixtures; o caminho de produção sempre o traz.
 */
function passouDoTeto(row: EventRow, agora: Date): boolean {
  if (!row.created_at) return false;
  const emitido = Date.parse(row.created_at);
  if (Number.isNaN(emitido)) return false;
  return agora.getTime() - emitido > IDADE_MAXIMA_DO_EVENTO_MS;
}

/** A frase de gente do erro, para o corpo do item da Central. */
function fraseDoErro(codigo: ErroDaEntregaDeAviso): string {
  return FRASE_DO_ERRO_DO_AVISO[codigo];
}

/**
 * Aplica UMA linha de `ai.case_opened` ou `ai.case_closed`.
 *
 * A ordem dos passos não é estética: cada um só roda depois do que pode
 * dispensá-lo, e o mais barato vem primeiro. O caminho de TODA instalação que
 * nunca ligou o aviso termina no passo 2, com duas leituras e zero rede.
 */
export async function aplicaAvisoDeCaso(deps: AvisoDeps, row: EventRow): Promise<DesfechoDoAviso> {
  const agora = deps.clock();
  const orgId = row.organization_id;
  const caseId = textoOuNulo(row.payload.case_id);

  // ── O laço fecha: caso fechado cancela o que estava represado ────────────
  if (row.event_type === EVENTO_CASO_FECHADO) {
    if (!caseId) return skipped("payload_incompleto");
    const canceladas = await deps.db.cancelaPendentesDoCaso(orgId, caseId);
    return canceladas > 0
      ? { status: "ok", detail: `cancelado=${canceladas}` }
      : skipped("nada_pendente");
  }
  if (row.event_type === EVENTO_LEMBRETE_DE_CASO) {
    return aplicaLembreteDeCaso(deps, row, agora);
  }
  if (row.event_type !== EVENTO_CASO_ABERTO) return skipped("evento_ignorado");

  // A pausa suspende o aviso de abertura para sempre (como os demais efeitos
  // externos), mas o consumidor roda para poder preservar lembretes pendentes.
  if (deps.db.organizacaoOperante && !(await deps.db.organizacaoOperante(orgId))) {
    return skipped("org_nao_operante");
  }

  // ── 0. Dreno DENTRO da requisição: adia sem tocar a rede ─────────────────
  //
  // O atalho de desenvolvimento (`acelerarPipelineDeEventos`) roda o dreno
  // dentro do webhook de mensagem, para o follow-up não esperar o relógio. Uma
  // chamada de rede a terceiro ali soma ao tempo de resposta do webhook do
  // WhatsApp — que tem timeout e reentrega. `retry` mantém a linha `pending` e
  // NÃO conta tentativa; "não despachar" a deixaria ser marcada `done` pelos
  // outros handlers do mesmo tick.
  if (deps.origemDoDreno() === "request") {
    return retry(
      new Date(agora.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS),
      "adiado: dreno dentro do webhook",
    );
  }

  // ── 1. O evento descreve o fato que este consumidor espera? ──────────────
  if (!caseId) return skipped("payload_incompleto");

  // ── 2. Configuração — o caminho de toda instalação que nunca ligou ───────
  const cfg = await deps.db.carregaConfig(orgId);
  if (!cfg || !cfg.ligado || !cfg.channel_session_id) return skipped("sem_configuracao");
  const channelSessionId = cfg.channel_session_id;

  // ── 3. Teto de idade do EVENTO ───────────────────────────────────────────
  if (passouDoTeto(row, agora)) return skipped("evento_velho");

  // ── 4. O caso ainda merece aviso? ────────────────────────────────────────
  const caso = await deps.db.carregaCaso(orgId, caseId);
  if (!caso) return skipped("caso_inexistente");
  if (!ORIGENS_ACEITAS.has(caso.source ?? "")) return skipped(`origem_nao_aceita:${caso.source}`);
  if (!STATUS_ABERTOS.has(caso.status)) return skipped(`caso_fechado:${caso.status}`);

  // ── 5. REIVINDICA antes de tocar a rede ──────────────────────────────────
  const { criada, entrega } = await deps.db.reivindicaEntrega({
    organizationId: orgId,
    caseId,
    destino: cfg.telefone_destino,
    channelSessionId,
  });
  if (!entrega) return skipped("reivindicacao_sem_linha");

  if (!criada) {
    // O `23505` chegou: outro processo já tem esta entrega.
    if (entrega.status !== "pendente") return skipped(`ja_resolvido:${entrega.status}`);
    if (entrega.tentativas >= TETO_ABSOLUTO_DE_TENTATIVAS) {
      return await condena(deps, orgId, caso, entrega, "indeterminado", null, agora);
    }
    const desdeOToque = agora.getTime() - Date.parse(entrega.updated_at);
    if (desdeOToque >= 0 && desdeOToque < JANELA_DE_REIVINDICACAO_MS) {
      return retry(
        new Date(agora.getTime() + JANELA_DE_REIVINDICACAO_MS),
        "outra rodada está enviando este aviso",
      );
    }
  }

  // ── 6. Validade da entrega ───────────────────────────────────────────────
  const idadeDaEntrega = agora.getTime() - Date.parse(entrega.created_at);
  if (Number.isFinite(idadeDaEntrega) && idadeDaEntrega > VALIDADE_DA_ENTREGA_MS) {
    return await condena(deps, orgId, caso, entrega, "expirou", null, agora, "cancelado");
  }

  // ── 7. O titular pediu para ser esquecido ────────────────────────────────
  //
  // Vem DEPOIS da reivindicação de propósito: o cancelamento precisa de uma
  // linha para morar. Sem item na Central — não há nada a fazer, e um aviso
  // pedindo ação sobre um contato anonimizado convidaria alguém a procurá-lo.
  const contactId = textoOuNulo(row.payload.contact_id);
  if (contactId && (await deps.db.contatoAnonimizado(orgId, contactId))) {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      status: "cancelado",
      erro_codigo: "titular_anonimizado",
    });
    return skipped("titular_anonimizado");
  }

  const tentativas = entrega.tentativas + 1;

  // ── 8. O canal ───────────────────────────────────────────────────────────
  const canal = await deps.db.carregaCanal(orgId, channelSessionId);
  if (!canal || canal.archived_at) {
    return await condena(deps, orgId, caso, entrega, "canal_arquivado", null, agora);
  }
  // Pausado não é `canal_desconectado`: esperar não resolve, só o operador retomando.
  if (canal.desativado) {
    return await condena(deps, orgId, caso, entrega, "canal_desativado", null, agora);
  }
  if (!canal.aceitaMensagemLivre) {
    return await condena(deps, orgId, caso, entrega, "canal_nao_aceita_aviso_livre", null, agora);
  }
  if (canal.status !== "WORKING") {
    if (tentativas >= TETO_DE_TENTATIVAS_DO_CANAL) {
      return await condena(deps, orgId, caso, entrega, "canal_desconectado", canal.status, agora);
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "canal_desconectado",
    });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), `canal ${canal.status}`);
  }

  // ── 9. O link precisa abrir no celular de outra pessoa ───────────────────
  if (!cfg.sem_link && !urlPublicaUsavel(deps.urlPublica)) {
    return await condena(deps, orgId, caso, entrega, "sem_endereco_publico", null, agora);
  }

  // ── 10. O transporte desta instalação está de pé? ────────────────────────
  if (!(await deps.transporte.configurado(orgId, canal))) {
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) {
      return await condena(deps, orgId, caso, entrega, "transporte_ausente", null, agora);
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "transporte_ausente",
    });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte fora do ar");
  }

  // ── 11. Espaçamento e teto diário — SEM a janela de horário ──────────────
  const pacing = await deps.pacing.decide(orgId, channelSessionId, agora);
  if (!pacing.liberado) {
    // O teto diário grava o código PRÓPRIO: sem ele, um número em warm-up (cap
    // de 20/dia) veria os avisos expirarem como `expirou` genérico, mandando
    // quem investiga procurar defeito onde há regra.
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      erro_codigo: pacing.motivo === "teto_diario" ? "teto_diario_do_numero" : null,
    });
    return retry(pacing.liberaEm, `pacing:${pacing.motivo}`);
  }

  // ── 11b. O destino ainda é de fora? ──────────────────────────────────────
  //
  // `fn_definir_aviso_de_caso` recusa um número de conexão DA PRÓPRIA
  // ORGANIZAÇÃO — é o laço robô-com-robô. Essa pergunta acontece só ao DEFINIR,
  // e a 0438 passou a ignorar a conexão ARQUIVADA (ela não envia e não recebe,
  // então não fechava laço nenhum). Só que arquivar não apaga a linha: reativar
  // é gravar `archived_at = null` de novo. Se o número daquela conexão já
  // estava gravado como destino e a conexão voltar, nenhuma checagem roda outra
  // vez — e o aviso sai para um número atendido por um agente desta organização.
  //
  // Por isso a pergunta é repetida AQUI, no envio: é a única hora em que se sabe
  // que a conexão está ativa AGORA, e é um lugar só para todos os caminhos de
  // volta (canal oficial, pareamento do onboarding, conclusão do pareamento
  // por QR) em vez de uma guarda por caminho — a próxima forma de reativar
  // nasceria sem ela.
  if (await deps.db.destinoEhDaPropriaOrganizacao(orgId, cfg.telefone_destino)) {
    return await condena(deps, orgId, caso, entrega, "destino_da_propria_organizacao", null, agora);
  }

  // ── 12. O destino ────────────────────────────────────────────────────────
  const to = await deps.transporte.resolveDestino(orgId, canal, cfg.telefone_destino);
  if (!to) {
    return await condena(deps, orgId, caso, entrega, "destino_invalido", null, agora);
  }

  // ── 13. O texto ──────────────────────────────────────────────────────────
  const marca = await deps.db.marcaDaOrganizacao(orgId);
  const nome = contactId ? await deps.db.nomeDoContato(orgId, contactId) : null;
  const body = montarAvisoDeCaso({
    marca: marca.nome,
    idioma: marca.idioma,
    kind: caso.kind,
    source: caso.source,
    title: caso.title,
    summary: caso.summary,
    blocker: caso.blocker,
    nomeDoCliente: nome,
    link: cfg.sem_link ? null : linkDoCaso(deps.urlPublica, caso.id),
    referencia: caso.id.slice(0, 8),
  });

  // ── 14. O transporte ─────────────────────────────────────────────────────
  let externalId: string | null = null;
  try {
    const resposta = await deps.transporte.envia(orgId, canal, to, body);
    externalId = resposta.externalId;
  } catch (err) {
    const causa = err instanceof Error ? err.message : String(err);
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) {
      return await condena(deps, orgId, caso, entrega, "falha_no_envio", causa, agora);
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "falha_no_envio",
      erro_detalhe: causa.slice(0, 300),
    });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "envio recusado");
  }

  // ── 15. Saiu ─────────────────────────────────────────────────────────────
  //
  // Daqui para baixo TUDO falha ABERTO: a mensagem já está no celular de
  // alguém, e derrubar o handler depois do envio produziria aviso em dobro na
  // rodada seguinte. Cada passo que falhar vira log, nunca exceção.
  await deps.db.atualizaEntrega(orgId, entrega.id, {
    status: "enviado",
    tentativas,
    erro_codigo: null,
    erro_detalhe: null,
    external_id: externalId,
    // O TEXTO NUNCA É GUARDADO — só o resumo criptográfico dele.
    corpo_hash: createHash("sha256").update(body).digest("hex"),
    enviado_em: agora.toISOString(),
  });

  await depoisDoEnvio(deps, orgId, channelSessionId, caso, entrega, to, agora);

  deps.audita({
    action: "ai.case_alert_sent",
    organizationId: orgId,
    caseId: caso.id,
    metadata: {
      entrega_id: entrega.id,
      canal: channelSessionId,
      tentativas,
      aceito_pelo_transporte: true,
      confirmacao_final_de_entrega: false,
    },
  });

  return {
    status: "ok",
    detail: `aceito_pelo_transporte_sem_confirmacao_final canal=${channelSessionId} tentativas=${tentativas}`,
  };
}

type MinutoDoLembrete = number;

interface ContextoDoLembrete {
  config: ConfigDoAviso;
  caso: CasoDoAviso;
  canal: CanalDoAviso;
}

function minutoDoPayload(value: unknown): MinutoDoLembrete | null {
  const minuto = numeroDoPayload(value);
  return minuto !== null && minuto >= 1 && minuto <= 1440 ? minuto : null;
}

function numeroDoPayload(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) {
    return null;
  }
  const numero = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numero) && numero >= 0 ? numero : null;
}

function casoAindaAguarda(
  caso: CasoDoAviso | null,
  orgId: string,
  caseId: string,
): caso is CasoDoAviso {
  return Boolean(
    caso &&
    caso.id === caseId &&
    caso.organization_id === orgId &&
    ((caso.task_kind === null && caso.task_state === null && caso.status === "awaiting_human") ||
      (STATUS_ABERTOS.has(caso.status) &&
        (caso.task_kind === "payment_details" || caso.task_kind === "payment_review") &&
        (caso.task_state === "awaiting_human" || caso.task_state === "send_failed"))),
  );
}

function mesmaConfigDeLembrete(
  atual: ConfigDoAviso | null,
  inicial: ConfigDoAviso,
): atual is ConfigDoAviso {
  return Boolean(
    atual &&
    atual.repetir_lembretes_whatsapp === true &&
    atual.channel_session_id === inicial.channel_session_id &&
    atual.telefone_destino === inicial.telefone_destino &&
    JSON.stringify(normalizaPatamaresDeTarefa(atual.minutos_lembrete_equipe)) ===
      JSON.stringify(normalizaPatamaresDeTarefa(inicial.minutos_lembrete_equipe)),
  );
}

function patamaresDaConfig(config: ConfigDoAviso): number[] {
  return normalizaPatamaresDeTarefa(config.minutos_lembrete_equipe);
}

/** Todas as leituras são org-scoped e repetidas imediatamente antes do envio. */
async function carregaContextoDoLembrete(
  deps: AvisoDeps,
  entrada: {
    orgId: string;
    caseId: string;
    waitGeneration: number;
    minute: MinutoDoLembrete;
    eventId: string;
    configInicial: ConfigDoAviso;
    agora: Date;
  },
): Promise<{ contexto: ContextoDoLembrete | null; motivo: string }> {
  const { db } = deps;
  if (!db.organizacaoOperante || !(await db.organizacaoOperante(entrada.orgId))) {
    return { contexto: null, motivo: "organizacao_nao_operante" };
  }

  const config = await db.carregaConfig(entrada.orgId);
  if (!config || config.repetir_lembretes_whatsapp !== true || !config.channel_session_id) {
    return { contexto: null, motivo: "sem_opt_in_de_lembretes" };
  }
  if (!mesmaConfigDeLembrete(config, entrada.configInicial)) {
    return { contexto: null, motivo: "configuracao_alterada" };
  }
  const patamares = patamaresDaConfig(config);
  if (!patamares.includes(entrada.minute)) {
    return { contexto: null, motivo: "marco_removido_da_cadencia" };
  }

  if (
    !db.carregaLembreteWhatsApp ||
    !(await db.carregaLembreteWhatsApp(
      entrada.orgId,
      entrada.caseId,
      entrada.waitGeneration,
      entrada.minute,
      entrada.eventId,
    ))
  ) {
    return { contexto: null, motivo: "evento_sem_vinculo_duravel" };
  }

  const caso = await db.carregaCaso(entrada.orgId, entrada.caseId);
  if (!casoAindaAguarda(caso, entrada.orgId, entrada.caseId)) {
    return { contexto: null, motivo: "caso_saiu_da_espera" };
  }
  if (caso.wait_generation !== entrada.waitGeneration) {
    return { contexto: null, motivo: "geracao_antiga" };
  }
  if (
    !caso.wait_started_at ||
    patamarDaEspera(caso.wait_started_at, entrada.agora, patamares) !== entrada.minute
  ) {
    return { contexto: null, motivo: "marco_ultrapassado_ou_ainda_nao_devido" };
  }

  const canal = await db.carregaCanal(entrada.orgId, config.channel_session_id);
  if (!canal || canal.archived_at || !canal.aceitaMensagemLivre) {
    return { contexto: null, motivo: "canal_nao_disponivel" };
  }
  return { contexto: { config, caso, canal }, motivo: "" };
}

async function cancelaLembrete(
  deps: AvisoDeps,
  orgId: string,
  caseId: string,
  waitGeneration: number,
  minute: MinutoDoLembrete,
  motivo: string,
): Promise<DesfechoDoAviso> {
  await deps.db.cancelaEntregaPendenteDoLembrete(orgId, caseId, waitGeneration, minute);
  return skipped(motivo);
}

/**
 * Reage a uma mudança ocorrida entre a leitura e o envio. Pausa preserva o evento;
 * mudança ativa de destino/canal remarca com a configuração vigente, sem perder a
 * única linha do event_log. Opt-out, tarefa encerrada e patamar removido encerram.
 */
async function reagendaOuEncerraLembrete(
  deps: AvisoDeps,
  entrada: {
    orgId: string;
    caseId: string;
    waitGeneration: number;
    minute: MinutoDoLembrete;
    motivo: string;
    agora: Date;
    entrega: EntregaDoAviso | null;
  },
): Promise<DesfechoDoAviso | null> {
  if (entrada.motivo === "organizacao_nao_operante") {
    return retry(
      new Date(entrada.agora.getTime() + ADIAMENTO_DA_ORG_PAUSADA_MS),
      "organizacao_pausada; lembrete preservado para revalidacao",
    );
  }

  if (entrada.motivo === "configuracao_alterada") {
    const configAtual = await deps.db.carregaConfig(entrada.orgId);
    if (configAtual?.repetir_lembretes_whatsapp === true && configAtual.channel_session_id) {
      const entrega = entrada.entrega;
      if (entrega?.status === "pendente") {
        if (entrega.destino !== configAtual.telefone_destino) {
          await deps.db.cancelaEntregaPendenteDoLembrete(
            entrada.orgId,
            entrada.caseId,
            entrada.waitGeneration,
            entrada.minute,
          );
        } else if (entrega.channel_session_id !== configAtual.channel_session_id) {
          // Mesmo destino e mesma pendência: alinhar o recibo antes de retry para
          // que o histórico identifique o canal que de fato fará a próxima tentativa.
          await deps.db.atualizaEntrega(entrada.orgId, entrega.id, {
            channel_session_id: configAtual.channel_session_id,
          });
        }
      }
      return retry(
        new Date(entrada.agora.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS),
        "configuracao_alterada; tentativa retomara com o destino vigente",
      );
    }
    return await cancelaLembrete(
      deps,
      entrada.orgId,
      entrada.caseId,
      entrada.waitGeneration,
      entrada.minute,
      "sem_opt_in_de_lembretes",
    );
  }
  return null;
}

/**
 * Envia um marco do relógio humano. O corpo não lê título, resumo, nome ou
 * conteúdo do cliente; cada marco tem recibo próprio por org/caso/geração/minuto/destino.
 */
async function aplicaLembreteDeCaso(
  deps: AvisoDeps,
  row: EventRow,
  agoraInicial: Date,
): Promise<DesfechoDoAviso> {
  const orgId = row.organization_id;
  const caseId = textoOuNulo(row.payload.case_id);
  const waitGeneration = numeroDoPayload(row.payload.wait_generation);
  const minute = minutoDoPayload(row.payload.minute);
  if (!caseId || waitGeneration === null || minute === null) return skipped("payload_incompleto");
  if (row.entity_id && row.entity_id !== caseId) return skipped("caso_do_evento_divergente");
  // O dreno inline compartilha o webhook inbound: nunca segura essa resposta
  // esperando pacing ou transporte externo.
  if (deps.origemDoDreno() === "request") {
    return retry(
      new Date(agoraInicial.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS),
      "adiado: dreno dentro do webhook",
    );
  }

  if (
    !deps.db.carregaLembreteWhatsApp ||
    !deps.db.organizacaoOperante ||
    !deps.db.cancelaEntregaPendenteDoLembrete ||
    !deps.db.cancelaPendentesDeLembreteComOutroDestino
  ) {
    return skipped("contrato_de_lembrete_indisponivel");
  }
  if (!(await deps.db.carregaLembreteWhatsApp(orgId, caseId, waitGeneration, minute, row.id))) {
    return skipped("evento_sem_vinculo_duravel");
  }
  if (!(await deps.db.organizacaoOperante(orgId))) {
    return retry(
      new Date(agoraInicial.getTime() + ADIAMENTO_DA_ORG_PAUSADA_MS),
      "organizacao_pausada; lembrete preservado para revalidacao",
    );
  }

  const config = await deps.db.carregaConfig(orgId);
  if (!config || config.repetir_lembretes_whatsapp !== true || !config.channel_session_id) {
    return await cancelaLembrete(
      deps,
      orgId,
      caseId,
      waitGeneration,
      minute,
      "sem_opt_in_de_lembretes",
    );
  }

  const contextoInicial = await carregaContextoDoLembrete(deps, {
    orgId,
    caseId,
    waitGeneration,
    minute,
    eventId: row.id,
    configInicial: config,
    agora: agoraInicial,
  });
  if (!contextoInicial.contexto) {
    const reagenda = await reagendaOuEncerraLembrete(deps, {
      orgId,
      caseId,
      waitGeneration,
      minute,
      motivo: contextoInicial.motivo,
      agora: agoraInicial,
      entrega: null,
    });
    if (reagenda) return reagenda;
    return await cancelaLembrete(
      deps,
      orgId,
      caseId,
      waitGeneration,
      minute,
      contextoInicial.motivo,
    );
  }

  await deps.db.cancelaPendentesDeLembreteComOutroDestino(
    orgId,
    caseId,
    waitGeneration,
    minute,
    config.telefone_destino,
  );

  const reivindicacao = await deps.db.reivindicaEntrega({
    organizationId: orgId,
    caseId,
    destino: config.telefone_destino,
    channelSessionId: config.channel_session_id,
    waitGeneration,
    reminderMinute: minute,
  });
  const criada = reivindicacao.criada;
  let entrega = reivindicacao.entrega;
  if (!entrega) return skipped("reivindicacao_sem_linha");
  if (entrega.status === "pendente" && entrega.channel_session_id !== config.channel_session_id) {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      channel_session_id: config.channel_session_id,
    });
    entrega = { ...entrega, channel_session_id: config.channel_session_id };
  }
  if (!criada) {
    if (entrega.status !== "pendente") return skipped(`ja_resolvido:${entrega.status}`);
    if (entrega.tentativas >= TETO_ABSOLUTO_DE_TENTATIVAS) {
      return await condena(
        deps,
        orgId,
        contextoInicial.contexto.caso,
        entrega,
        "indeterminado",
        null,
        agoraInicial,
      );
    }
    const desdeOToque = agoraInicial.getTime() - Date.parse(entrega.updated_at);
    if (desdeOToque >= 0 && desdeOToque < JANELA_DE_REIVINDICACAO_MS) {
      return retry(
        new Date(agoraInicial.getTime() + JANELA_DE_REIVINDICACAO_MS),
        "outra rodada está enviando este lembrete",
      );
    }
  }

  const idadeDaEntrega = agoraInicial.getTime() - Date.parse(entrega.created_at);
  if (Number.isFinite(idadeDaEntrega) && idadeDaEntrega > VALIDADE_DA_ENTREGA_MS) {
    return await condena(
      deps,
      orgId,
      contextoInicial.contexto.caso,
      entrega,
      "expirou",
      null,
      agoraInicial,
      "cancelado",
    );
  }

  const canal = contextoInicial.contexto.canal;
  const channelSessionId = config.channel_session_id;
  const tentativas = entrega.tentativas + 1;
  if (canal.status !== "WORKING") {
    if (tentativas >= TETO_DE_TENTATIVAS_DO_CANAL) {
      return await condena(
        deps,
        orgId,
        contextoInicial.contexto.caso,
        entrega,
        "canal_desconectado",
        canal.status,
        agoraInicial,
      );
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "canal_desconectado",
      erro_detalhe: null,
    });
    return retry(new Date(agoraInicial.getTime() + ADIAMENTO_DO_CANAL_MS), `canal ${canal.status}`);
  }

  if (!(await deps.transporte.configurado(orgId, canal))) {
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) {
      return await condena(
        deps,
        orgId,
        contextoInicial.contexto.caso,
        entrega,
        "transporte_ausente",
        null,
        agoraInicial,
      );
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "transporte_ausente",
      erro_detalhe: null,
    });
    return retry(new Date(agoraInicial.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte fora do ar");
  }

  const pacing = await deps.pacing.decide(orgId, channelSessionId, agoraInicial);
  if (!pacing.liberado) {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      erro_codigo: pacing.motivo === "teto_diario" ? "teto_diario_do_numero" : null,
      erro_detalhe: null,
    });
    return retry(pacing.liberaEm, `pacing:${pacing.motivo}`);
  }

  if (await deps.db.destinoEhDaPropriaOrganizacao(orgId, config.telefone_destino)) {
    return await condena(
      deps,
      orgId,
      contextoInicial.contexto.caso,
      entrega,
      "destino_da_propria_organizacao",
      null,
      agoraInicial,
    );
  }

  const to = await deps.transporte.resolveDestino(orgId, canal, config.telefone_destino);
  if (!to) {
    return await condena(
      deps,
      orgId,
      contextoInicial.contexto.caso,
      entrega,
      "destino_invalido",
      null,
      agoraInicial,
    );
  }

  const marca = await deps.db.marcaDaOrganizacao(orgId);
  const body = montarLembreteDeCaso({
    marca: marca.nome,
    idioma: marca.idioma,
    minute,
    referencia: caseId.slice(0, 8),
  });

  // Segunda leitura imediatamente antes da rede: o opt-in, a org, o caso,
  // a geração, o vínculo evento↔marco e o patamar podem ter mudado durante o pacing.
  const agoraEnvio = deps.clock();
  const contextoFinal = await carregaContextoDoLembrete(deps, {
    orgId,
    caseId,
    waitGeneration,
    minute,
    eventId: row.id,
    configInicial: config,
    agora: agoraEnvio,
  });
  if (!contextoFinal.contexto) {
    const reagenda = await reagendaOuEncerraLembrete(deps, {
      orgId,
      caseId,
      waitGeneration,
      minute,
      motivo: contextoFinal.motivo,
      agora: agoraEnvio,
      entrega,
    });
    if (reagenda) return reagenda;
    return await cancelaLembrete(deps, orgId, caseId, waitGeneration, minute, contextoFinal.motivo);
  }
  if (contextoFinal.contexto.canal.status !== "WORKING") {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "canal_desconectado",
      erro_detalhe: null,
    });
    return retry(
      new Date(agoraEnvio.getTime() + ADIAMENTO_DO_CANAL_MS),
      "canal desconectado antes do envio",
    );
  }
  if (
    await deps.db.destinoEhDaPropriaOrganizacao(
      orgId,
      contextoFinal.contexto.config.telefone_destino,
    )
  ) {
    return await condena(
      deps,
      orgId,
      contextoFinal.contexto.caso,
      entrega,
      "destino_da_propria_organizacao",
      null,
      agoraEnvio,
    );
  }
  const toAtual = await deps.transporte.resolveDestino(
    orgId,
    contextoFinal.contexto.canal,
    contextoFinal.contexto.config.telefone_destino,
  );
  if (!toAtual) {
    return await cancelaLembrete(
      deps,
      orgId,
      caseId,
      waitGeneration,
      minute,
      "destino_invalido_antes_do_envio",
    );
  }
  if (!(await deps.transporte.configurado(orgId, contextoFinal.contexto.canal))) {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "transporte_ausente",
      erro_detalhe: null,
    });
    return retry(new Date(agoraEnvio.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte fora do ar");
  }

  let externalId: string | null = null;
  try {
    const resposta = await deps.transporte.envia(
      orgId,
      contextoFinal.contexto.canal,
      toAtual,
      body,
    );
    externalId = resposta.externalId;
  } catch {
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) {
      return await condena(
        deps,
        orgId,
        contextoFinal.contexto.caso,
        entrega,
        "falha_no_envio",
        null,
        agoraEnvio,
      );
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      tentativas,
      erro_codigo: "falha_no_envio",
      // A resposta crua do transporte não é necessária para o retry e nunca
      // deve virar um lugar para ecoar conteúdo de atendimento.
      erro_detalhe: null,
    });
    return retry(
      new Date(agoraEnvio.getTime() + ADIAMENTO_DO_CANAL_MS),
      "resposta_do_transporte_ambigua; nova tentativa pode duplicar se a mensagem anterior foi aceita",
    );
  }

  await deps.db.atualizaEntrega(orgId, entrega.id, {
    status: "enviado",
    tentativas,
    erro_codigo: null,
    erro_detalhe: null,
    external_id: externalId,
    corpo_hash: createHash("sha256").update(body).digest("hex"),
    enviado_em: agoraEnvio.toISOString(),
  });
  await depoisDoEnvio(
    deps,
    orgId,
    channelSessionId,
    contextoFinal.contexto.caso,
    entrega,
    toAtual,
    agoraEnvio,
  );
  deps.audita({
    action: "ai.case_alert_sent",
    organizationId: orgId,
    caseId,
    metadata: {
      entrega_id: entrega.id,
      canal: channelSessionId,
      tentativas,
      lembrete_minuto: minute,
      aceito_pelo_transporte: true,
      confirmacao_final_de_entrega: false,
    },
  });
  return {
    status: "ok",
    detail: `lembrete_${minute}_min_aceito_pelo_transporte_sem_confirmacao_final tentativas=${tentativas}`,
  };
}

/**
 * O que vem DEPOIS do envio, e por que nada aqui pode lançar.
 *
 * Três efeitos, cada um com um dono: o ledger (que é o anti-ban do número), o
 * JID resolvido (que é o que faz o corte da ingestão valer para destinatário em
 * modo privacidade) e a linha do tempo do caso. Uma exceção em qualquer um
 * deles faria o dreno reprocessar o evento e a equipe receber o aviso de novo —
 * trocando um efeito colateral perdido por uma mensagem duplicada.
 */
async function depoisDoEnvio(
  deps: AvisoDeps,
  orgId: string,
  channelSessionId: string,
  caso: CasoDoAviso,
  entrega: EntregaDoAviso,
  to: string,
  agora: Date,
): Promise<void> {
  try {
    await deps.pacing.registraEnvio(orgId, channelSessionId, agora);
  } catch (err) {
    logger.warn("[aviso-de-caso] envio não contabilizado no pacing", {
      organizationId: orgId,
      channelSessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await deps.db.registraJidDoAviso(orgId, to);
  } catch (err) {
    logger.warn("[aviso-de-caso] JID do destino não registrado", {
      organizationId: orgId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await deps.db.registraEventoDoCaso({
      organizationId: orgId,
      caseId: caso.id,
      kind: "alert_sent",
      actorKind: "system",
      // `destino_mascarado` e nunca o número: a linha do tempo do caso é lida
      // por qualquer atendente, e o telefone do plantão não é assunto dele.
      metadata: { entrega_id: entrega.id, destino_mascarado: mascara(entrega.destino) },
    });
  } catch (err) {
    logger.warn("[aviso-de-caso] linha do tempo do caso não registrou o aviso", {
      organizationId: orgId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Os quatro últimos dígitos, e só. */
export function mascara(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  return d.length <= 4 ? "••••" : `••••${d.slice(-4)}`;
}

/**
 * A falha DEFINITIVA: grava o desfecho, abre o item na Central e audita.
 *
 * `skipped` e não `error`, sempre. O fato de o aviso não ter saído está gravado
 * em `entregas_de_aviso_de_caso` (a FONTE DA VERDADE) e visível na Central —
 * matar o evento por cima disso só acrescentaria ruído.
 *
 * ⚠️ A Central é a superfície, NÃO a fonte da verdade: qualquer membro apaga um
 * item dela pelo PostgREST hoje. A tela de avisos lê a tabela de entregas, e é
 * por isso que ela nunca lê "não há item aberto" como "está tudo bem".
 */
async function condena(
  deps: AvisoDeps,
  orgId: string,
  caso: CasoDoAviso,
  entrega: EntregaDoAviso,
  codigo: ErroDaEntregaDeAviso,
  detalhe: string | null,
  agora: Date,
  status: "falhou" | "cancelado" = "falhou",
): Promise<DesfechoDoAviso> {
  await deps.db.atualizaEntrega(orgId, entrega.id, {
    status,
    tentativas: entrega.tentativas + 1,
    erro_codigo: codigo,
    erro_detalhe: detalhe ? detalhe.slice(0, 300) : null,
  });

  try {
    await deps.db.avisaNaCentral({
      organizationId: orgId,
      caseId: caso.id,
      titulo: "Um aviso de atendimento não chegou ao WhatsApp da equipe",
      // A frase de gente, nunca o código cru. Quem lê a Central não sabe o que
      // é `canal_nao_aceita_aviso_livre`, e não precisa saber.
      corpo: `${fraseDoErro(codigo)} O atendimento continua esperando na fila.`,
    });
  } catch (err) {
    logger.warn("[aviso-de-caso] item da Central não foi aberto", {
      organizationId: orgId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }

  deps.audita({
    action: "ai.case_alert_failed",
    organizationId: orgId,
    caseId: caso.id,
    // NUNCA o número inteiro, NUNCA o corpo: `api_audit_log` é append-only e o
    // que entra ali não sai pela cascata de LGPD.
    metadata: {
      entrega_id: entrega.id,
      erro_codigo: codigo,
      destino_mascarado: mascara(entrega.destino),
      quando: agora.toISOString(),
    },
  });

  return skipped(`${status}:${codigo}`);
}

// ---------------------------------------------------------------------------
// Adapter de produção — `AvisoDb` sobre o client de service role.
// ---------------------------------------------------------------------------

/**
 * ⚠️ TODA consulta filtra `organization_id` À MÃO. O client é o de service
 * role, que BYPASSA a RLS: a organização vem da linha do `event_log` (fonte
 * confiável), nunca de um corpo externo.
 */
export function createSupabaseAvisoDb(admin: SupabaseClient): AvisoDb {
  return {
    async carregaConfig(orgId) {
      const { data, error } = await admin
        .from("config_aviso_de_caso")
        .select(
          "organization_id, channel_session_id, telefone_destino, destino_jid, ligado, sem_link, repetir_lembretes_whatsapp, minutos_lembrete_equipe",
        )
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as ConfigDoAviso | null) ?? null;
    },

    async carregaCaso(orgId, caseId) {
      const { data, error } = await admin
        .from("agent_cases")
        .select(
          "id, organization_id, conversation_id, kind, source, status, title, summary, blocker, task_kind, task_state, wait_generation, wait_started_at",
        )
        .eq("organization_id", orgId)
        .eq("id", caseId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as CasoDoAviso | null) ?? null;
    },

    async contatoAnonimizado(orgId, contactId) {
      const { data, error } = await admin
        .from("contacts")
        .select("is_anonymized")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      // Falha ABERTA na informação: não saber se o contato foi anonimizado não
      // pode virar "foi". Quem decide o silêncio é a coluna, não a ausência de
      // resposta — e o passo seguinte ainda passa pelo caso, que a cascata já
      // redigiu.
      if (error) throw new Error(error.message);
      return Boolean((data as { is_anonymized?: boolean } | null)?.is_anonymized);
    },

    async reivindicaEntrega({
      organizationId,
      caseId,
      destino,
      channelSessionId,
      waitGeneration = null,
      reminderMinute = null,
    }) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_caso")
        .insert({
          organization_id: organizationId,
          case_id: caseId,
          destino,
          channel_session_id: channelSessionId,
          status: "pendente",
          wait_generation: waitGeneration,
          reminder_minute: reminderMinute,
        })
        .select(
          "id, organization_id, case_id, destino, channel_session_id, status, tentativas, created_at, updated_at, wait_generation, reminder_minute",
        )
        .maybeSingle();

      if (!error) return { criada: true, entrega: (data as EntregaDoAviso | null) ?? null };
      // 23505 = a `unique (organization_id, case_id, destino)`. É o caminho
      // NORMAL sob concorrência, não um erro.
      if (error.code !== "23505") throw new Error(error.message);

      let consulta = admin
        .from("entregas_de_aviso_de_caso")
        .select(
          "id, organization_id, case_id, destino, channel_session_id, status, tentativas, created_at, updated_at, wait_generation, reminder_minute",
        )
        .eq("organization_id", organizationId)
        .eq("case_id", caseId)
        .eq("destino", destino);
      consulta =
        waitGeneration === null || reminderMinute === null
          ? consulta.is("wait_generation", null).is("reminder_minute", null)
          : consulta.eq("wait_generation", waitGeneration).eq("reminder_minute", reminderMinute);
      const relida = await consulta.maybeSingle();
      if (relida.error) throw new Error(relida.error.message);
      return { criada: false, entrega: (relida.data as EntregaDoAviso | null) ?? null };
    },

    async carregaLembreteWhatsApp(orgId, caseId, waitGeneration, minute, eventId) {
      const { data, error } = await admin
        .from("case_task_reminders")
        .select("case_id")
        .eq("organization_id", orgId)
        .eq("case_id", caseId)
        .eq("wait_generation", waitGeneration)
        .eq("minute", minute)
        .eq("whatsapp_event_id", eventId)
        .eq("result", "notified")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },

    async organizacaoOperante(orgId) {
      const { data, error } = await admin
        .from("organizations")
        .select("status")
        .eq("id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { status?: string } | null)?.status === "active";
    },

    async atualizaEntrega(orgId, entregaId, patch) {
      const { error } = await admin
        .from("entregas_de_aviso_de_caso")
        .update(patch)
        .eq("organization_id", orgId)
        .eq("id", entregaId);
      if (error) throw new Error(error.message);
    },

    async cancelaPendentesDoCaso(orgId, caseId) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_caso")
        .update({ status: "cancelado", erro_codigo: null })
        .eq("organization_id", orgId)
        .eq("case_id", caseId)
        .eq("status", "pendente")
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length;
    },

    async cancelaEntregaPendenteDoLembrete(orgId, caseId, waitGeneration, minute) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_caso")
        .update({ status: "cancelado", erro_codigo: null, erro_detalhe: null })
        .eq("organization_id", orgId)
        .eq("case_id", caseId)
        .eq("wait_generation", waitGeneration)
        .eq("reminder_minute", minute)
        .eq("status", "pendente")
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length;
    },

    async cancelaPendentesDeLembreteComOutroDestino(
      orgId,
      caseId,
      waitGeneration,
      minute,
      destinoAtual,
    ) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_caso")
        .update({ status: "cancelado", erro_codigo: null, erro_detalhe: null })
        .eq("organization_id", orgId)
        .eq("case_id", caseId)
        .eq("wait_generation", waitGeneration)
        .eq("reminder_minute", minute)
        .eq("status", "pendente")
        .neq("destino", destinoAtual)
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length;
    },

    async carregaCanal(orgId, channelSessionId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .select("id, status, archived_at, provider, metadata")
        .eq("organization_id", orgId)
        .eq("id", channelSessionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const linha = data as {
        id: string;
        status: string;
        archived_at: string | null;
        provider: string | null;
        metadata: unknown;
      };
      // A capacidade é resolvida em `lib/channels/` — este módulo nunca conhece
      // provedor. O import é TARDIO pelo mesmo motivo que `urlPublica` chega
      // pronta: o topo deste arquivo tem de carregar sem ambiente.
      const { capabilitiesOf, transportaMensagem } = await import("@/lib/channels/capabilities");
      let aceita = false;
      if (transportaMensagem(linha.provider)) {
        try {
          aceita = capabilitiesOf(linha.provider as never).freeformOutsideWindow;
        } catch {
          aceita = false;
        }
      }
      return {
        id: linha.id,
        status: linha.status,
        archived_at: linha.archived_at,
        aceitaMensagemLivre: aceita,
        desativado: canalDesativado(linha.metadata),
      };
    },

    /**
     * A MESMA pergunta que `fn_definir_aviso_de_caso` faz, feita de novo.
     *
     * A comparação é pelas DUAS grafias do nono dígito, como no SQL — comparar a
     * string crua deixaria passar o número cadastrado com 9 e registrado sem (ou
     * o contrário). `phoneLookupVariants` é a regra canônica do repo para isso,
     * e usá-la aqui evita uma terceira cópia da mesma conta.
     *
     * Só conexão ATIVA conta (`archived_at is null`), que é o que a 0438 fixou:
     * arquivada não envia nem recebe, então não fecha laço. A diferença em
     * relação ao SQL é WHERE ela roda, não O QUE ela pergunta.
     */
    async destinoEhDaPropriaOrganizacao(orgId, telefone) {
      const variantes = phoneLookupVariants(telefone).map((v) => v.replace(/\D/g, ""));
      if (variantes.length === 0) return false;
      // ⚠️ `organization_id` filtrado À MÃO: o client é o de service role, que
      // BYPASSA a RLS. A organização vem da linha do `event_log`.
      const { data, error } = await admin
        .from("channel_sessions")
        .select("id, phone_number")
        .eq("organization_id", orgId)
        .is("archived_at", null)
        .not("phone_number", "is", null);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ phone_number: string | null }>).some(
        (linha) =>
          linha.phone_number !== null &&
          // Mesma normalização do SQL: só dígitos, dos dois lados.
          variantes.includes(linha.phone_number.replace(/\D/g, "")),
      );
    },

    async avisaNaCentral({ organizationId, caseId, titulo, corpo }) {
      // Um item ABERTO por caso: enquanto o anterior não for resolvido, não
      // nasce outro. Mesmo padrão do `case-stale-watcher`.
      const { data: jaTem } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("kind", "aviso_de_caso_nao_entregue")
        .eq("ref_id", caseId)
        .eq("status", "open")
        .maybeSingle();
      if (jaTem) return;

      const { error } = await admin.from("agent_inbox_items").insert({
        organization_id: organizationId,
        kind: "aviso_de_caso_nao_entregue",
        // `warn` e não `critical`: há um cliente esperando, mas nada quebrou —
        // o caso continua na fila e visível na tela de Casos.
        severity: "warn",
        title: titulo,
        body: corpo,
        ref_kind: "agent_case",
        ref_id: caseId,
        status: "open",
      });
      if (error) throw new Error(error.message);
    },

    async registraEventoDoCaso({ organizationId, caseId, kind, actorKind, metadata }) {
      const { error } = await admin.from("agent_case_events").insert({
        organization_id: organizationId,
        case_id: caseId,
        kind,
        actor_kind: actorKind,
        metadata,
      });
      if (error) throw new Error(error.message);
    },

    async registraJidDoAviso(orgId, jid) {
      const { error } = await admin.rpc(
        "fn_registrar_jid_do_aviso" as never,
        {
          p_org: orgId,
          p_jid: jid,
        } as never,
      );
      if (error) throw new Error(error.message);
    },

    async nomeDoContato(orgId, contactId) {
      const { data, error } = await admin
        .from("contacts")
        .select("name, display_name")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const { nomeDoContato } = await import("@/lib/contacts/rotulo-do-contato");
      return nomeDoContato(data as never);
    },

    async marcaDaOrganizacao(orgId) {
      const [{ marcaDaSaida }, { normalizarIdioma }] = await Promise.all([
        import("@/lib/branding/saida"),
        import("@/lib/i18n/idiomas"),
      ]);
      const marca = await marcaDaSaida(orgId);
      const { data } = await admin
        .from("organizations")
        .select("locale")
        .eq("id", orgId)
        .maybeSingle();
      return {
        nome: marca.nome,
        idioma: normalizarIdioma((data as { locale?: string | null } | null)?.locale ?? null),
      };
    },
  };
}
