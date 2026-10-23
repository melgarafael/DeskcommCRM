/**
 * lib/contacts/agenda-do-celular.ts — o "Sincronizar agenda do celular" (#2736).
 *
 * Importa para o CRM os contatos que estão salvos na AGENDA do aparelho
 * pareado, lidos do canal em páginas — o método opcional `listPhonebook` do
 * adapter (o transporte expõe o `GET /api/contacts/all`, paginado). O aparelho
 * devolve o critério em DUAS formas: `isMyContact` ("está salvo na agenda",
 * WEBJS) ou, quando o motor não manda o marcador (NOWEB), o próprio `name` —
 * o nome que a equipe gravou no celular. `isWAContact` é "o número tem
 * WhatsApp" e `isMe` é o próprio operador (ver `salvoNaAgenda`).
 *
 * ─── A criação do contato NÃO é caminho novo ────────────────────────────────
 *
 * Quem grava é a MESMA RPC do webhook: `fn_upsert_wa_contact`, a mesma que a
 * ingestão de cada mensagem chama. Isso não é atalho, é a régua: aquela RPC
 * REENCONTRA o contato pelo telefone (nas duas grafias do nono dígito) e pelo
 * `wa_lid`, canoniza o número que grava, e cai no `unique_violation` como
 * último degrau — com `uniq_contacts_org_phone` (org + telefone) e
 * `uniq_contacts_org_wa_identity` no banco, um número já cadastrado NÃO pode
 * virar duplicata, nem sob corrida. Um terceiro caminho de INSERT em `contacts`
 * seria uma segunda regra de identidade para a mesma tabela, e elas divergem na
 * primeira exceção.
 *
 * O que AQUI existe de novo é só o que o webhook não precisa: a leitura
 * paginada da agenda, o filtro do que está salvo no aparelho, a pré-leitura em
 * bloco dos telefones já cadastrados (para contar "já existia" sem pagar uma
 * RPC por contato inútil) e o resumo que a tela mostra.
 *
 * ─── Contato que já está no CRM não é tocado ────────────────────────────────
 *
 * Quem já existe é CONTADO e pulado — sem UPDATE: o nome salvo à mão no CRM
 * vale mais que o da agenda do aparelho, e o vínculo de identidade WhatsApp
 * (`wa_identity`) a própria mensagem seguinte faz, pelo caminho de sempre.
 *
 * ─── Dois tetos, e a leitura RETOMA de onde parou ───────────────────────────
 *
 * Ler a agenda tem teto (`TETO_DE_LEITURA`): a agenda do aparelho devolve
 * TAMBÉM quem nunca foi salvo (só conversou), então um número movido pode ter
 * milhares de linhas, e laço sem teto é como um webhook prende o runtime.
 * Importar tem teto próprio (`TETO_DE_IMPORTACOES`), na mesma régua do import
 * de planilha (500 linhas por vez).
 *
 * ─── O clique seguinte começa na LINHA CERTA, não no zero ───────────────────
 *
 * A leitura é um CURSOR: o resumo devolve `proximo_offset`, e o clique seguinte
 * passa esse offset de volta ao serviço. Sem isso cada clique relia sempre as
 * mesmas mil primeiras linhas e o corte caía no milésimo: numa agenda de 1.500
 * salvos, quatro cliques importavam 500, 500, 0 e 0, todos com `truncado: true`
 * — os 500 depois do milésimo NUNCA entravam (medido pelo mantenedor em
 * 16/10, ponto 2 do CR do #2776).
 *
 * O cursor é a linha do primeiro candidato que NÃO foi gravado, e não o fim da
 * leitura: como os dois tetos são diferentes (lê 1.000, grava 500), a leitura
 * vai além do que a importação alcançou, e retomar do fim da leitura pularia
 * esses 500 para sempre. Quando foi o teto de LEITURA que cortou (tudo o que
 * foi lido já foi processado), o cursor é o fim da leitura; quando a página
 * veio curta, é `null` — a agenda acabou e não há próximo clique.
 *
 * A ordenação fixa por `id` (`sortBy=id&sortOrder=asc`, no cliente) é o que faz
 * esse offset valer de um clique para o outro — sem ela, "continuar de onde
 * parou" seria uma aposta.
 */
import { audit as auditReal } from "@/lib/audit";
import type { ContatoDoAparelho } from "@/lib/channels";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { nomeGravavel } from "@/lib/contacts/nome-da-agenda";
import { ORIGEM_AGENDA_DO_CELULAR } from "@/lib/leads/origem-do-contato";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** O que o transporte traz por chamada — o mesmo `limit` que a doc do aparelho usa de fábrica. */
export const TAMANHO_DA_PAGINA = 100;

/**
 * Teto de contatos LIDOS do aparelho por sincronização (10 páginas).
 *
 * O `contacts/all` devolve a agenda E quem só conversou; sem este corte um
 * número com histórico grande prenderia a rota por tempo indeterminado. Quem
 * tem mais que isso continua no próximo clique, que passa `proximo_offset`
 * (a leitura é um cursor, nunca recomeça do zero — ver o cabeçalho).
 */
export const TETO_DE_LEITURA = 1000;

/**
 * Teto de contatos CRIADOS por sincronização — a mesma régua de 500 linhas do
 * import de planilha (`CSV_MAX_DATA_ROWS`). O custo de uma criação é uma RPC +
 * um evento, um por linha; mais que isso numa única requisição é como um
 * timeout vira perda aparente.
 */
export const TETO_DE_IMPORTACOES = 500;

/**
 * Telefones por consulta de pré-leitura.
 *
 * Cada telefone vira DUAS variantes de busca (com/sem nono dígito), então 100
 * números são ~200 valores no `in()` — o bastante para poupar idas ao banco e
 * pouco bastante para o GET do PostgREST não virar URL de dezenas de KB.
 */
const TELEFONES_POR_CONSULTA = 100;

export interface ResumoDaAgenda {
  /** Contatos lidos na agenda do aparelho (todas as páginas). */
  lidos: number;
  /** Criados no CRM nesta sincronização. */
  importados: number;
  /** Já estavam no CRM pelo mesmo telefone — nada foi reescrito nem duplicado. */
  ja_existentes: number;
  /** Fora da régua (não salvo na agenda, número do operador, grupo, sem WhatsApp ou sem número utilizável) ou repetido na própria agenda. */
  ignorados: number;
  /** Falhas de gravação — cada uma logada, e as demais seguem. */
  erros: number;
  /** Bateu num teto (leitura ou importação) — clicar de novo continua. */
  truncado: boolean;
  /**
   * A LINHA da agenda do aparelho por onde o próximo clique começa, ou `null`
   * quando não há mais nada a ler.
   *
   * Não é "o fim do que eu li": é a linha do primeiro candidato que ainda NÃO
   * foi gravado. Com o teto de importação (500) menor que o de leitura (1.000),
   * esses dois números divergem, e devolver o fim da leitura pularia os 500
   * lidos-e-não-gravados para sempre. Quem chama (a rota, e a tela) só precisa
   * passá-lo de volta no clique seguinte como `offset`.
   */
  proximo_offset: number | null;
}

/** O que a agenda devolveu e passou na régua — pronto para a RPC do webhook. */
interface Candidato {
  /** `<número>@c.us` — o mesmo chatId que o webhook passa como auditoria. */
  chatId: string;
  /** E.164 com `+`. A RPC canônica (nono dígito) faz o resto. */
  telefone: string;
  /** O apelido do PERFIL (`pushname`) — o mesmo dado que o webhook passa à RPC. */
  notify: string | null;
  /**
   * O nome que a equipe SALVOU no celular. Vai para `address_book_name`, o
   * campo que só a equipe vê — nunca para `name`/`display_name`, que o
   * `{{nome}}` das campanhas lê (decisão do mantenedor no #2439; doc 158).
   *
   * Nas telas da equipe este é o nome EXIBIDO: o título da ficha e a lista
   * mostram `name`, e na falta dele o nome da agenda (`rotuloParaAEquipe`). O
   * apelido do PERFIL do WhatsApp fica em `display_name` e no campo
   * "Nome · WhatsApp" — é ele, não o da agenda, que as mensagens usam.
   */
  agenda: string | null;
  /**
   * A linha da agenda do aparelho de onde este candidato veio. É o cursor: se a
   * importação parar ANTES dele, o próximo clique recomeça exatamente aqui.
   */
  linha: number;
}

export interface AgendaDeps {
  /** Uma página crua do transporte. Pode lançar (rede/teto/HTTP) — ver `listarAgendaDoAparelho`. */
  listarPagina(session: string, pagina: { limit: number; offset: number }): Promise<ContatoDoAparelho[]>;
  /**
   * Telefones da organização que já batem com estas variantes. Devolve o
   * CONJUNTO de variantes achadas (as duas grafias de cada linha), para o
   * mesmo `Set` decidir tanto o pré-filtro quanto o dedup dentro do lote.
   */
  telefonesExistentes(organizationId: string, variantes: string[]): Promise<Set<string>>;
  /** O upsert ATÔMICO do webhook (`fn_upsert_wa_contact`). Devolve o id do contato. */
  upsertContato(e: { organizationId: string; telefone: string; chatId: string; notify: string | null }): Promise<string | null>;
  /** `contact.created` para o contato que NASCEU agora — o mesmo evento do import de planilha. */
  emitirContatoCriado(e: { organizationId: string; contactId: string; requestId: string }): Promise<void>;
  /**
   * Carimba `source = 'whatsapp_agenda'` nos contatos que NASCERAM nesta
   * sincronização. A RPC do webhook grava `source = 'whatsapp'`, e sem o
   * carimbo quem veio da agenda ficaria igual a quem mandou mensagem — a ficha
   * e o filtro de origem não teriam como separar os dois (decisão do doc 158).
   */
  marcarOrigem(organizationId: string, contactIds: string[]): Promise<void>;
  /** Grava o nome da agenda em `address_book_name` do contato que NASCEU agora. */
  gravarNomeDaAgenda(organizationId: string, contactId: string, nome: string): Promise<void>;
  /**
   * A trilha do gesto — o MESMO `audit()` que o resto do sistema escreve.
   *
   * O tipo não é reescrito aqui de propósito: `Parameters<typeof auditReal>[0]`
   * é a definição da própria `audit()`, então `resourceId` nasce uuid-ou-nulo e
   * `action` nasce da lista de ações lá atrás. Anotar a forma à mão seria uma
   * segunda fonte do mesmo contrato — e a segunda fonte é a que diverge na
   * primeira exceção (visto e medido: `tests/unit/audit-resource-id-e-uuid`).
   */
  audit: (entry: Parameters<typeof auditReal>[0]) => Promise<void>;
}

/** Grupos, newsletters e difusão não são pessoa — o mesmo corte do inbound. */
const SUFIXOS_DE_PESSOA = ["@c.us", "@s.whatsapp.net"];

/**
 * O contato do aparelho ESTÁ salvo na agenda dele?
 *
 * Três estados, porque os dois motores do canal não devolvem a mesma forma:
 *
 * - `isMyContact === true` — salvo; importa (é a forma do WEBJS).
 * - `isMyContact === false` — NÃO salvo: o marcador explícito manda, mesmo que
 *   venha um `name` (o nome pode ser o do perfil do WhatsApp).
 * - `isMyContact` AUSENTE — o motor não manda o marcador (o NOWEB entrega
 *   `{id, lid, name, pushname, verifiedName, imgUrl, status}`, sem ele). Aí o
 *   `name` É o nome salvo no celular, e a presença dele é a única prova de
 *   agenda que existe. `pushname` descreve o PERFIL e NÃO significa salvo — um
 *   contato só com pushname não está na agenda.
 *
 * Sem esta terceira coluna, uma instalação padrão (NOWEB) lê N contatos e
 * importa ZERO: todo item chega sem `isMyContact` e caía no mesmo descarte de
 * quem está explicitamente fora da agenda.
 */
function salvoNaAgenda(c: ContatoDoAparelho): boolean {
  if (c.isMyContact === true) return true;
  if (c.isMyContact === false) return false;
  return (c.name ?? "").trim() !== "";
}

/**
 * O contato do aparelho É uma pessoa SALVA na agenda, com número utilizável?
 *
 * Devolve o telefone quando sim, e o MOTIVO quando não — o motivo vira contagem
 * no resumo, porque "por que 300 dos 500 foram ignorados?" é a primeira pergunta
 * de quem olha o resumo e não tem resposta se o descarte for mudo.
 */
export function candidatoDaAgenda(c: ContatoDoAparelho): { telefone: string } | { ignorado: string } {
  if (!salvoNaAgenda(c)) return { ignorado: "nao_salvo_na_agenda" };
  if (c.isMe === true) return { ignorado: "numero_do_operador" };
  if (c.isWAContact === false) return { ignorado: "sem_whatsapp" };
  if (SUFIXOS_DE_PESSOA.every((s) => !c.id.endsWith(s))) return { ignorado: "nao_e_pessoa" };
  // Teto antes de qualquer varredura: o id vem de FORA (resposta do canal),
  // mesma disciplina de `telefoneDoJid` no ingest.
  const semSufixo = c.id.length > 128 ? "" : c.id.slice(0, c.id.indexOf("@"));
  let digitos = "";
  for (const ch of semSufixo) if (ch >= "0" && ch <= "9") digitos += ch;
  // Faixa E.164: 8 a 15 dígitos — fora disso não é número discável.
  if (digitos.length < 8 || digitos.length > 15) return { ignorado: "sem_numero_utilizavel" };
  return { telefone: `+${digitos}` };
}

/**
 * Lê a agenda página a página, A PARTIR de `inicio`, e devolve os candidatos +
 * o resumo da leitura + o cursor do próximo clique.
 *
 * A ordenação fixa por `id` (`sortBy=id&sortOrder=asc`, no cliente) é o que
 * faz o offset avançar sem pular nem repetir — sem ela, "página seguinte" é uma
 * aposta e o corte silencioso perde contato.
 */
async function lerAgenda(
  deps: AgendaDeps,
  session: string,
  inicio: number,
): Promise<{ candidatos: Candidato[]; lidos: number; truncado: boolean; proximoOffset: number | null }> {
  const candidatos: Candidato[] = [];
  const vistos = new Set<string>();
  let lidos = 0;
  let offset = inicio;
  for (;;) {
    const pagina = await deps.listarPagina(session, { limit: TAMANHO_DA_PAGINA, offset });
    lidos += pagina.length;
    for (const [i, c] of pagina.entries()) {
      const r = candidatoDaAgenda(c);
      if ("ignorado" in r) continue;
      const telefone = r.telefone;
      const variantes = phoneLookupVariants(telefone);
      // O MESMO número duas vezes na agenda (com e sem nono dígito) é UM
      // contato — a segunda entrada não cria nada nem conta como importada.
      if (variantes.some((v) => vistos.has(v))) continue;
      for (const v of variantes) vistos.add(v);
      candidatos.push({
        chatId: c.id,
        telefone,
        notify: c.pushname ?? null,
        agenda: nomeGravavel(c.name),
        // A linha ABSOLUTA da agenda — é ela que o próximo clique passa como
        // offset, e não a posição do candidato na lista desta passada (as
        // linhas descartadas no meio mudam uma coisa da outra).
        linha: offset + i,
      });
    }
    // Página curta = o aparelho não tem mais. Não há próximo clique.
    if (pagina.length < TAMANHO_DA_PAGINA) {
      return { candidatos, lidos, truncado: false, proximoOffset: null };
    }
    offset += TAMANHO_DA_PAGINA;
    // Teto de leitura: tem mais, e a próxima passada começa AQUI (não no zero).
    if (lidos >= TETO_DE_LEITURA) {
      return { candidatos, lidos, truncado: true, proximoOffset: offset };
    }
  }
}

/** Os telefones que JÁ são contato da org, em consultas de tamanho honesto. */
async function telefonesExistentesEmBlocos(
  deps: AgendaDeps,
  organizationId: string,
  candidatos: Candidato[],
): Promise<Set<string>> {
  const achados = new Set<string>();
  for (let i = 0; i < candidatos.length; i += TELEFONES_POR_CONSULTA) {
    const bloco = candidatos.slice(i, i + TELEFONES_POR_CONSULTA);
    const variantes = [...new Set(bloco.flatMap((c) => phoneLookupVariants(c.telefone)))];
    const doBanco = await deps.telefonesExistentes(organizationId, variantes);
    for (const v of doBanco) achados.add(v);
  }
  return achados;
}

export async function sincronizarAgendaDoCelular(
  deps: AgendaDeps,
  e: {
    organizationId: string;
    session: string;
    actorUserId: string;
    requestId: string;
    /** De onde ESTE clique começa na agenda — o `proximo_offset` do anterior. */
    offset?: number;
  },
): Promise<ResumoDaAgenda> {
  const resumo: ResumoDaAgenda = {
    lidos: 0,
    importados: 0,
    ja_existentes: 0,
    ignorados: 0,
    erros: 0,
    truncado: false,
    proximo_offset: null,
  };

  // Offset vem de fora (body da rota): nem negativo, nem fracionário, nem NaN.
  const inicio = Math.max(0, Math.trunc(e.offset ?? 0));
  const leitura = await lerAgenda(deps, e.session, inicio);
  resumo.lidos = leitura.lidos;
  resumo.truncado = leitura.truncado;
  resumo.proximo_offset = leitura.proximoOffset;
  // O que a leitura DESCARTOU (não salvo na agenda, grupo, sem WhatsApp…) —
  // contado aqui, porque o resumo sem este número parece "o aparelho só tinha
  // estes 12 contatos".
  resumo.ignorados = leitura.lidos - leitura.candidatos.length;

  const existentes = await telefonesExistentesEmBlocos(deps, e.organizationId, leitura.candidatos);
  const criados: string[] = [];

  for (const candidato of leitura.candidatos) {
    if (resumo.importados >= TETO_DE_IMPORTACOES) {
      resumo.truncado = true;
      // Retoma NA LINHA deste candidato: ele NÃO foi gravado, e o fim da
      // leitura (que pode estar bem à frente) o pularia para sempre.
      resumo.proximo_offset = candidato.linha;
      break;
    }
    const variantes = phoneLookupVariants(candidato.telefone);
    // No CRM (pela pré-leitura) ou recém-criado neste mesmo lote: não toca.
    if (variantes.some((v) => existentes.has(v))) {
      resumo.ja_existentes += 1;
      continue;
    }
    try {
      const id = await deps.upsertContato({
        organizationId: e.organizationId,
        telefone: candidato.telefone,
        chatId: candidato.chatId,
        notify: candidato.notify,
      });
      if (!id) {
        resumo.erros += 1;
        continue;
      }
      resumo.importados += 1;
      criados.push(id);
      // Reserva as variantes ANTES do evento: a próxima entrada de mesmo número
      // neste lote cai em "já existente" em vez de pagar a RPC de novo.
      for (const v of variantes) existentes.add(v);
      if (candidato.agenda) {
        try {
          await deps.gravarNomeDaAgenda(e.organizationId, id, candidato.agenda);
        } catch (err) {
          // O contato já existe e não se desfaz; o cron de nomes da agenda
          // (`contact-names`) pergunta de novo a quem ficou sem.
          logger.warn("contacts.sync-agenda: contato criado sem o nome da agenda", {
            organization_id: e.organizationId,
            request_id: e.requestId,
            detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
          });
        }
      }
      try {
        await deps.emitirContatoCriado({ organizationId: e.organizationId, contactId: id, requestId: e.requestId });
      } catch (err) {
        // Mesma régua do import de planilha: o evento é para quem consome
        // `contact.created`; a criação JÁ aconteceu e não pode desfazer-se.
        logger.warn("contacts.sync-agenda: contato criado sem evento contact.created", {
          organization_id: e.organizationId,
          request_id: e.requestId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      // Falha de um contato não pode matar o lote — a planilha de 400 nomes não
      // morre pelo telefone malformado da linha 7, e esta lista não morre
      // quando o transporte devolve 500 na centésima RPC.
      resumo.erros += 1;
      logger.warn("contacts.sync-agenda: contato não gravado (o lote seguiu)", {
        organization_id: e.organizationId,
        request_id: e.requestId,
        detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
      });
    }
  }

  for (let i = 0; i < criados.length; i += TELEFONES_POR_CONSULTA) {
    try {
      await deps.marcarOrigem(e.organizationId, criados.slice(i, i + TELEFONES_POR_CONSULTA));
    } catch (err) {
      // O contato já existe e não se desfaz; o que falta é só o carimbo.
      logger.warn("contacts.sync-agenda: contatos criados sem a origem da agenda", {
        organization_id: e.organizationId,
        request_id: e.requestId,
        detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
      });
    }
  }

  await deps.audit({
    action: "contacts.synced_from_phone",
    actorUserId: e.actorUserId,
    organizationId: e.organizationId,
    resourceType: "contact",
    resourceId: null,
    requestId: e.requestId,
    metadata: { ...resumo },
  });

  return resumo;
}

/**
 * Quem LÊ a agenda chega de fora, já resolvido na fronteira de canal: o
 * `listarPagina` que a rota monta a partir do adapter do canal (o método
 * `listPhonebook`, presente só onde há um aparelho pareado para ler).
 *
 * Aqui dentro não existe nome de provider nenhum — este módulo pergunta o que
 * a agenda tem, nunca com quem ele fala, que é o invariante 1 da doutrina.
 * Sem a função, não há agenda a ler: quem chama decide o que comunicar.
 */
export function criarDepsDeAgenda(
  admin: Admin,
  listarPagina: AgendaDeps["listarPagina"],
): AgendaDeps {
  return {
    listarPagina,
    telefonesExistentes: async (organizationId, variantes) => {
      const { data, error } = await admin
        .from("contacts")
        .select("phone_number")
        .eq("organization_id", organizationId)
        .not("phone_number", "is", null)
        // Mesma régua do `on conflict`/select da RPC e do índice parcial
        // `uniq_contacts_org_phone`: contato mesclado não é reencontro — ele já
        // aponta para o vencedor da fusão.
        .is("is_merged_into", null)
        .in("phone_number", variantes);
      if (error) throw new Error(error.message);
      const achados = new Set<string>();
      for (const r of data ?? []) {
        for (const v of phoneLookupVariants((r as { phone_number: string }).phone_number)) achados.add(v);
      }
      return achados;
    },
    upsertContato: async ({ organizationId, telefone, chatId, notify }) => {
      const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
        p_org: organizationId,
        p_kind: "phone",
        p_phone: telefone,
        p_lid: null,
        p_chat_id: chatId,
        p_notify: notify,
      } as never);
      if (error) throw new Error(error.message);
      return (data as string) ?? null;
    },
    emitirContatoCriado: async ({ organizationId, contactId, requestId }) => {
      await admin
        .rpc("emit_event", {
          p_event_type: "contact.created",
          p_entity_kind: "contact",
          p_entity_id: contactId,
          p_payload: { source: ORIGEM_AGENDA_DO_CELULAR, has_phone: true, synced_from_phone: true },
          p_metadata: { request_id: requestId, actor_type: "user" },
          p_organization_id: organizationId,
        })
        .then(({ error }) => {
          // Lança para o `catch` de quem chama, que já registra pelo logger.
          if (error) throw new Error(error.message);
        });
    },
    marcarOrigem: async (organizationId, contactIds) => {
      const { error } = await admin
        .from("contacts")
        .update({ source: ORIGEM_AGENDA_DO_CELULAR })
        .eq("organization_id", organizationId)
        // Só o que a RPC acabou de gravar como `whatsapp`: um contato que outro
        // caminho criou com outra origem no meio do lote não é reescrito.
        .eq("source", "whatsapp")
        .in("id", contactIds);
      if (error) throw new Error(error.message);
    },
    gravarNomeDaAgenda: async (organizationId, contactId, nome) => {
      const { error } = await admin
        .from("contacts")
        .update({ address_book_name: nome })
        .eq("organization_id", organizationId)
        .eq("id", contactId)
        // Não reescreve um nome da agenda que outro caminho já gravou.
        .is("address_book_name", null);
      if (error) throw new Error(error.message);
    },
    audit: (entry) => auditReal(entry),
  };
}
