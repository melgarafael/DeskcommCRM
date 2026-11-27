/**
 * O RUNTIME DO MENU DE ATENDIMENTO SEM IA (#4594, fatia 1).
 *
 * ─── Onde ele entra: entre a mensagem gravada e o turno do agente ───────────
 *
 * Quem chama é `pedirDespachoDoAgente` (`lib/channels/pos-entrada.ts`), ANTES de
 * emitir `ai_agent.dispatch_requested`. Escolha, e não acidente:
 *
 *   • a conversa continua virando card no funil como hoje — um menu de entrada é
 *     atendimento, não um desvio do comercial (ao contrário da Ouvidoria, que
 *     assume a mensagem antes de o card nascer);
 *   • o evento que acorda a IA simplesmente não é emitido enquanto o menu está
 *     com a palavra. É essa linha que faz a promessa da issue — "sem gastar
 *     token" — e é ela que o teste de recusa vigia;
 *   • desligado, nada aqui roda e o despacho sai como sempre saiu.
 *
 * ─── As três garantias deste arquivo ────────────────────────────────────────
 *
 * 1. **Nunca lança.** Quem chama é a ingestão, onde exceção vira 500 para o
 *    provedor e tempestade de reentregas. Toda porta é chamada dentro de um
 *    try/catch que devolve `false`, e o pior desfecho é `tratado: false` — a
 *    mensagem segue o caminho de hoje.
 *
 * 2. **Menu sem estado não existe.** O estado é gravado na POSSE, antes do
 *    envio (ver a seção da #5137 abaixo): se o envio falhar, a posse é
 *    devolvida e a conversa volta ao estado de antes. Nos outros caminhos, se o
 *    estado não pôde ser gravado depois do envio, a conversa cai para humano —
 *    um atendente é melhor que um menu em laço. É a mesma regra do "opção
 *    inválida duas vezes" e é o que o teste de sabotagem mede.
 *
 * ─── A POSSE DO MENU: UMA ENTRADA SÓ MANDA (#5137) ──────────────────────────
 *
 * `decidirPassoDoMenu` é PURO e diz "esta mensagem pede o menu". Mas duas
 * mensagens da MESMA conversa podem chegar juntas — o caminho medido pela issue
 * foi `Promise.all` em `aplicarEfeitosPosEntrada`. Como o `messageId` entra na
 * chave de idempotência, cada uma tinha a sua chave e as DUAS passavam: "oi" e
 * "tudo bem?" mandavam dois menus.
 *
 * Quem decide se o menu SAI é o banco: antes de enviar, `tomaPosse` faz um
 * UPDATE condicional que grava o estado `aguardando` **só se a chave
 * `menu_de_atendimento` ainda não existir**. Uma entrada vence; a outra recebe
 * `menu_em_disputa`, NÃO manda menu e cai no caminho normal da entrada (card e
 * despacho da IA) — o comportamento de hoje, sem card nem despacho duplicado.
 * A decisão continua pura; o desempate mora na porta, que é quem fala com o
 * banco.
 *
 * 3. **Recusa é NOMEADA.** Toda saída devolve `motivo`: entra no log da
 *    ingestão e responde, sem abrir o banco, "por que esta mensagem não teve
 *    menu" (`conversa_com_dono`, `menu_concluido`, `envio_falhou`…).
 *
 * ─── As duas regras do #4636 (o pedido do mantenedor) ───────────────────────
 *
 * 1. **O menu respeita o CONTATO.** `force_human`/`ai_opt_out` ("sempre
 *    atendimento humano") e as etiquetas de contato interno e da equipe vetam o
 *    menu com as MESMAS réguas do gate da IA — ver `motivoDoVetoDoContato`.
 * 2. **O menu é da PRIMEIRA mensagem.** Estado vencido não é convite para o menu
 *    voltar: quem decide é o atendimento ainda não ter começado (nenhuma saída
 *    da empresa na conversa). A validade de 24 h continua valendo para o estado
 *    não ser lido como escolha — só não decide mais o reenvio.
 *
 * ─── O que fica de fora desta fatia (declarado no PR) ───────────────────────
 *
 * Formulário conversacional (guardar a resposta do cliente num campo) e menus
 * aninhados. O modelo aceita UM nível de escolha e três ações — fila, pessoa e
 * arquivo existente. Também fica fora o editor visual do menu: nesta fatia a
 * configuração é escrita em `settings.menu_de_atendimento` e validada por
 * `validarMenu`, que é a régua que a tela vai usar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehContatoDaEquipe } from "@/lib/contacts/tags-da-equipe";
import { ehContatoInterno } from "@/lib/contacts/tags-internas";
import { moduloLigadoComMemo } from "@/lib/instalacao/modulos";
import { logger as loggerPadrao } from "@/lib/logger";
import { tagsDaEquipeDaOrg, tagsInternasDaOrg } from "@/lib/schemas/settings";
import {
  comEstadoDoMenu,
  decidirPassoDoMenu,
  estadoAguardando,
  estadoConcluido,
  estadoRepetiu,
  lerEstadoDoMenu,
  type EstadoDoMenu,
} from "./decisao";
import {
  menuDeclarado,
  renderizarMenu,
  renderizarOpcoes,
  type MenuSemIa,
  type OpcaoDoMenu,
} from "./modelo";

/** A mensagem que chega, do jeito que a ingestão a entrega. */
export interface MensagemDoMenu {
  organizationId: string;
  conversationId: string;
  contactId: string;
  messageId: string | null;
  texto: string | null;
}

/**
 * O que o runtime precisa do mundo. Tudo entra por aqui — o teste injeta dublês
 * e mede a decisão, e a produção injeta as réguas que já existem
 * (`portasDoMenu`, abaixo).
 *
 * Cada porta devolve `ok` em vez de lançar: a diferença entre "não deu" e
 * "quebrou" não interessa a quem chama, e um throw atravessaria a ingestão.
 */
export interface PortasDoMenu {
  /** Texto para o cliente. `chave` é a chave de idempotência do envio. */
  responde: (p: { texto: string; chave: string }) => Promise<boolean>;
  /**
   * Toma a POSSE do menu nesta conversa, atomicamente — a corrida da #5137.
   *
   * `metadata` é o `metadata` da conversa JÁ com o estado `aguardando`, montado
   * por quem chamou. A porta grava **só se a chave `menu_de_atendimento` ainda
   * não existir**, numa única instrução de banco (UPDATE condicional), e diz se
   * ESTE chamador foi quem gravou.
   *
   * `{ ok: false, motivo: "menu_em_disputa" }` = outra entrada chegou primeiro.
   * Quem perde NÃO manda menu: cai no comportamento normal da entrada. Sem esta
   * trava, duas mensagens diferentes da mesma conversa decidiam as duas enviar
   * — a chave de idempotência inclui o `messageId`, então cada uma tinha a sua
   * chave e as duas passavam.
   */
  tomaPosse: (p: {
    metadata: Record<string, unknown>;
  }) => Promise<{ ok: true } | { ok: false; motivo: string }>;
  /**
   * Devolve a posse quando o envio falhou (best-effort).
   *
   * A posse já gravou `aguardando`; sem o menu enviado, esse estado mentiria que
   * o cliente recebeu uma lista. Removê-lo devolve a conversa ao estado de
   * antes, e a próxima mensagem pode tentar de novo.
   */
  liberaPosse: (p: { metadata: Record<string, unknown> }) => Promise<boolean>;
  /** Arquivo que já existe, por URL. */
  enviaArquivo: (p: {
    mediaUrl: string;
    legenda: string | null;
    chave: string;
  }) => Promise<boolean>;
  /** Passa a conversa para o atendimento humano (a fila, sem dono). */
  passaParaFila: (p: { chave: string }) => Promise<{ ok: boolean; motivo?: string }>;
  /** Atribui a conversa a uma pessoa. */
  passaParaPessoa: (p: {
    userId: string;
    chave: string;
  }) => Promise<{ ok: boolean; motivo?: string }>;
  agora?: Date;
  log?: typeof loggerPadrao;
}

/** O que aconteceu com a mensagem, para o log da ingestão. */
export interface AtendimentoDoMenu {
  /** `true` = o menu é dono desta mensagem; a ingestão NÃO acorda a IA. */
  tratado: boolean;
  motivo: string;
}

/** Os status em que a conversa não aceita mais menu nenhum. */
const STATUS_ENCERRADOS = ["closed", "archived", "resolved"] as const;

const TEXTO_DE_REPETICAO = "Não entendi. Responda só com o número da opção:";
const TEXTO_DE_ENCAMINHAMENTO = "Certo! Já estou te passando para um atendente.";
const TEXTO_DE_OPCAO_INVALIDA =
  "Desculpe, não consegui entender sua escolha. Vou te passar para um atendente.";
const TEXTO_DE_FALHA =
  "Recebi sua escolha, mas não consegui te encaminhar agora. Tente de novo em instantes.";

function erroCurto(erro: unknown): string {
  return (erro instanceof Error ? erro.message : String(erro)).slice(0, 160);
}

/** A linha da conversa que o menu lê — uma consulta, cinco decisões. */
interface ConversaDoMenu {
  status?: string | null;
  assigned_to_user_id?: string | null;
  bot_silenced_until?: string | null;
  metadata?: unknown;
  /**
   * A última SAÍDA da empresa nesta conversa (#4636). `null` = a empresa nunca
   * escreveu: é a primeira mensagem do cliente, e a única em que o menu entra.
   *
   * Não se usa `service_started_at` para isso, e a medição é o motivo: o
   * `fn_service_inbound` carimba a coluna no INSERT da PRIMEIRA mensagem do
   * cliente (`supabase/baseline.sql:19805`) e a migração de reparo carimbou
   * todas as conversas que já existiam (`:20393`). Exigir o carimbo nulo nunca
   * enviaria menu nenhum — inclusive no caso que este teste guarda.
   */
  last_outbound_at?: string | null;
}

/**
 * O contato da conversa, nas colunas do gate de elegibilidade da IA.
 *
 * `force_human` e `ai_opt_out` são as duas marcas do "sempre atendimento
 * humano"; `tags` é a entrada das duas listas de etiqueta da organização.
 */
interface ContatoDoMenu {
  force_human?: boolean | null;
  ai_opt_out?: boolean | null;
  tags?: readonly string[] | null;
}

/** As duas listas de etiqueta da organização, lidas do `settings` já carregado. */
interface EtiquetasDaOrg {
  internas: readonly string[];
  daEquipe: readonly string[];
}

/**
 * POR QUE este contato NÃO recebe menu — ou `null`, se recebe.
 *
 * São as MESMAS réguas do gate da IA (`lib/ai/elegibilidade/gate.ts`), na mesma
 * ordem e com os mesmos predicados, e não uma segunda escrita delas:
 *
 *   • `force_human` e `ai_opt_out` — as marcas que o gate veta antes de tudo
 *     (`decidirElegibilidade`, motivos `force_human`/`ai_opt_out`). O botão
 *     "Marcar como sempre humano" grava as duas no CONTATO e não silencia
 *     conversa nenhuma; sem esta leitura, o menu ia para quem a empresa já
 *     declarou que só atende com gente (#4636);
 *   • `ehContatoInterno` (#2353) — o mesmo veto `contato_interno` do gate;
 *   • `ehContatoDaEquipe` (#3534) — a etiqueta que deixa o sócio ser atendido
 *     quando ele ESCREVE, mas não recebe automação da casa: é a régua que a
 *     abordagem fria já usa (`lib/prospecting/guard.ts`) e vale aqui pelo mesmo
 *     motivo — o menu é mensagem automática, não resposta de gente.
 *
 * Uma regra reescrita aqui divergiria do gate na primeira vez que alguém
 * acrescentasse um veto lá; por isso as listas e a comparação vêm de
 * `lib/schemas/settings` e de `lib/contacts/tags-*`.
 */
function motivoDoVetoDoContato(
  contato: ContatoDoMenu,
  etiquetas: EtiquetasDaOrg,
): string | null {
  if (contato.force_human === true) return "force_human";
  if (contato.ai_opt_out === true) return "ai_opt_out";
  if (ehContatoInterno(contato.tags, etiquetas.internas)) return "contato_interno";
  if (ehContatoDaEquipe(contato.tags, etiquetas.daEquipe)) return "contato_da_equipe";
  return null;
}

/** O cliente está no caminho errado? Silenciado ou com dono = não é menu. */
function conversaDisponivel(conversa: ConversaDoMenu, agora: Date): { livre: true } | { livre: false; motivo: string } {
  const status = conversa.status ?? null;
  if (status !== null && (STATUS_ENCERRADOS as readonly string[]).includes(status)) {
    return { livre: false, motivo: "conversa_encerrada" };
  }
  if ((conversa.assigned_to_user_id ?? null) !== null) {
    return { livre: false, motivo: "conversa_com_dono" };
  }
  const silencio = conversa.bot_silenced_until ?? null;
  if (silencio !== null) {
    // `infinity` é o silêncio do handoff: o bot nunca mais fala nesta conversa.
    if (silencio === "infinity") return { livre: false, motivo: "conversa_silenciada" };
    const ate = Date.parse(silencio);
    if (Number.isFinite(ate) && ate > agora.getTime()) {
      return { livre: false, motivo: "conversa_silenciada" };
    }
  }
  return { livre: true };
}

/**
 * Recebe uma mensagem de ENTRADA e conduz o menu.
 *
 * Devolve sempre um `AtendimentoDoMenu` — nunca lança. `tratado: false` é o
 * caminho de hoje, e é o desfecho de TODO erro de leitura: sem saber se o menu
 * está ligado, a mensagem não pode ser sequestrada.
 */
export async function atenderMenuSemIa(
  admin: SupabaseClient,
  entrada: MensagemDoMenu,
  portas: PortasDoMenu,
): Promise<AtendimentoDoMenu> {
  const agora = portas.agora ?? new Date();
  const log = portas.log ?? loggerPadrao;
  const chave = (sufixo: string): string =>
    `menu-de-atendimento:${entrada.conversationId}:${entrada.messageId ?? "sem-mensagem"}:${sufixo}`;

  // ── 1 · A chave do menu, da empresa ──────────────────────────────────────
  // O `settings` é lido uma vez só: dele saem a configuração do menu E as duas
  // listas de etiqueta que o veto de contato usa (#4636).
  let menu: MenuSemIa | null = null;
  let settings: unknown = null;
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", entrada.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    settings = (data as { settings?: unknown } | null)?.settings;
    menu = menuDeclarado(settings);
  } catch (erro) {
    log.warn("[menu-de-atendimento] leitura da configuração falhou — ingestão segue o fluxo de hoje", {
      organization_id: entrada.organizationId,
      detail: erroCurto(erro),
    });
    return { tratado: false, motivo: "erro_de_leitura" };
  }
  if (!menu || menu.ativa !== true) return { tratado: false, motivo: "menu_desligado" };

  // ── 1b · A porta da INSTALAÇÃO ───────────────────────────────────────────
  // Duas chaves, como na Ouvidoria: quem administra o servidor decide se o
  // módulo existe nesta instalação; a empresa decide se usa. A leitura é memoizada
  // (`moduloLigadoComMemo`) e só acontece quando a empresa JÁ ligou o menu —
  // quem nunca ligou não paga a consulta.
  let instalado = false;
  try {
    instalado = await moduloLigadoComMemo(admin, "menu_de_atendimento", agora.getTime());
  } catch (erro) {
    log.warn("[menu-de-atendimento] leitura do módulo da instalação falhou — menu desligado", {
      organization_id: entrada.organizationId,
      detail: erroCurto(erro),
    });
    instalado = false;
  }
  if (!instalado) return { tratado: false, motivo: "modulo_desligado" };

  // ── 2 · O CONTATO: a trava do gate da IA, lida aqui ──────────────────────
  // "Marcar como sempre humano" grava `force_human`/`ai_opt_out` no contato e
  // não silencia conversa nenhuma: até esta leitura, o menu ia para quem a
  // empresa já tinha declarado que só atende com gente (#4636). Os predicados
  // são os do gate (`motivoDoVetoDoContato`, acima) — o menu não reescreve a
  // regra, ele a respeita.
  let contato: ContatoDoMenu | null = null;
  try {
    const { data, error } = await admin
      .from("contacts")
      .select("force_human, ai_opt_out, tags")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    contato = data as ContatoDoMenu | null;
  } catch (erro) {
    log.warn("[menu-de-atendimento] leitura do contato falhou — ingestão segue o fluxo de hoje", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      detail: erroCurto(erro),
    });
    return { tratado: false, motivo: "erro_de_leitura" };
  }
  if (!contato) return { tratado: false, motivo: "contato_nao_encontrado" };

  const vetoDoContato = motivoDoVetoDoContato(contato, {
    internas: tagsInternasDaOrg(settings),
    daEquipe: tagsDaEquipeDaOrg(settings),
  });
  if (vetoDoContato) {
    log.info("[menu-de-atendimento] contato fora do menu automático", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      motivo: vetoDoContato,
    });
    return { tratado: false, motivo: vetoDoContato };
  }

  // ── 3 · A conversa: estado, dono, silêncio e saída na MESMA linha ────────
  let conversa: ConversaDoMenu | null = null;
  try {
    const { data, error } = await admin
      .from("conversations")
      .select("status, assigned_to_user_id, bot_silenced_until, metadata, last_outbound_at")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    conversa = data as ConversaDoMenu | null;
  } catch (erro) {
    log.warn("[menu-de-atendimento] leitura da conversa falhou — ingestão segue o fluxo de hoje", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      detail: erroCurto(erro),
    });
    return { tratado: false, motivo: "erro_de_leitura" };
  }
  if (!conversa) return { tratado: false, motivo: "conversa_nao_encontrada" };

  const disponivel = conversaDisponivel(conversa, agora);
  if (!disponivel.livre) return { tratado: false, motivo: disponivel.motivo };

  const estado = lerEstadoDoMenu(conversa.metadata, agora);
  const passo = decidirPassoDoMenu({
    menu,
    estado,
    texto: entrada.texto,
    messageId: entrada.messageId,
    // A empresa já escreveu? Então o atendimento começou e o menu não entra,
    // mesmo com o estado vencido — é o critério do módulo ("a primeira mensagem
    // de uma conversa sem dono"), e é o que impede o menu no meio do diálogo.
    atendimentoJaComecou: (conversa.last_outbound_at ?? null) !== null,
  });

  /**
   * Grava o estado e diz se deu. Usado pelos caminhos que DECIDEM depois da
   * leitura (repetição e queda para humano) — o envio do menu não passa mais por
   * aqui: o estado dele nasce na posse atômica (#5137).
   */
  const gravarEstado = async (novo: EstadoDoMenu): Promise<boolean> => {
    try {
      const { error } = await admin
        .from("conversations")
        .update({ metadata: comEstadoDoMenu(conversa?.metadata, novo) })
        .eq("organization_id", entrada.organizationId)
        .eq("id", entrada.conversationId);
      if (error) throw new Error(error.message);
      return true;
    } catch (erro) {
      log.error("[menu-de-atendimento] estado do menu NÃO gravado", {
        organization_id: entrada.organizationId,
        conversation_id: entrada.conversationId,
        detail: erroCurto(erro),
      });
      return false;
    }
  };

  const responder = async (texto: string, sufixo: string): Promise<boolean> => {
    try {
      return await portas.responde({ texto, chave: chave(sufixo) });
    } catch (erro) {
      log.warn("[menu-de-atendimento] resposta não enviada", {
        organization_id: entrada.organizationId,
        conversation_id: entrada.conversationId,
        sufixo,
        detail: erroCurto(erro),
      });
      return false;
    }
  };

  const passarParaFila = async (sufixo: string): Promise<boolean> => {
    try {
      const resultado = await portas.passaParaFila({ chave: chave(sufixo) });
      if (!resultado.ok) {
        log.warn("[menu-de-atendimento] passagem para a fila recusada", {
          organization_id: entrada.organizationId,
          conversation_id: entrada.conversationId,
          sufixo,
          motivo: resultado.motivo ?? "desconhecido",
        });
      }
      return resultado.ok;
    } catch (erro) {
      log.error("[menu-de-atendimento] passagem para a fila falhou", {
        organization_id: entrada.organizationId,
        conversation_id: entrada.conversationId,
        sufixo,
        detail: erroCurto(erro),
      });
      return false;
    }
  };

  /**
   * A saída de emergência do menu: a conversa vai para uma pessoa.
   *
   * Usada quando o cliente não consegue escolher, quando o arquivo não sai e
   * quando o estado não pôde ser gravado (menu em laço é pior que atendente).
   */
  const cairParaHumano = async (desfecho: string): Promise<AtendimentoDoMenu> => {
    // A frase segue o MOTIVO: quem não entendeu a escolha ouve "não entendi";
    // quem escolheu e a régua recusou ouve que está sendo encaminhado (foi o que
    // de fato aconteceu). Uma frase só para os dois casos mentiria em um deles.
    const texto =
      desfecho === "opcao_invalida" || desfecho === "estado_nao_gravado"
        ? TEXTO_DE_OPCAO_INVALIDA
        : TEXTO_DE_ENCAMINHAMENTO;
    const passou = await passarParaFila(desfecho);
    if (passou) {
      await responder(texto, `${desfecho}-aviso`);
    } else {
      await responder(TEXTO_DE_FALHA, `${desfecho}-falha`);
    }
    await gravarEstado(estadoConcluido(agora, desfecho, entrada.messageId));
    log.info("[menu-de-atendimento] conversa passada para humano", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      desfecho,
    });
    return { tratado: true, motivo: desfecho };
  };

  try {
    switch (passo.kind) {
      case "fora_do_menu":
        return { tratado: false, motivo: passo.motivo };

      case "reentrega":
        // O evento chegou duas vezes: a mensagem já foi tratada na primeira.
        return { tratado: true, motivo: "reentrega" };

      case "enviar_menu": {
        // ── A POSSE, NO BANCO, ANTES DE ENVIAR (#5137) ──────────────────────
        //
        // A decisão acima é PURA e só diz "esta mensagem pede o menu". Quem
        // decide se o menu SAI é o banco: a posse é um UPDATE condicional que
        // grava o estado `aguardando` apenas se a chave ainda não existir. Duas
        // entradas simultâneas da mesma conversa chegam aqui as duas — e só uma
        // grava. A outra NÃO manda menu: segue o fluxo normal da entrada.
        //
        // O estado é gravado na posse, e não depois do envio, porque é a própria
        // gravação que desempata. Se o envio falhar, `liberaPosse` desfaz — um
        // `aguardando` sem menu faria a próxima mensagem do cliente ser lida
        // como resposta a uma lista que ele nunca viu.
        const posse = await portas.tomaPosse({
          metadata: comEstadoDoMenu(conversa.metadata, estadoAguardando(agora, entrada.messageId)),
        });
        if (!posse.ok) {
          log.info("[menu-de-atendimento] outra entrada tomou o menu — esta segue o fluxo", {
            organization_id: entrada.organizationId,
            conversation_id: entrada.conversationId,
            message_id: entrada.messageId,
            motivo: posse.motivo,
          });
          return { tratado: false, motivo: posse.motivo };
        }

        const enviou = await responder(renderizarMenu(menu), "menu");
        if (!enviou) {
          await portas.liberaPosse({
            metadata: comEstadoDoMenu(conversa.metadata, null),
          });
          return { tratado: false, motivo: "envio_falhou" };
        }
        log.info("[menu-de-atendimento] menu enviado", {
          organization_id: entrada.organizationId,
          conversation_id: entrada.conversationId,
          opcoes: menu.opcoes.length,
        });
        return { tratado: true, motivo: "menu_enviado" };
      }

      case "repetir": {
        const texto = `${TEXTO_DE_REPETICAO}\n\n${renderizarOpcoes(menu)}`;
        const enviou = await responder(texto, "repeticao");
        if (!enviou) return { tratado: false, motivo: "envio_falhou" };
        const gravou = await gravarEstado(estadoRepetiu(agora, entrada.messageId));
        if (!gravou) return cairParaHumano("estado_nao_gravado");
        log.info("[menu-de-atendimento] opção inválida — menu repetido uma vez", {
          organization_id: entrada.organizationId,
          conversation_id: entrada.conversationId,
        });
        return { tratado: true, motivo: "menu_repetido" };
      }

      case "cair_para_humano":
        return cairParaHumano("opcao_invalida");

      case "escolher": {
        const opcao: OpcaoDoMenu = passo.opcao;

        if (opcao.tipo === "arquivo") {
          let enviou = false;
          try {
            enviou = await portas.enviaArquivo({
              mediaUrl: opcao.media_url,
              legenda: opcao.legenda ?? null,
              chave: chave(`opcao-${passo.posicao}-arquivo`),
            });
          } catch (erro) {
            log.error("[menu-de-atendimento] envio do arquivo falhou", {
              organization_id: entrada.organizationId,
              conversation_id: entrada.conversationId,
              posicao: passo.posicao,
              detail: erroCurto(erro),
            });
          }
          // Arquivo que não sai não é caminho: o cliente escolheu "receber o
          // arquivo" e ficou sem nada — quem resolve isso é uma pessoa.
          if (!enviou) return cairParaHumano("arquivo_falhou");
          await gravarEstado(estadoConcluido(agora, `arquivo:${passo.posicao}`, entrada.messageId));
          log.info("[menu-de-atendimento] opção de arquivo entregue", {
            organization_id: entrada.organizationId,
            conversation_id: entrada.conversationId,
            posicao: passo.posicao,
          });
          return { tratado: true, motivo: "arquivo_enviado" };
        }

        if (opcao.tipo === "pessoa") {
          let resultado: { ok: boolean; motivo?: string } = { ok: false, motivo: "sem_resultado" };
          try {
            resultado = await portas.passaParaPessoa({
              userId: opcao.user_id,
              chave: chave(`opcao-${passo.posicao}-pessoa`),
            });
          } catch (erro) {
            log.error("[menu-de-atendimento] passagem para a pessoa falhou", {
              organization_id: entrada.organizationId,
              conversation_id: entrada.conversationId,
              posicao: passo.posicao,
              detail: erroCurto(erro),
            });
          }
          if (!resultado.ok) {
            // A pessoa configurada pode ter saído da equipe. O cliente já
            // escolheu "falar com alguém": a fila é o mesmo pedido sem nome.
            log.warn("[menu-de-atendimento] pessoa indisponível — caindo para a fila", {
              organization_id: entrada.organizationId,
              conversation_id: entrada.conversationId,
              posicao: passo.posicao,
              motivo: resultado.motivo ?? "desconhecido",
            });
            return cairParaHumano("pessoa_indisponivel");
          }
          await responder(TEXTO_DE_ENCAMINHAMENTO, `opcao-${passo.posicao}-aviso`);
          await gravarEstado(estadoConcluido(agora, `pessoa:${passo.posicao}`, entrada.messageId));
          log.info("[menu-de-atendimento] conversa atribuída pela opção", {
            organization_id: entrada.organizationId,
            conversation_id: entrada.conversationId,
            posicao: passo.posicao,
          });
          return { tratado: true, motivo: "pessoa_atribuida" };
        }

        // `fila`: o caminho que a issue chama de "passar para uma fila".
        const passou = await passarParaFila(`opcao-${passo.posicao}-fila`);
        if (!passou) return cairParaHumano("fila_indisponivel");
        await responder(TEXTO_DE_ENCAMINHAMENTO, `opcao-${passo.posicao}-aviso`);
        await gravarEstado(estadoConcluido(agora, `fila:${passo.posicao}`, entrada.messageId));
        log.info("[menu-de-atendimento] conversa passada para a fila pela opção", {
          organization_id: entrada.organizationId,
          conversation_id: entrada.conversationId,
          posicao: passo.posicao,
        });
        return { tratado: true, motivo: "fila" };
      }

      default: {
        // Exaustão de tipos: um passo novo sem tratamento não compila.
        const inalcancavel: never = passo;
        return { tratado: false, motivo: `passo_desconhecido:${String(inalcancavel)}` };
      }
    }
  } catch (erro) {
    // Cinto: nenhuma porta deveria lançar, mas a ingestão não pode cair por
    // causa deste módulo. O log guarda a causa; o caminho de hoje segue.
    log.error("[menu-de-atendimento] falha inesperada — ingestão segue o fluxo de hoje", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      detail: erroCurto(erro),
    });
    return { tratado: false, motivo: "erro_interno" };
  }
}
