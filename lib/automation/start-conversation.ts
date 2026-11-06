import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
/**
 * Conversa programática p/ automação: acha a conversa aberta do contato na
 * sessão, REABRE a fechada, ou cria uma nova. Distinto da ingestão WAHA (que
 * usa RPCs de identidade) — aqui contato e sessão já são conhecidos.
 *
 * Por que reabrir: o índice uniq_conversations_1to1_per_contact_session é
 * único por (org, contato, sessão) SEM filtro de status — um contato cuja
 * única conversa está closed/archived tornaria o INSERT impossível (23505) e
 * o envio automatizado falharia pra sempre. Reabrir é também o comportamento
 * certo de produto: a conversa É o thread com aquele contato naquele número.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_DE_TELEFONE,
  type ProviderDeMensagem,
} from "@/lib/channels/capabilities";
import { canalDesativado } from "@/lib/channels/desativado";


/** O que o CHAMADOR sabe sobre o destino e esta porta não pode adivinhar. */
export interface PreferenciaDeSessao {
  /**
   * O destino é um TELEFONE — o número que a pessoa deixou ou o `phone_number`
   * do contato. Só quem resolveu o telefone sabe disso; a organização pode ter
   * Instagram e WhatsApp ao mesmo tempo.
   */
  preferirTelefone?: boolean;
}

/**
 * Sessão viva da org: WORKING primeiro; senão qualquer uma não arquivada.
 *
 * ─── A PREFERÊNCIA DO CHAMADOR (#3358) ───────────────────────────────────────
 * A regra sozinha escolhe a sessão de MENSAGEM `WORKING` mais ANTIGA da
 * organização. Isso está errado quando o destino é um TELEFONE: numa
 * organização que conectou o Instagram/Facebook antes do WhatsApp — a ordem em
 * que as conexões costumam ser feitas — a escolhida era a social, e a rede
 * social não tem telefone (o contato de lá é outro endereço, e o envio fora da
 * janela de 24h é recusado). O lembrete de tarefa saía pelo Instagram e não
 * chegava.
 *
 * Com `preferirTelefone`, os degraus passam a ser:
 *
 *   telefone WORKING → telefone qualquer → mensagem WORKING → mensagem qualquer
 *
 * A preferência vem ANTES do degrau de vivacidade de propósito: um canal social
 * `WORKING` continua sem alcançar telefone nenhum, então preferi-lo ali não é
 * escolher o melhor dos dois — é escolher o único que não pode funcionar, e
 * quem recebe a falha lê "confira a conexão" sem haver conexão a conferir.
 *
 * Sem sessão de WhatsApp na organização, a cadeia termina na regra de sempre (a
 * de mensagem mais antiga) — a preferência reordena, nunca inventa canal. E
 * quem não passa a opção continua escolhendo exatamente como antes. O `create`
 * de contato já passa (`lib/contacts/conversa-ao-criar.ts`). A conversa
 * compartilhada só cai neste fallback quando chega sem `channel_session_id`
 * (`POST /api/v1/conversations/open-with-contact`), e ali passa
 * `preferirTelefone` quando o pedido traz telefone (#3483). O MCP exige a
 * sessão de quem chama e nunca chega ao fallback.
 *
 * ─── O CANAL DESLIGADO NÃO ENTRA NA ESCOLHA (#4092) ──────────────────────────
 * `metadata.disabled` é a intenção declarada do dono do número (#2318): o canal
 * não entra na inbox, não acorda a IA, não envia. A regra acima não conhecia a
 * chave e pegava a `WORKING` mais antiga assim mesmo — numa organização em que
 * o número velho foi DESLIGADO e um novo foi conectado depois, toda abertura
 * sem canal escolhido caía no desligado e era recusada (409 `session_unavailable`)
 * mesmo havendo outro canal pronto. O pulo vale em TODOS os degraus: o que a
 * escada decide é a ORDEM (WORKING antes da degradação; telefone antes de
 * mensagem), não a elegibilidade. Quem diz "desligado" é `canalDesativado`
 * (`lib/channels/desativado.ts`) — a mesma régua do resto do produto, leitura
 * estrita de `=== true`, nunca um segundo critério escrito aqui.
 */
export interface EscolhaDeSessao {
  /** A sessão escolhida, ou `null` quando nenhuma pode enviar. */
  id: string | null;
  /**
   * Havia canal de MENSAGEM na organização e todos estavam DESLIGADOS pelo
   * operador. `id` e `todosDesligados` são perguntas diferentes: "não há canal
   * nenhum" e "desligaram todos" entregam `id: null`, mas só o segundo mantém a
   * recusa de antes — `session_unavailable` (409), que manda reativar ou
   * escolher outro canal. Virar 404 ("sessão não encontrada") esconderia a
   * causa que o operador precisa ver.
   */
  todosDesligados: boolean;
}

export async function escolherSessaoParaEnvio(
  supabase: SupabaseClient,
  organizationId: string,
  preferencia: PreferenciaDeSessao = {},
): Promise<EscolhaDeSessao> {
  /** Alguma linha da escada foi pulada por estar desligada? */
  let viuDesligado = false;

  const listar = (
    providers: readonly ProviderDeMensagem[],
    soWorking: boolean,
    ignorarArquivadas: boolean,
  ) => {
    let q = supabase
      .from("channel_sessions")
      // `metadata` vem porque é nele que mora o `disabled`, e o `limit(1)`
      // saiu: o desligado pode ser justamente o PRIMEIRO da ordem, e cortar a
      // lista no banco antes de olhar o metadata é o defeito que esta issue
      // fecha. A escolha continua sendo a mais antiga — só que entre as que
      // podem enviar.
      .select("id, metadata")
      .eq("organization_id", organizationId);
    // Voz não manda texto: escolher a linha de chamada aqui faria a automação
    // "enviar" por um canal sem transporte de mensagem (spec 18).
    q = q.in("provider", [...providers]);
    if (soWorking) q = q.eq("status", "WORKING");
    if (ignorarArquivadas) q = q.is(ARCHIVED_AT, null);
    return q.order("created_at", { ascending: true });
  };
  const tentar = async (
    providers: readonly ProviderDeMensagem[],
    soWorking: boolean,
  ) => {
    const { data } = await queryTolerantToMissingArchived(
      () => listar(providers, soWorking, true),
      () => listar(providers, soWorking, false),
    );
    const linhas = (data as Array<{ id: string; metadata?: unknown }> | null) ?? [];
    const habilitada = linhas.find((linha) => !canalDesativado(linha.metadata));
    if (!habilitada && linhas.length > 0) viuDesligado = true;
    return habilitada?.id ?? null;
  };

  // Sem a preferência a lista tem UMA entrada e os degraus são os mesmos de
  // antes desta issue: WORKING, senão qualquer uma não arquivada.
  const filtros: ReadonlyArray<readonly ProviderDeMensagem[]> = preferencia.preferirTelefone
    ? [PROVIDERS_DE_TELEFONE, PROVIDERS_DE_MENSAGEM]
    : [PROVIDERS_DE_MENSAGEM];

  for (const providers of filtros) {
    for (const soWorking of [true, false]) {
      const id = await tentar(providers, soWorking);
      if (id) return { id, todosDesligados: false };
    }
  }
  return { id: null, todosDesligados: viuDesligado };
}

/**
 * A sessão por onde a automação envia — o id, ou `null` quando nenhuma pode.
 *
 * Continua devolvendo só o id porque é o que os chamadores precisam; quem tem
 * de DISTINGUIR "não há canal" de "todos desligados" usa
 * `escolherSessaoParaEnvio`, que responde as duas coisas.
 */
export async function sessaoProntaParaEnvio(
  supabase: SupabaseClient,
  organizationId: string,
  preferencia: PreferenciaDeSessao = {},
): Promise<string | null> {
  return (await escolherSessaoParaEnvio(supabase, organizationId, preferencia)).id;
}

export async function ensureConversation(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
): Promise<string> {
  return (await beginServiceAtOrigin(admin, organizationId, contactId, channelSessionId)).conversation_id;
}
