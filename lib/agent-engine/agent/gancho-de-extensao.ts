/**
 * O GANCHO DE EXTENSÃO NO TURNO DO AGENTE (#3076) — o ponto único, ANTES do
 * roteiro de atendimento e da IA, onde uma extensão declarativa pode assumir a
 * conversa.
 *
 * ─── Onde entra, e por quê ali ──────────────────────────────────────────────
 *
 * `executarTurnoDoAgente` chama `prepararGanchoDoTurno` DEPOIS de tudo que já
 * silencia o turno — lead em atendimento humano, conversa não elegível, agente
 * pausado, pedido de humano, opt-out — e antes de `prepararRoteiroDoTurno`. É o
 * mesmo lugar que o #3063 escolheu, e a ordem é o contrato: uma extensão não pode
 * abrir conversa para quem pediu para parar (foi o defeito medido no #1130, com o
 * roteiro). O teste de ordem vive em `gancho-de-extensao.test.ts` e vigia a
 * posição no texto do turno.
 *
 * ─── A CONCESSÃO, que é a razão de este arquivo existir (#3456) ─────────────
 *
 * A primeira versão deste gancho lia `contributions.turn_flow` das extensões
 * ATIVAS e agia. Estava errado, e o mantenedor fechou o PR por isso: ativar uma
 * extensão para abrir Tarefas autorizava, sem ninguém ler, que ela respondesse ao
 * cliente e entregasse a conversa a uma pessoa. Três elos fecham o furo, e este
 * arquivo é o terceiro:
 *
 *   1. o manifesto que declara `turn_flow` tem de declarar as permissões NOMEADAS
 *      que o fluxo usa — `turn.send` e, quando o desfecho passa para humano,
 *      `turn.handoff` (`checkCompatibility`, `lib/extensions/manifest.ts`);
 *   2. o dono da organização precisa ACEITAR essas permissões, num ato próprio e
 *      durável (`organization_extensions.accepted_permissions`);
 *   3. aqui: sem o aceite, a extensão **não age**. A conversa é da IA, e o log
 *      diz qual das duas coisas faltou.
 *
 * `motivoDeRecusaDoTurno` (`lib/extensions/consentimento.ts`) distingue
 * `sem_permissao_declarada`, `sem_aceite` e `aceite_desatualizado` — o terceiro é
 * a prova de ATUALIZAÇÃO: uma versão que passa a pedir permissão nova não herda o
 * aceite antigo. Permissão REMOVIDA, ao contrário, não invalida nada (a cobertura
 * é de subconjunto).
 *
 * ─── Zero extensões = turno idêntico (item 7) ──────────────────────────────
 *
 * A primeira leitura é a das extensões ATIVAS da organização. Sem nenhuma, a
 * função devolve `nao_e_comigo` e o turno segue exatamente como hoje: nenhuma
 * escrita, nenhuma bolha, nenhum desvio.
 *
 * ─── O que o HOST garante, e a extensão não precisa saber (item 4) ──────────
 *
 * 1. **Claim da mensagem.** O estado gravado carrega os ids das mensagens já
 *    lidas (`mensagens`). Retry do mesmo job com a mesma mensagem é NO-OP.
 * 2. **O estado é do host** (`conversations.metadata.gancho_de_extensao`): JSONB,
 *    sem migration, sem tabela por pacote. A extensão nunca lê nem escreve nada.
 * 3. **O host encerra o estado** quando a extensão devolve a conversa, conclui a
 *    coleta ou passa para humano — e é nesse encerramento que a linha do tempo
 *    ganha a atividade de "devolver" (`extension_turn_returned`). A de "assumir"
 *    (`extension_turn_assumed`) nasce quando a coleta começa. Sem as duas, quem
 *    lê a timeline vê a conversa mudar de dono sem nada explicando.
 * 4. **Mídia sem texto não prende nem cala a conversa**: a pergunta pendente é
 *    repetida e o turno conta como sem progresso — o teto do item 3 escala.
 *
 * ─── Envio e passagem são do NÚCLEO (item 6) ───────────────────────────────
 *
 * A bolha da extensão sai por `enviarTextoSemModelo`, que passa a cadeia inteira
 * de `runBeforeSend` — throttle, janela, teto, opt-out, anti-ban. Nada aqui fala
 * com o canal por baixo dela. A passagem usa `performHumanHandoff` com
 * `camposColetados` (o caminho (c3) do #3052) e a chave de idempotência da
 * mensagem reivindicada, que é o que torna o retry um no-op (portado do #3063).
 *
 * ⚠️ Se a cadeia VETAR a bolha, o gancho NÃO insiste e NÃO deixa a conversa
 * muda: devolve o turno para a IA (`nao_e_comigo`) e apaga o estado. A extensão
 * é uma comodidade; o cliente ser atendido não é.
 */
import type pg from "pg";

import {
  decidirDoFluxo,
  gatilhoQueCasou,
  parseFluxoDoTurno,
  textoNoIdioma,
  idiomaDaMensagem,
  type EstadoDoFluxo,
  type FluxoDoTurno,
} from "@/lib/extensions/fluxo-do-turno";
import {
  motivoDeRecusaDoTurno,
  type MotivoDeRecusaDoTurno,
} from "@/lib/extensions/consentimento";
import type { ExtensionPermission } from "@/lib/extensions/capacidades";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";
import type { ChannelAdapter, ChannelSendResult } from "../channel-adapter";
import { runBeforeSend } from "../guardrails/before-send";
import type { Logger } from "../obs/logger";

/** A chave do estado no `conversations.metadata`. Mesmo domicílio do claim do roteiro. */
export const CHAVE_DO_GANCHO = "gancho_de_extensao";

/**
 * Janela de mensagens reivindicadas que o estado carrega. Ela só precisa cobrir
 * a rajada de um turno e o retry do job seguinte; 20 é a janela que o roteiro já
 * usa para o mesmo fim.
 */
const JANELA_DE_CLAIM = 20;

/**
 * Uma extensão ATIVA da organização, com o fluxo que ela declara, as permissões
 * que o manifesto declara e o que a organização ACEITOU.
 *
 * Os três vêm juntos porque a decisão depende dos três — e ler só o primeiro foi
 * o defeito do #3456.
 */
export interface FluxoAtivoDaOrganizacao {
  /** `publisher/name` — o estado morre quando o vínculo some. */
  extensao: string;
  fluxo: FluxoDoTurno;
  /** `manifest.permissions` da versão vigente. */
  declaradas: readonly ExtensionPermission[];
  /** `organization_extensions.accepted_permissions` — o aceite do dono da organização. */
  aceitas: readonly ExtensionPermission[];
}

export type DecisaoDoTurno =
  /** Não é comigo: o turno segue exatamente como hoje. */
  | { tipo: "nao_e_comigo"; porque: string }
  /** A mensagem já foi reivindicada num turno anterior: nada a fazer neste. */
  | { tipo: "ja_tratado"; fluxo: string }
  /** A extensão respondeu — a IA NÃO roda neste turno. */
  | { tipo: "assumido"; fluxo: string; porque: "comecou" | "avancou" | "repetiu" }
  /** A extensão concluiu a coleta e devolveu a conversa: a IA volta no turno seguinte. */
  | { tipo: "concluido"; fluxo: string; porque: "coletou" | "teto" }
  /** A conversa foi para um humano com os campos coletados — a IA não roda. */
  | { tipo: "passado"; fluxo: string; porque: "coletou" | "teto"; campos: Record<string, string> };

export interface DepsDoGancho {
  pool: pg.Pool;
  log: Logger;
  /** As extensões ativas da organização, com permissões declaradas e aceites. */
  fluxos: () => Promise<readonly FluxoAtivoDaOrganizacao[]>;
  /** Manda UMA bolha pela cadeia do núcleo. `false` = a cadeia vetou. */
  enviar: (texto: string, fluxo: FluxoAtivoDaOrganizacao) => Promise<boolean>;
  /** A passagem (c3) com os campos coletados, idempotente pela mensagem. */
  passarParaHumano: (args: {
    fluxo: FluxoAtivoDaOrganizacao;
    campos: Record<string, string>;
    aviso: string;
    idempotencia: string | null;
  }) => Promise<void>;
  /**
   * A linha na timeline do negócio. Fire-and-forget: a timeline descreve a
   * operação e nunca pode derrubá-la — a mesma disciplina do handoff.
   */
  registrarAtividade: (args: {
    tipo: Extract<ActivityType, "extension_turn_assumed" | "extension_turn_returned">;
    extensao: string;
    fluxo: string;
    /** Por que a conversa mudou de dono. Vocabulário fechado, sem PII. */
    motivo: string;
  }) => Promise<void>;
}

export interface TurnoDoGancho {
  organizationId: string;
  contactId: string;
  conversationId: string | null;
  /** A mensagem que ESTE turno responde (pinada no job). */
  texto: string | null;
  messageId: string | null;
  /** O relógio do turno — nunca `new Date()`: o teste fixa a hora. */
  agora: Date;
}

function erroCurto(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}

/** `text[]` do banco, ou o ausente: só nomes do vocabulário, sem repetição. */
function permissoesDaLinha(valor: unknown): ExtensionPermission[] {
  if (!Array.isArray(valor)) return [];
  return [
    ...new Set(valor.filter((item): item is string => typeof item === "string")),
  ] as ExtensionPermission[];
}

/**
 * Lê os fluxos DECLARADOS pelas extensões ativas da organização, com as permissões
 * declaradas e o aceite da organização.
 *
 * A leitura é por `pg` (o motor não usa o cliente Supabase) e devolve só o que
 * interessa ao turno: a identidade do pacote, `contributions.turn_flow`,
 * `manifest.permissions` e `organization_extensions.accepted_permissions`. O
 * manifesto gravado é revalidado pelo MESMO contrato do `manifest.ts`
 * (`parseFluxoDoTurno`) — um pacote velho/adulterado não dirige a conversa sem
 * passar pela régua, como no tema (`temaAplicavel`).
 *
 * Pacote com fluxo inválido, ou sem a concessão que o fluxo exige, é IGNORADO com
 * aviso, e não derruba o turno: o cliente continua sendo atendido pela IA.
 */
export async function lerFluxosAtivosDaOrganizacao(
  pool: pg.Pool,
  organizationId: string,
  log: Logger,
): Promise<FluxoAtivoDaOrganizacao[]> {
  const { rows } = await pool.query<{
    extensao: string;
    fluxo: unknown;
    permissoes: unknown;
    aceitas: unknown;
  }>(
    `select coalesce(a.manifest->>'publisher', '?') || '/' || coalesce(a.manifest->>'name', '?') as extensao,
            a.manifest->'contributions'->'turn_flow' as fluxo,
            a.manifest->'permissions' as permissoes,
            oe.accepted_permissions as aceitas
       from organization_extensions oe
       join extension_installations i on i.id = oe.installation_id
       join extension_artifacts a on a.id = i.artifact_id
      where oe.organization_id = $1 and oe.enabled and i.removed_at is null
      order by extensao
      limit 50`,
    [organizationId],
  );
  const ativos: FluxoAtivoDaOrganizacao[] = [];
  for (const linha of rows) {
    if (linha.fluxo === null || linha.fluxo === undefined) continue;
    let fluxo: FluxoDoTurno;
    try {
      fluxo = parseFluxoDoTurno(linha.fluxo);
    } catch (err) {
      // Só o id do pacote e o motivo — nunca texto do cliente.
      log.warn("gancho de extensão: fluxo declarado não passa na régua desta versão — ignorado", {
        extensao: linha.extensao,
        error: erroCurto(err),
      });
      continue;
    }
    const declaradas = permissoesDaLinha(linha.permissoes);
    const aceitas = permissoesDaLinha(linha.aceitas);
    const recusa = motivoDeRecusaDoTurno({ declaradas, aceitas, fluxo });
    if (recusa !== null) {
      // O caso que o #3456 exigiu: sem concessão, a extensão NÃO age. O log diz
      // qual elo faltou, e a conversa segue com a IA.
      log.info("gancho de extensão: extensão ativa sem concessão para o turno — não age", {
        extensao: linha.extensao,
        motivo: recusa,
        declaradas,
        aceitas,
      });
      continue;
    }
    ativos.push({ extensao: linha.extensao, fluxo, declaradas, aceitas });
  }
  return ativos;
}

async function lerEstado(
  pool: pg.Pool,
  organizationId: string,
  conversationId: string,
): Promise<EstadoDoFluxo | null> {
  const { rows } = await pool.query<{ estado: EstadoDoFluxo | null }>(
    `select metadata->$3 as estado from conversations where organization_id = $1 and id = $2`,
    [organizationId, conversationId, CHAVE_DO_GANCHO],
  );
  const estado = rows[0]?.estado ?? null;
  if (estado === null) return null;
  // Estado de uma versão anterior do vocabulário: melhor esquecer que agir sobre
  // campos que não entendemos.
  if (
    typeof estado !== "object" ||
    typeof estado.fluxo !== "string" ||
    typeof estado.extensao !== "string" ||
    !Array.isArray(estado.mensagens) ||
    typeof estado.etapa !== "number"
  ) {
    return null;
  }
  return estado;
}

async function gravarEstado(
  pool: pg.Pool,
  organizationId: string,
  conversationId: string,
  estado: EstadoDoFluxo,
): Promise<void> {
  await pool.query(
    `update conversations
        set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb)
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId, CHAVE_DO_GANCHO, JSON.stringify(estado)],
  );
}

async function apagarEstado(
  pool: pg.Pool,
  organizationId: string,
  conversationId: string,
): Promise<void> {
  await pool.query(
    `update conversations
        set metadata = coalesce(metadata, '{}'::jsonb) - $3::text
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId, CHAVE_DO_GANCHO],
  );
}

/**
 * Prepara o gancho do turno. Devolve a decisão e — quando a extensão assume,
 * conclui ou passa — já executou o efeito: a bolha saiu, a passagem foi gravada e
 * a timeline ganhou a linha de "assumir"/"devolver".
 *
 * NUNCA lança por falha do fluxo: toda falha vira aviso no log e `nao_e_comigo`,
 * porque a IA continua sendo a rede do atendimento.
 */
export async function prepararGanchoDoTurno(
  deps: DepsDoGancho,
  t: TurnoDoGancho,
): Promise<DecisaoDoTurno> {
  let fluxos: readonly FluxoAtivoDaOrganizacao[];
  try {
    fluxos = await deps.fluxos();
  } catch (err) {
    deps.log.warn("gancho de extensão: não consegui ler as extensões ativas — o turno segue", {
      error: erroCurto(err),
    });
    return { tipo: "nao_e_comigo", porque: "leitura_falhou" };
  }
  // Zero extensões ativas (ou nenhuma com fluxo e concessão): o turno é o de sempre.
  if (fluxos.length === 0) return { tipo: "nao_e_comigo", porque: "sem_extensoes" };
  if (t.conversationId === null) return { tipo: "nao_e_comigo", porque: "sem_conversa" };

  let estado: EstadoDoFluxo | null;
  try {
    estado = await lerEstado(deps.pool, t.organizationId, t.conversationId);
  } catch (err) {
    deps.log.warn("gancho de extensão: não consegui ler o estado da conversa — o turno segue", {
      error: erroCurto(err),
    });
    return { tipo: "nao_e_comigo", porque: "leitura_falhou" };
  }

  // O fluxo do estado vivo MANDA. Se ele sumiu — extensão desligada, removida da
  // instalação, versão nova sem o fluxo, aceite revogado —, o estado é recolhido,
  // a timeline registra a DEVOLUÇÃO e o turno volta para a IA. É a prova de
  // reversão morando no caminho de produção, e não só no teste.
  const alvo: FluxoAtivoDaOrganizacao | null =
    estado === null
      ? escolherPorGatilho(fluxos, t.texto, deps.log)
      : (fluxos.find((f) => f.extensao === estado!.extensao && f.fluxo.id === estado!.fluxo) ??
        null);

  if (estado !== null && alvo === null) {
    await apagarEstado(deps.pool, t.organizationId, t.conversationId).catch((err: unknown) => {
      deps.log.warn("gancho de extensão: não consegui recolher o estado órfão", {
        error: erroCurto(err),
      });
    });
    await registrarDevolucao(deps, estado.extensao, estado.fluxo, "extensao_nao_dirige_mais");
    return { tipo: "nao_e_comigo", porque: "fluxo_sumiu" };
  }
  if (alvo === null) return { tipo: "nao_e_comigo", porque: "sem_gatilho" };

  // CLAIM (item 4): a mensagem já foi lida por este fluxo num turno anterior —
  // retry é no-op, nem anda a etapa nem manda bolha de novo.
  if (estado !== null && t.messageId !== null && estado.mensagens.includes(t.messageId)) {
    deps.log.info("gancho de extensão: mensagem já reivindicada — retry não repete o turno", {
      fluxo: alvo.fluxo.id,
      extensao: alvo.extensao,
    });
    return { tipo: "ja_tratado", fluxo: alvo.fluxo.id };
  }

  const resultado = decidirDoFluxo(alvo.fluxo, alvo.extensao, estado, {
    texto: t.texto,
    agora: t.agora.toISOString(),
  });

  if (resultado.acao === "devolver") {
    // Devolver ENCERRA o estado: quem responde é a IA, e o fluxo não fica
    // pendurado esperando uma resposta que já foi dada.
    if (estado !== null) {
      await apagarEstado(deps.pool, t.organizationId, t.conversationId).catch((err: unknown) => {
        deps.log.warn("gancho de extensão: não consegui encerrar o estado ao devolver", {
          error: erroCurto(err),
        });
      });
      await registrarDevolucao(deps, alvo.extensao, alvo.fluxo.id, `devolvido:${resultado.porque}`);
    }
    deps.log.info("gancho de extensão: devolvido para a IA", {
      fluxo: alvo.fluxo.id,
      extensao: alvo.extensao,
      porque: resultado.porque,
    });
    return { tipo: "nao_e_comigo", porque: resultado.porque };
  }

  if (resultado.acao === "passar") {
    try {
      await deps.passarParaHumano({
        fluxo: alvo,
        campos: { ...resultado.campos },
        aviso: resultado.aviso,
        // A chave do retry é a MENSAGEM reivindicada: o mesmo turno reexecutado
        // não grava duas linhas de passagem (portado do #3063). Sem mensagem
        // pinada (caso raro), cada tentativa grava a sua, como no legado.
        idempotencia: t.messageId,
      });
    } catch (err) {
      deps.log.warn("gancho de extensão: a passagem falhou — o turno segue para a IA", {
        fluxo: alvo.fluxo.id,
        extensao: alvo.extensao,
        error: erroCurto(err),
      });
      return { tipo: "nao_e_comigo", porque: "passagem_falhou" };
    }
    await apagarEstado(deps.pool, t.organizationId, t.conversationId).catch((err: unknown) => {
      deps.log.warn("gancho de extensão: não consegui encerrar o estado depois da passagem", {
        error: erroCurto(err),
      });
    });
    deps.log.info("gancho de extensão: passagem para humano com campos coletados", {
      fluxo: alvo.fluxo.id,
      extensao: alvo.extensao,
      campos: Object.keys(resultado.campos).length,
      porque: resultado.porque,
    });
    return {
      tipo: "passado",
      fluxo: alvo.fluxo.id,
      porque: resultado.porque,
      campos: { ...resultado.campos },
    };
  }

  // ASSUMIR. O estado — com o claim — é gravado ANTES do envio: o retry do job
  // lê o claim e não manda a bolha duas vezes. O custo disso é conhecido e
  // aceito: morrer entre a gravação e o envio perde UMA pergunta, e o turno
  // seguinte a repete (a etapa não anda sem resposta).
  const novo: EstadoDoFluxo = {
    ...resultado.estado,
    mensagens: [
      ...resultado.estado.mensagens,
      ...(t.messageId === null ? [] : [t.messageId]),
    ].slice(-JANELA_DE_CLAIM),
  };
  try {
    await gravarEstado(deps.pool, t.organizationId, t.conversationId, novo);
  } catch (err) {
    deps.log.warn("gancho de extensão: não consegui gravar o estado — o turno segue para a IA", {
      fluxo: alvo.fluxo.id,
      error: erroCurto(err),
    });
    return { tipo: "nao_e_comigo", porque: "gravacao_falhou" };
  }

  let enviou: boolean;
  try {
    enviou = await deps.enviar(resultado.texto, alvo);
  } catch (err) {
    deps.log.warn("gancho de extensão: o envio falhou — devolvendo o turno para a IA", {
      fluxo: alvo.fluxo.id,
      error: erroCurto(err),
    });
    enviou = false;
  }
  if (!enviou) {
    // Cadeia vetou (janela, anti-ban, opt-out): a extensão não insiste. Apaga o
    // estado para que a IA responda sem herdar uma coleta pela metade.
    await apagarEstado(deps.pool, t.organizationId, t.conversationId).catch(() => undefined);
    return { tipo: "nao_e_comigo", porque: "envio_vetado" };
  }
  if (resultado.acao === "concluir") {
    // A coleta terminou no desfecho `assumir`: a despedida saiu e o estado morre
    // aqui. O turno SEGUINTE é da IA — e a timeline registra a devolução, para
    // que "a conversa voltou" não seja invisível.
    await apagarEstado(deps.pool, t.organizationId, t.conversationId).catch((err: unknown) => {
      deps.log.warn("gancho de extensão: não consegui encerrar o estado ao concluir", {
        error: erroCurto(err),
      });
    });
    await registrarDevolucao(deps, alvo.extensao, alvo.fluxo.id, `concluido:${resultado.porque}`);
    return { tipo: "concluido", fluxo: alvo.fluxo.id, porque: resultado.porque };
  }
  // `comecou` é a única entrada que muda o dono da conversa: é a única que vira
  // atividade de ASSUMIR. Um avanço de etapa não é uma mudança de dono.
  if (resultado.porque === "comecou") {
    await registrarAssuncao(deps, alvo);
  }
  return { tipo: "assumido", fluxo: alvo.fluxo.id, porque: resultado.porque };
}

/** A atividade de "assumir": a conversa passou a ser conduzida pela extensão. */
async function registrarAssuncao(
  deps: DepsDoGancho,
  alvo: FluxoAtivoDaOrganizacao,
): Promise<void> {
  try {
    await deps.registrarAtividade({
      tipo: "extension_turn_assumed",
      extensao: alvo.extensao,
      fluxo: alvo.fluxo.id,
      motivo: "gatilho",
    });
  } catch (err) {
    deps.log.warn("gancho de extensão: a atividade de assumir não foi gravada", {
      fluxo: alvo.fluxo.id,
      error: erroCurto(err),
    });
  }
}

/** A atividade de "devolver": a conversa voltou para a IA. */
async function registrarDevolucao(
  deps: DepsDoGancho,
  extensao: string,
  fluxo: string,
  motivo: string,
): Promise<void> {
  try {
    await deps.registrarAtividade({ tipo: "extension_turn_returned", extensao, fluxo, motivo });
  } catch (err) {
    deps.log.warn("gancho de extensão: a atividade de devolver não foi gravada", {
      fluxo,
      error: erroCurto(err),
    });
  }
}

/**
 * Qual fluxo começa a conversa — só quando NENHUM está em andamento.
 *
 * Empate é NEGAÇÃO, como no tema (`temaAplicavel`): dois fluxos que casam a
 * mesma mensagem disputariam a mesma resposta, e escolher por ordem de consulta
 * faria o comportamento depender do plano do banco. Ninguém assume; a IA
 * responde.
 */
function escolherPorGatilho(
  fluxos: readonly FluxoAtivoDaOrganizacao[],
  texto: string | null,
  log: Logger,
): FluxoAtivoDaOrganizacao | null {
  if (texto === null || texto.trim() === "") return null;
  const idioma = idiomaDaMensagem(texto);
  if (idioma === null) return null;
  const candidatos = fluxos.filter(
    (f) => f.fluxo.idiomas.includes(idioma) && gatilhoQueCasou(f.fluxo, texto, idioma) !== null,
  );
  if (candidatos.length > 1) {
    log.warn("gancho de extensão: mais de um fluxo casou a mesma mensagem — nenhum assume", {
      fluxos: candidatos.map((c) => c.fluxo.id),
    });
    return null;
  }
  return candidatos[0] ?? null;
}

/**
 * O TEXTO que a extensão fala, enviado pelo HOST sem gastar modelo.
 *
 * Irmão determinístico de `aviso-de-escalacao.ts` e da re-entrada do
 * `followup-turn.ts`: a bolha passa por `runBeforeSend` (throttle, janela, teto
 * diário, opt-out, anti-ban) e o `send` é o do canal. As três escolhas que
 * precisam estar escritas:
 *
 *   - **`enforceCommercialRestriction: false`.** O texto é do PACOTE, não da IA:
 *     a restrição comercial (#2877) julga texto gerado, e barrar a pergunta de um
 *     fluxo aprovado por ela seria vetar o que a organização instalou de propósito.
 *   - **`casesEnabled: false`.** Não há promessa-de-humano aqui: a frase que
 *     promete a passagem é do desfecho, e ela só sai quando a passagem acontece
 *     no MESMO turno.
 *   - **`spinning` ARMADO (ausente).** Pergunta repetida em vários atendimentos é
 *     exatamente o que o gate existe para pegar; se ele vetar, o gancho devolve o
 *     turno para a IA — nunca silêncio.
 *
 * "Digitando" antes da bolha, como nos demais envios do turno (item 6): o canal
 * que não tem presença simplesmente não recebe o sinal.
 */
export async function enviarTextoSemModelo(
  args: {
    pool: pg.Pool;
    log: Logger;
    tenantId: string;
    leadId: string;
    conversationId: string;
    channelSessionId: string;
    /** `job_queue.id` do turno — o ledger do canal exige chave de dedup. */
    jobId: string;
    agentId: string | null;
    channel: ChannelAdapter;
    texto: string;
    optedOutThisTurn: boolean;
    agora: Date;
    /** Posição da bolha no turno — 1..n, o mesmo contrato do ledger do canal. */
    seq: number;
  },
): Promise<boolean> {
  if (args.channel.signalTyping !== undefined) {
    try {
      await args.channel.signalTyping({
        tenantId: args.tenantId,
        conversationId: args.conversationId,
      });
    } catch (err) {
      args.log.warn("gancho de extensão: o indicador de digitando falhou — o envio segue", {
        error: erroCurto(err),
      });
    }
  }
  const chain = await runBeforeSend({
    pool: args.pool,
    log: args.log,
    tenantId: args.tenantId,
    leadId: args.leadId,
    jobId: args.jobId,
    channelSessionId: args.channelSessionId,
    body: args.texto,
    optedOutThisTurn: args.optedOutThisTurn,
    ...(args.agentId !== null ? { agentId: args.agentId } : {}),
    crmDailyLimit: null,
    resposta: true,
    now: args.agora,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    enforceCommercialRestriction: false,
    send: (body): Promise<ChannelSendResult> =>
      args.channel.send({
        tenantId: args.tenantId,
        leadId: args.leadId,
        jobId: args.jobId,
        seq: args.seq,
        conversationId: args.conversationId,
        body,
      }),
  });
  if (chain.status === "vetoed") {
    args.log.info("gancho de extensão: a cadeia vetou a bolha — a IA responde no lugar", {
      code: chain.code,
    });
    return false;
  }
  const { outcome } = chain;
  switch (outcome.kind) {
    case "sent":
    case "already_sent":
    case "queued":
      return true;
    default:
      args.log.info("gancho de extensão: a bolha não foi entregue — a IA responde no lugar", {
        kind: outcome.kind,
      });
      return false;
  }
}

/** O texto do desfecho no idioma do estado (usado pelo chamador ao montar o aviso). */
export function avisoDoDesfecho(fluxo: FluxoDoTurno, idioma: string | null): string {
  return fluxo.desfecho.tipo === "passar_para_humano"
    ? textoNoIdioma(fluxo.desfecho.aviso, idioma)
    : textoNoIdioma(fluxo.desfecho.texto, idioma);
}

/** O motivo que o leitor de fluxos registrou — reexportado para quem compõe a leitura. */
export type { MotivoDeRecusaDoTurno };
