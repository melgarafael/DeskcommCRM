/**
 * lib/contacts/agenda-do-celular.ts — o "Sincronizar agenda do celular" (#2736).
 *
 * Importa para o CRM os contatos que estão salvos na AGENDA do aparelho
 * pareado, lidos do canal em páginas — o método opcional `listPhonebook` do
 * adapter (o transporte expõe o `GET /api/contacts/all`, paginado). O aparelho
 * já devolve o critério pronto: `isMyContact` é "está salvo na agenda",
 * `isWAContact` é "o número tem WhatsApp" e `isMe` é o próprio operador.
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
 * ─── Dois tetos, e o segundo é retomável ────────────────────────────────────
 *
 * Ler a agenda tem teto (`TETO_DE_LEITURA`): a agenda do aparelho devolve
 * TAMBÉM quem nunca foi salvo (só conversou), então um número movido pode ter
 * milhares de linhas, e laço sem teto é como um webhook prende o runtime.
 * Importar tem teto próprio (`TETO_DE_IMPORTACOES`), na mesma régua do import
 * de planilha (500 linhas por vez). Passou do teto? `truncado: true` no
 * resumo, e CLICAR DE NOVO continua de onde parou — o que já entrou aparece
 * como "já existente", e a sincronização é idempotente por construção (é a RPC
 * que decide o reencontro).
 */
import { audit as auditReal } from "@/lib/audit";
import type { ContatoDoAparelho } from "@/lib/channels";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
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
 * tem mais que isso continua no próximo clique (a ordenação fixa por `id`
 * mantém a paginação estável entre chamadas).
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
}

/** O que a agenda devolveu e passou na régua — pronto para a RPC do webhook. */
interface Candidato {
  /** `<número>@c.us` — o mesmo chatId que o webhook passa como auditoria. */
  chatId: string;
  /** E.164 com `+`. A RPC canônica (nono dígito) faz o resto. */
  telefone: string;
  /** Nome salvo na agenda; na falta, o pushname do perfil. */
  notify: string | null;
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
 * O contato do aparelho É uma pessoa SALVA na agenda, com número utilizável?
 *
 * Devolve o telefone quando sim, e o MOTIVO quando não — o motivo vira contagem
 * no resumo, porque "por que 300 dos 500 foram ignorados?" é a primeira pergunta
 * de quem olha o resumo e não tem resposta se o descarte for mudo.
 */
export function candidatoDaAgenda(c: ContatoDoAparelho): { telefone: string } | { ignorado: string } {
  if (c.isMyContact !== true) return { ignorado: "nao_salvo_na_agenda" };
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
 * Lê a agenda página a página e devolve os candidatos + o resumo da leitura.
 *
 * A ordenação fixa por `id` (`sortBy=id&sortOrder=asc`, no cliente) é o que
 * faz o offset avançar sem pular nem repetir — sem ela, "página seguinte" é uma
 * aposta e o corte silencioso perde contato.
 */
async function lerAgenda(
  deps: AgendaDeps,
  session: string,
): Promise<{ candidatos: Candidato[]; lidos: number; truncado: boolean }> {
  const candidatos: Candidato[] = [];
  const vistos = new Set<string>();
  let lidos = 0;
  let offset = 0;
  for (;;) {
    const pagina = await deps.listarPagina(session, { limit: TAMANHO_DA_PAGINA, offset });
    lidos += pagina.length;
    for (const c of pagina) {
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
        notify: c.name ?? c.pushname ?? null,
      });
    }
    // Página curta = o aparelho não tem mais. Página cheia no teto = tem mais,
    // e é da próxima vez (ou do próximo clique).
    if (pagina.length < TAMANHO_DA_PAGINA) return { candidatos, lidos, truncado: false };
    offset += TAMANHO_DA_PAGINA;
    if (lidos >= TETO_DE_LEITURA) return { candidatos, lidos, truncado: true };
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
  e: { organizationId: string; session: string; actorUserId: string; requestId: string },
): Promise<ResumoDaAgenda> {
  const resumo: ResumoDaAgenda = {
    lidos: 0,
    importados: 0,
    ja_existentes: 0,
    ignorados: 0,
    erros: 0,
    truncado: false,
  };

  const leitura = await lerAgenda(deps, e.session);
  resumo.lidos = leitura.lidos;
  resumo.truncado = leitura.truncado;
  // O que a leitura DESCARTOU (não salvo na agenda, grupo, sem WhatsApp…) —
  // contado aqui, porque o resumo sem este número parece "o aparelho só tinha
  // estes 12 contatos".
  resumo.ignorados = leitura.lidos - leitura.candidatos.length;

  const existentes = await telefonesExistentesEmBlocos(deps, e.organizationId, leitura.candidatos);
  const criados: string[] = [];

  for (const candidato of leitura.candidatos) {
    if (resumo.importados >= TETO_DE_IMPORTACOES) {
      resumo.truncado = true;
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
    audit: (entry) => auditReal(entry),
  };
}
