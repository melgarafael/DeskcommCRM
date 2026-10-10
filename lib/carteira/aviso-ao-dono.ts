/**
 * AVISO AO VENDEDOR DONO — o cliente da carteira de A falou com B, e A precisa
 * saber (issue #2591, regra 3).
 *
 * ─── Por que é um consumidor de `message.received` e não um gatilho ─────────
 *
 * O efeito pedido é UM AVOISO INTERNO por cliente enquanto ele estiver em
 * aberto: tarefa para o dono, sem mensagem ao cliente, sem repetir a cada
 * mensagem. O `event_log` já entrega exatamente esse semântica — at-least-once,
 * com `consumed_by` gravando o que já foi tratado — e o módulo de tarefa
 * (`lib/tarefas/criar-tarefa.ts`) já cuida de gravar, auditar, registrar na
 * linha do tempo e dar o push ao responsável. Reescrever essas quatro coisas
 * aqui seria a segunda regra escrita em dois lugares, que diverge no primeiro
 * ajuste.
 *
 * ─── As três condições, e por que nesta ordem ────────────────────────────────
 *
 * 1. contato TEM carteira — sem dono nada muda (é o comportamento de hoje para
 *    toda instalação sem carteira);
 * 2. quem atende é OUTRA pessoa — dono atendendo não gera aviso, e conversa
 *    ainda sem responsável também não (ninguém "roubou" o cliente ainda);
 * 3. UMA tarefa por cliente enquanto houver aberta — a mesma mensagem
 *    reprocessada, ou um cliente que fala cinco vezes seguidas, não enche a
 *    lista do dono. A régua é `status in ('pending','in_progress')` do
 *    `crm_tasks`: `done`/`cancelled` liberam um aviso novo.
 *
 * A decisão é uma função PURA (`decidirAvisoDeCarteira`) porque é ela que
 * precisa de teste de mesa; o handler só busca os três fatos e obedece.
 *
 * ─── Organização em toda leitura ────────────────────────────────────────────
 *
 * O client é service-role e ignora RLS: `organization_id` junto em TODO `.eq`,
 * como em `lib/leads/aviso-de-etapa.handler.ts`.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { donoQualificado } from "@/lib/carteira/dono";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarTarefaInterna } from "@/lib/tarefas/criar-tarefa";

export const CARTEIRA_AVISO_KEY = "carteira.aviso-ao-dono";

/**
 * O título canônico (pt-BR) da tarefa. `{{contact.name}}` é o MESMO
 * placeholder que `interpolarTitulo` entende — a tradução tem de mantê-lo, ou
 * o nome do cliente some do título em espanhol.
 */
export const TITULO_DO_AVISO = "Cliente da sua carteira falou com outro vendedor: {{contact.name}}";

export type DecisaoDoAviso =
  | "cria_tarefa"
  | "sem_carteira"
  | "sem_atendente"
  | "dono_quem_atende"
  | "tarefa_ja_aberta";

/**
 * A regra inteira, sem banco: dada as três condições, o que fazer.
 *
 * `tarefaAberta` chega como `false` na primeira passada (a consulta ao
 * `crm_tasks` só acontece quando as outras condições já permitem criar); o
 * handler chama de novo com o resultado da consulta. Duas chamadas do MESMO
 * predicado, nunca duas regras.
 */
export function decidirAvisoDeCarteira(entrada: {
  donoId: string | null;
  atendenteId: string | null;
  tarefaAberta: boolean;
}): DecisaoDoAviso {
  if (!entrada.donoId) return "sem_carteira";
  if (!entrada.atendenteId) return "sem_atendente";
  if (entrada.atendenteId === entrada.donoId) return "dono_quem_atende";
  if (entrada.tarefaAberta) return "tarefa_ja_aberta";
  return "cria_tarefa";
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor : null;
}

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CARTEIRA_AVISO_KEY,
  status,
  detail,
});

/** `error` e não `retry`: reagendar não conserta leitura que falhou (mesma régua da 0440). */
const falhou = (detail: string): HandlerResult => ({
  consumer_key: CARTEIRA_AVISO_KEY,
  status: "error",
  detail,
});

type ClienteLido = {
  id: string;
  carteira_user_id: string | null;
  name: string | null;
  display_name: string | null;
};

async function handle(row: EventRow): Promise<HandlerResult> {
  const contactId = texto(row.payload?.contact_id);
  const conversationId = texto(row.payload?.conversation_id);
  if (!contactId) return resultado("skipped", "sem_contato");
  if (!conversationId) return resultado("skipped", "sem_conversa");

  const admin = createAdminClient();

  const { data: contato, error: erroDoContato } = await admin
    .from("contacts")
    .select("id, carteira_user_id, name, display_name")
    .eq("id", contactId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (erroDoContato) return falhou(`leitura do contato falhou: ${erroDoContato.message}`);
  const cliente = contato as ClienteLido | null;
  if (!cliente) return resultado("skipped", "contato_nao_encontrado");

  const { data: conversa, error: erroDaConversa } = await admin
    .from("conversations")
    .select("id, assigned_to_user_id")
    .eq("id", conversationId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (erroDaConversa) return falhou(`leitura da conversa falhou: ${erroDaConversa.message}`);

  // Regra 5: dono que virou `viewer` ou saiu da equipe não conta — a mesma
  // régua do gatilho e da rota de negócio, senão a tarefa vai para quem saiu.
  const donoGravado = texto(cliente.carteira_user_id);
  const donoId =
    donoGravado && (await donoQualificado(admin, row.organization_id, donoGravado)) ? donoGravado : null;
  const atendenteId = texto((conversa as { assigned_to_user_id?: string | null } | null)?.assigned_to_user_id);

  let decisao = decidirAvisoDeCarteira({ donoId, atendenteId, tarefaAberta: false });
  if (decisao !== "cria_tarefa") return resultado("skipped", decisao);

  // UMA tarefa por cliente enquanto houver uma aberta para o dono.
  const { data: abertas, error: erroDasTarefas } = await admin
    .from("crm_tasks")
    .select("id")
    .eq("organization_id", row.organization_id)
    .eq("contact_id", contactId)
    .eq("assigned_to", donoId!)
    .in("status", ["pending", "in_progress"])
    .limit(1);
  if (erroDasTarefas) return falhou(`busca de tarefa aberta falhou: ${erroDasTarefas.message}`);

  decisao = decidirAvisoDeCarteira({
    donoId,
    atendenteId,
    tarefaAberta: (abertas ?? []).length > 0,
  });
  if (decisao !== "cria_tarefa") return resultado("skipped", decisao);

  // O texto sai no idioma da ORGANIZAÇÃO, como no aviso de etapa: a tarefa é
  // gravada como mostrada (`crm_tasks.title` não passa por `t()` em tela nenhuma).
  const { data: org } = await admin
    .from("organizations")
    .select("locale")
    .eq("id", row.organization_id)
    .maybeSingle();
  const idioma: Idioma = normalizarIdioma((org as { locale?: string | null } | null)?.locale);

  const criada = await criarTarefaInterna(admin, {
    organizationId: row.organization_id,
    titulo: traduzir(TITULO_DO_AVISO, idioma),
    venceEmDias: 0,
    atribuirA: { usuario_id: donoId! },
    prioridade: "high",
    contactId,
    origem: "carteira:aviso",
  });
  if (!criada.ok) {
    return criada.codigo === "falha"
      ? falhou(`tarefa não entrou: ${criada.erro ?? "sem detalhe"}`)
      : resultado("skipped", `tarefa_${criada.codigo}`);
  }
  return resultado("ok", `tarefa_criada:${criada.tarefa_id}`);
}

export const avisoAoDonoDaCarteira: EventHandler = {
  key: CARTEIRA_AVISO_KEY,
  // Escrita interna: roda com a organização parada (o cliente já falou, a
  // equipe precisa de saber — mesma classificação do aviso de etapa).
  naOrgParada: "roda",
  events: ["message.received"],
  handle,
};
