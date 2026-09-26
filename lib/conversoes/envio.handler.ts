/**
 * Reportar a venda à plataforma que trouxe o lead.
 *
 * ─── Por que um handler de evento, e não uma chamada em `encerramento.ts` ───
 *
 * `lib/leads/` não muda uma linha por causa deste arquivo, e isso não é
 * elegância: é o invariante 1 da doutrina de restrição de canal. Uma chamada
 * dentro de `encerraDemanda` obrigaria a feature a saber que conversões existem,
 * a lidar com a falha delas no meio do fechamento, e a decidir se uma venda deve
 * ou não ser bloqueada porque a Meta está fora do ar. A resposta a essa última
 * pergunta é óbvia — não deve — e o jeito de garanti-la é o fechamento nem ficar
 * sabendo. Ele já emite o evento; alguém escuta.
 *
 * ─── AS DUAS PORTAS (e por que o `status` do payload é ignorado) ────────────
 *
 * Fechar um negócio tem dois caminhos nesta casa, e um handler plugado só no
 * primeiro perderia a maioria das vendas em silêncio:
 *
 *   1. `encerraDemanda` (botão Ganhar, e a capacidade da IA)  → `lead.won`
 *   2. arrastar o card no kanban (`/leads/[id]/move`)         → `lead.stage_changed`
 *   3. mover em lote (`/leads/bulk`)                          → `lead.stage_changed`
 *
 * Nos dois últimos quem escreve `status` é o trigger do banco, não a rota. E as
 * duas rotas NÃO são iguais no que publicam: `/move` re-seleciona a linha depois
 * do update e manda `status` no payload; o `/bulk` faz `.select("id")` e não
 * manda. Um handler que confiasse em `payload.status === "won"` funcionaria numa
 * porta e falharia calado na outra — o pior modo de falha possível, porque some
 * sem erro e só aparece meses depois como "o Meta não recebe minhas vendas".
 *
 * Por isso o payload é DICA e o banco é VERDADE: o handler re-lê `crm_leads`.
 * A leitura não custa nada a mais — `value_cents`, `currency`, `closed_at` e
 * `contact_id` teriam de vir de lá de qualquer forma.
 *
 * ─── Quando uma linha vai para o livro-razão ────────────────────────────────
 *
 * Só quando HÁ atribuição de anúncio. Um lead orgânico que fecha não é uma
 * conversão que deixou de ser reportada — não havia nada a reportar. Gravar
 * `sem_atribuicao` para cada venda orgânica encheria a tabela e faria a tela,
 * que existe para mostrar pendência, mostrar sobretudo ruído. O veredito ainda
 * é registrado: ele volta no `HandlerResult` e o drain o persiste no `event_log`
 * (invariante 4 — não-aplicação é auditável, não invisível).
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { transporteDe, ehPlataformaConhecida } from "@/lib/plataformas-de-anuncio/registry";
import type { ConversaoOffline, NomeDoEvento } from "@/lib/plataformas-de-anuncio/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerAtribuicao } from "./leitura-da-atribuicao";
import { lerRegistro, registraEnvio } from "./registro-de-envio";

const CONSUMER_KEY = "conversoes.venda";

/** Backoff do transitório. O drain reagenda sem contar tentativa. */
const ESPERA_PADRAO_MS = 5 * 60 * 1000;

const ok = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

export async function processarConversao(
  row: EventRow,
  qualificacao?: { ocorridoEm: string; googleActionId: string },
): Promise<HandlerResult> {
  const EVENTO: NomeDoEvento = qualificacao ? "QualifiedLead" : "Purchase";
  if (
    !qualificacao &&
    row.event_type === "ad_conversion.retry_requested" &&
    row.payload.event_name === "QualifiedLead"
  )
    return ok("skipped", "outro_evento");
  if (!row.entity_id) return ok("skipped", "sem_entidade");

  const admin = createAdminClient();

  // ⚠️ Filtro de organização junto do id: o client é service-role e bypassa RLS.
  const { data, error } = await admin
    .from("crm_leads")
    .select("id, status, value_cents, currency, closed_at, contact_id")
    .eq("id", row.entity_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();

  if (error) {
    // Erro de leitura é transitório por natureza (rede/banco). Marcar `error`
    // aqui queimaria a tentativa de uma venda que ainda pode ser reportada.
    return {
      consumer_key: CONSUMER_KEY,
      status: "retry",
      retry_at: new Date(Date.now() + ESPERA_PADRAO_MS).toISOString(),
      detail: `leitura do lead falhou: ${error.message}`,
    };
  }
  if (!data) return ok("skipped", "lead_inexistente");

  const lead = data as {
    id: string;
    status: string;
    value_cents: number | null;
    currency: string | null;
    closed_at: string | null;
    contact_id: string | null;
  };

  // O filtro que faz `lead.stage_changed` valer a pena escutar: a grande maioria
  // das mudanças de etapa não é fechamento, e sai por aqui sem tocar no banco de
  // novo nem sujar o livro-razão.
  const registro = await lerRegistro(admin, row.organization_id, lead.id, EVENTO);
  if (!qualificacao && lead.status !== "won" && !registro?.remote_request_id)
    return ok("skipped", "nao_e_ganho");
  if (registro?.status === "sent") {
    return ok("skipped", "ja_enviada");
  }

  const leitura =
    registro?.remote_request_id && ehPlataformaConhecida(registro.platform)
      ? {
          temAtribuicao: true as const,
          atribuicao: { plataforma: registro.platform, cliqueDeOrigem: "", telefone: null },
        }
      : await lerAtribuicao(admin, row.organization_id, lead.contact_id);
  if (!leitura.temAtribuicao) return ok("skipped", leitura.motivo);

  const { plataforma, cliqueDeOrigem, telefone } = leitura.atribuicao;
  const identificadoresGoogle =
    "identificadoresGoogle" in leitura.atribuicao
      ? leitura.atribuicao.identificadoresGoogle
      : undefined;
  if (qualificacao && plataforma !== "google_ads")
    return ok("skipped", "qualificacao_sem_origem_google");

  const registra = (
    status: "sent" | "skipped" | "error",
    motivo: string | null,
    detalhe?: string,
    protocolo?: string | null,
    solicitadoEm?: string | null,
  ) =>
    registraEnvio(admin, {
      organizationId: row.organization_id,
      leadId: lead.id,
      plataforma,
      evento: EVENTO,
      status,
      motivo,
      eventoId: `${lead.id}:${EVENTO}`,
      valorCentavos: qualificacao
        ? null
        : registro?.remote_request_id
          ? registro.value_cents
          : lead.value_cents,
      ...(qualificacao
        ? {
            ocorridoEm: registro?.event_occurred_at ?? qualificacao.ocorridoEm,
            googleActionId: registro?.google_action_id ?? qualificacao.googleActionId,
          }
        : {}),
      moeda: registro?.remote_request_id ? registro.currency : lead.currency,
      detalhe: detalhe ?? null,
      protocolo,
      solicitadoEm,
    });

  const transporte = transporteDe(plataforma);
  if (!transporte) {
    // Plataforma do vocabulário declarada sem transporte no registro — o
    // desfecho CERTO, não um bug (invariante 4 da restrição de canal). Hoje
    // nenhuma cai aqui: `meta_ads` e `google_ads` têm transporte.
    await registra("skipped", "plataforma_sem_transporte");
    return ok("skipped", "plataforma_sem_transporte");
  }

  // `Purchase` exige valor E moeda na plataforma. `crm_leads.value_cents` é
  // nullable e nada obriga a preenchê-lo no fechamento (baseline.sql:1452), então
  // esta é a pendência MAIS COMUM — e a razão de a tela existir. Mandar `0` para
  // "resolver" seria aceito e ensinaria ao otimizador que a venda não vale nada.
  if (
    !qualificacao &&
    !registro?.remote_request_id &&
    (lead.value_cents === null || lead.value_cents <= 0)
  ) {
    await registra("skipped", "sem_valor");
    return ok("skipped", "sem_valor");
  }

  const credencial = await lerCredencial(admin, row.organization_id, plataforma);
  if (!credencial.ok) {
    if (credencial.motivo === "leitura_indisponivel")
      throw new Error("Leitura da conexão indisponível.");
    await registra("skipped", credencial.motivo);
    return ok("skipped", credencial.motivo);
  }

  if (qualificacao && credencial.credencial.google) {
    credencial.credencial.google.conversionActionId =
      registro?.google_action_id ?? qualificacao.googleActionId;
  }
  if (qualificacao && !registro?.event_occurred_at) {
    await registra("skipped", "nova_tentativa_agendada");
    // O primeiro snapshot vence também quando dois movimentos concorrem.
    const salvo = await lerRegistro(admin, row.organization_id, lead.id, EVENTO);
    if (!salvo?.event_occurred_at || !salvo.google_action_id)
      throw new Error("Snapshot da qualificação ausente.");
    qualificacao = { ocorridoEm: salvo.event_occurred_at, googleActionId: salvo.google_action_id };
    if (credencial.credencial.google)
      credencial.credencial.google.conversionActionId = salvo.google_action_id;
  }

  const conversao: ConversaoOffline = {
    organizationId: row.organization_id,
    leadId: lead.id,
    evento: EVENTO,
    eventoId: `${lead.id}:${EVENTO}`,
    // `closed_at` é escrito pelo trigger junto com o `status`, então em won ele
    // existe. O fallback é para a linha antiga de um banco que fechou por outro
    // caminho — e cair em `created_at` do evento é melhor que em `now()`, que
    // fingiria que a venda é de hoje.
    ocorridoEm: new Date(
      qualificacao
        ? (registro?.event_occurred_at ?? qualificacao.ocorridoEm)
        : (lead.closed_at ?? row.created_at ?? Date.now()),
    ),
    cliqueDeOrigem,
    identificadoresGoogle,
    telefone,
    // A coluna tem `DEFAULT 'BRL'` e um CHECK de ISO-4217; o fallback só cobre a
    // linha que teve a moeda apagada à mão.
    moeda: lead.currency ?? "BRL",
    valorCentavos: qualificacao ? null : (lead.value_cents ?? 0),
  };

  // Protocolo já recebido: consultar é a única operação permitida até concluir.
  const resultado =
    registro?.remote_request_id && transporte.consultar
      ? await transporte.consultar(credencial.credencial, registro.remote_request_id)
      : await transporte.enviar(credencial.credencial, conversao);

  if (resultado.tipo === "processando") {
    const solicitadoEm =
      registro?.remote_request_id === resultado.protocolo
        ? (registro.remote_requested_at ?? new Date().toISOString())
        : new Date().toISOString();
    const vencido = Date.now() - new Date(solicitadoEm).getTime() > 24 * 60 * 60 * 1000;
    await registra(
      "skipped",
      vencido ? "processamento_demorado" : "aguardando_processamento",
      resultado.detalhe,
      resultado.protocolo,
      solicitadoEm,
    );
    if (vencido) return ok("skipped", "processamento_demorado");
    return {
      consumer_key: CONSUMER_KEY,
      status: "retry",
      retry_at: new Date(Date.now() + ESPERA_PADRAO_MS).toISOString(),
      detail: resultado.detalhe,
    };
  }

  if (resultado.tipo === "ok") {
    if (credencial.credencial.testEventCode) {
      await registra(
        "skipped",
        "evento_de_teste",
        "Evento recebido em modo de teste. Desative o teste antes de reportar a venda real.",
      );
      return ok("skipped", "evento_de_teste");
    }
    await registra("sent", null, resultado.detalhe);
    return ok("ok", `conversão reportada (${plataforma})`);
  }

  if (resultado.tipo === "transitorio") {
    if (
      registro?.remote_requested_at &&
      Date.now() - new Date(registro.remote_requested_at).getTime() > 24 * 60 * 60 * 1000
    ) {
      await registra("skipped", "processamento_demorado", resultado.detalhe);
      return ok("skipped", "processamento_demorado");
    }
    await registra("skipped", "nova_tentativa_agendada", resultado.detalhe);
    // Transitório visível na mesma tela das pendências.
    return {
      consumer_key: CONSUMER_KEY,
      status: "retry",
      retry_at: new Date(Date.now() + (resultado.tentarEmMs ?? ESPERA_PADRAO_MS)).toISOString(),
      detail: resultado.detalhe,
    };
  }

  await registra(
    "error",
    "recusado_pela_plataforma",
    resultado.detalhe,
    resultado.rejeicaoConfirmada ? null : undefined,
  );
  return ok("skipped", "recusado_pela_plataforma");
}

async function handle(row: EventRow): Promise<HandlerResult> {
  try {
    return await processarConversao(row);
  } catch {
    return {
      consumer_key: CONSUMER_KEY,
      status: "retry",
      retry_at: new Date(Date.now() + ESPERA_PADRAO_MS).toISOString(),
      detail: "Falha ao ler ou registrar a conversão. Nova tentativa agendada.",
    };
  }
}

export const conversaoDeVendaHandler: EventHandler = {
  key: CONSUMER_KEY,
  // As duas portas. Ver o cabeçalho: `lead.stage_changed` cobre o arrasto no
  // kanban E o mover em lote, e o `status` do payload não é confiável em nenhum.
  events: ["lead.won", "lead.stage_changed", "ad_conversion.retry_requested"],
  handle,
};
