/**
 * A CONTA A RECEBER DO GANHO PELO BARRAMENTO — #1477, item 1 da CR do PR #2220.
 *
 * ─── Por que um consumidor de evento ────────────────────────────────────────
 *
 * Negócio se ganha por vários caminhos: o arrasto no Kanban (rota de move), o
 * botão Ganhar (`/win` → `encerraDemanda`), o mover em lote, a automação e a
 * capacidade da IA. Todos passam pelo MESMO gatilho do banco:
 * `fn_emit_event_on_lead_change` (`supabase/baseline.sql`) grava `lead.won` em
 * QUALQUER transição de status para `won`. O consumidor do evento cobre todos
 * com uma decisão só, e nenhuma rota precisa conhecer o financeiro.
 *
 * ─── Por que admin client, e de onde vêm os dados ───────────────────────────
 *
 * O dreno roda sem sessão de usuário (`lib/event-log/drain.ts`), então aqui
 * vale o padrão de `lib/notifications/push.handler.ts`: `createAdminClient()`
 * e `organization_id` vindo DA LINHA DO EVENTO — nunca de parâmetro de quem
 * chama, que neste caso não existe. O payload de `lead.won` é só
 * `{lead_id, value_cents}`, e dele só se usa o `lead_id`: status, valor,
 * contato e responsável saem do próprio negócio, relido com o
 * `organization_id` da linha, e o atendente sai de `owner_user_id`, que pode ser nulo (a coluna
 * `sales.attendant_user_id` aceita nulo — a comanda nasce sem atendente em
 * vez de não nascer).
 *
 * ─── Idempotência: o dreno reexecuta a linha inteira ────────────────────────
 *
 * Quando um handler devolve `error`, o dreno reagenda a LINHA e todos os
 * handlers rodam de novo — inclusive os que já tinham rodado. A trava é o
 * vínculo: `comandaDoGanho` procura o vínculo em `crm_lead_links` antes
 * de escrever e devolve a comanda que já existe. Ou seja, a repetição vira
 * `ok` com `detail: ja_existia`, não uma segunda comanda.
 *
 * ─── A porta (item 2 da CR): opt-in por funil, DESLIGADO por padrão ─────────
 *
 * `crm_pipelines.settings.comanda_no_ganho`. A régua é
 * `docs/doctrine/extensoes.md`: o barramento é o ponto genérico do núcleo, o
 * consumidor é a extensão, e a pergunta-raiz ("se nenhuma organização ativar
 * isto, a operação comum continua inteira?") decide o PADRÃO — desligado. Em
 * loja com checkout, infoproduto ou imobiliária o valor do negócio não é conta
 * a receber: a comanda viraria uma comanda aberta sem nada a cobrar, que vira
 * lançamento real se alguém a finalizar. TRADEOFF: é uma leitura a mais por
 * ganho (o funil), aceita porque o fecho já é caro e a decisão muda por
 * funil, não por instalação.
 *
 * ─── O que este handler NUNCA faz ───────────────────────────────────────────
 *
 * Derrubar o ganho ou lançar exceção: toda recusa vira `skipped`/`error` e o
 * evento segue. `error` (e não `retry`) para falha de banco: `retry` é o
 * reagendamento benigno que não conta tentativa, e uma gravação que não passa
 * ficaria girando para sempre em vez de ir ao teto de tentativas e ao aviso.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { audit } from "@/lib/audit";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { comandaDoGanho, ORIGEM_DA_COMANDA_DO_GANHO } from "./comanda-do-ganho";

/** A chave do consumidor em `event_log.consumed_by`. */
export const COMANDA_DO_GANHO_KEY = "financeiro.comanda-do-ganho.v1";

/**
 * O interruptor, em `crm_pipelines.settings`. Só o booleano `true` liga:
 * ausente, `false`, string ou objeto torto é desligado — falha fechada, como
 * `capacidadesLigadas` (`lib/organizacao/capacidades.ts`).
 */
export const CHAVE_DA_COMANDA_NO_GANHO = "comanda_no_ganho";

/**
 * O `DEFAULT` da coluna `crm_leads.currency` (`supabase/baseline.sql`).
 *
 * Não é uma moeda escolhida: é o que o banco grava quando ninguém mandou nada,
 * e por isso aqui significa "não declarado". Ver o bloco de guarda de moeda no
 * handler, onde esta constante é a metade da regra.
 */
export const MOEDA_PADRAO_DO_LEAD = "BRL";

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: COMANDA_DO_GANHO_KEY,
  status,
  detail,
});

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor : null;
}

async function handle(row: EventRow): Promise<HandlerResult> {
  const leadId = texto(row.payload.lead_id) ?? texto(row.entity_id);
  if (!leadId) return resultado("skipped", "sem_negocio");

  const admin = createAdminClient();
  const { data: lead, error: erroLeitura } = await admin
    .from("crm_leads")
    .select("status, pipeline_id, contact_id, owner_user_id, value_cents, currency")
    .eq("id", leadId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (erroLeitura) return resultado("error", `negocio: ${erroLeitura.message}`);
  if (!lead) return resultado("skipped", "negocio_nao_encontrado");

  const negocio = lead as {
    status: string | null;
    pipeline_id: string | null;
    contact_id: string | null;
    owner_user_id: string | null;
    value_cents: number | string | null;
    currency: string | null;
  };
  // O evento é PISTA, não fato: `emit_event` aceita chamador `authenticated`
  // com papel `viewer` e `lead.won` não está na lista reservada dele, então um
  // viewer consegue gravar esta linha para um negócio ABERTO. Quem decide é o
  // banco — mesmo padrão de `lib/conversoes/envio.handler.ts`.
  if (negocio.status !== "won") return resultado("skipped", "negocio_nao_ganho");

  const pipelineId = texto(negocio.pipeline_id);
  if (!pipelineId) return resultado("skipped", "sem_funil");

  const { data: funil, error: erroFunil } = await admin
    .from("crm_pipelines")
    .select("name, vocabulary, settings")
    .eq("id", pipelineId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (erroFunil) return resultado("error", `funil: ${erroFunil.message}`);

  const linhaDoFunil = funil as { name?: unknown; vocabulary?: unknown; settings?: unknown } | null;
  const settings = linhaDoFunil?.settings;
  const ligado =
    settings !== null &&
    typeof settings === "object" &&
    (settings as Record<string, unknown>)[CHAVE_DA_COMANDA_NO_GANHO] === true;
  if (!ligado) return resultado("skipped", "comanda_no_ganho_desligada");
  // A comanda é módulo de tabela (#1907): sem o `financeiro` instalado, `sales`
  // não existe. O interruptor do funil pode ter ficado ligado de antes — quem
  // decide é a instalação. Lido DEPOIS do funil para não custar uma ida ao banco
  // em todo ganho de quem nunca ligou a comanda.
  if (!(await moduloLigado(admin, "financeiro"))) {
    return resultado("skipped", "modulo_financeiro_nao_instalado");
  }

  // A descrição do item vem do FUNIL, nunca do título do negócio (que costuma
  // ser nome/telefone do contato e fica fora da cascata de redact se copiado):
  // "Pedido · Vendas" — o vocabulário do negócio e o nome do funil.
  const vocabulario = linhaDoFunil?.vocabulary as Record<string, unknown> | null | undefined;
  const descricao = [texto(vocabulario?.deal) ?? "Negócio", texto(linhaDoFunil?.name)]
    .filter(Boolean)
    .join(" · ");

  // ─── Item 1 da #2475: a moeda decide se a comanda nasce ────────────────────
  // `value_cents` não tem unidade escrita — a coluna é um inteiro e o rótulo é
  // de fora. Abrir comanda em EUR sobre um número em BRL entrega um total que o
  // operador acredita e que está errado por fator de conversão, então quando as
  // duas moedas estão DECLARADAS e diferentes, não se abre (skipped, não error:
  // o ganho não é falha, é só o financeiro ficando de fora).
  //
  // ⚠️ INFERIDO — o brasinho que a issue #2475 põe na guarda: `crm_leads.currency`
  // tem `DEFAULT 'BRL'` (supabase/baseline.sql, tabela `crm_leads`). Uma comparação
  // direta `lead.currency !== org.currency` pularia TODO negócio de uma organização
  // em EUR cujo lead nasceu pelo default, que é justamente o caso comum lá fora.
  // Por isso `'BRL'` aqui é tratado como "não declarado" — é o default da coluna,
  // não uma escolha. O que a guarda NÃO alcança: uma organização em EUR com um
  // negócio genuinamente em BRL (lead declarado como o default) passa direto e a
  // comanda nasce em EUR — os dois casos são indistinguíveis nesta coluna, e esta
  // é a direção que não erra para o lado que a issue aponta.
  const moedaDoNegocio = texto(negocio.currency);
  const moedaDeclarada = moedaDoNegocio && moedaDoNegocio !== MOEDA_PADRAO_DO_LEAD
    ? moedaDoNegocio
    : null;
  if (moedaDeclarada) {
    const moedaDaOrg = await moedaDaOrganizacao(admin, row.organization_id);
    if (moedaDeclarada !== moedaDaOrg) {
      return resultado("skipped", `moeda_divergente:${moedaDeclarada}!=${moedaDaOrg}`);
    }
  }

  const desfecho = await comandaDoGanho(admin, {
    organizationId: row.organization_id,
    leadId,
    contactId: texto(negocio.contact_id),
    // O valor SEMPRE do banco, nunca do payload: o payload é forjável (acima).
    valorCents: negocio.value_cents,
    descricao,
    // O `event_log` não tem ator (CR do mantenedor): o atendente é o dono do
    // negócio, que pode ser nulo — decisão do próprio CR, não aqui.
    userId: texto(negocio.owner_user_id),
  });

  switch (desfecho.estado) {
    case "criado":
      // O audit do item 1 da #2475: a comanda aberta SEM o rastro de quem
      // abriu é invisível no painel de auditoria, e é o único jeito do
      // operador descobrir por que a comanda apareceu. `origem` distingue
      // este caminho do arrasto/manual (`resourceType: "sale"`, como a rota
      // `POST /api/v1/financeiro/comandas`). Sem `actorUserId` de propósito:
      // o `event_log` não guarda ator (CR do #2220).
      await audit({
        action: "comanda.aberta",
        organizationId: row.organization_id,
        resourceType: "sale",
        resourceId: desfecho.comandaId,
        metadata: {
          origem: ORIGEM_DA_COMANDA_DO_GANHO,
          number: desfecho.numero,
          lead_id: leadId,
          value_cents: desfecho.valorCents,
        },
      });
      return resultado("ok", `criado:${desfecho.numero}`);
    case "ja_existia":
      return resultado("ok", "ja_existia");
    case "ignorado":
      return resultado("skipped", desfecho.motivo);
    default:
      return resultado("error", desfecho.erro);
  }
}

/**
 * O consumidor de `lead.won`.
 *
 * `naOrgParada: "roda"`: escrita interna, sem custo e sem sair da instalação
 * (mesma classe de `avisoDeEtapaHandler`) — a organização parada não gasta
 * rede nem terceiro, e o evento já foi emitido enquanto ela operava.
 */
export const comandaDoGanhoHandler: EventHandler = {
  key: COMANDA_DO_GANHO_KEY,
  naOrgParada: "roda",
  events: ["lead.won"],
  handle,
};
