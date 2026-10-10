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
import { canalQueReportaConversao } from "@/lib/channels/conversao-pelo-canal";
import type { ChannelConversionInput, ChannelConversionResult } from "@/lib/channels/types";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { transporteDe, ehPlataformaConhecida } from "@/lib/plataformas-de-anuncio/registry";
import type {
  ConversaoOffline,
  NomeDoEvento,
  ResultadoDeEnvio,
} from "@/lib/plataformas-de-anuncio/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerAtribuicao } from "./leitura-da-atribuicao";
import { lerValorDaConversa } from "./valor-da-conversa";
import { lerVendaPeloCanal } from "./venda-pelo-canal";
import { ehEventoDeEtapa } from "./regras-google";
import {
  EVENTOS_DE_ETAPA_NO_CANAL,
  ehEventoDeEtapaMeta,
  rotuloDoEventoDaMeta,
} from "./regras-meta";
import { lerRegistro, registraEnvio } from "./registro-de-envio";

const CONSUMER_KEY = "conversoes.venda";

/** Backoff do transitório. O drain reagenda sem contar tentativa. */
const ESPERA_PADRAO_MS = 5 * 60 * 1000;

const ok = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

/**
 * O evento de ETAPA que acompanha o envio, quando não é a compra. Do Google
 * vem a ação de conversão (`googleActionId`); da Meta, o nome padrão do evento
 * (`eventoMeta`, 0524). Um dos dois — é ele que diz a plataforma da regra.
 */
export interface EventoDeEtapa {
  ocorridoEm: string;
  evento?: NomeDoEvento;
  googleActionId?: string;
  eventoMeta?: string;
}

export async function processarConversao(
  row: EventRow,
  qualificacao?: EventoDeEtapa,
): Promise<HandlerResult> {
  const EVENTO: NomeDoEvento = qualificacao ? (qualificacao.evento ?? "QualifiedLead") : "Purchase";
  if (
    !qualificacao &&
    row.event_type === "ad_conversion.retry_requested" &&
    (ehEventoDeEtapa(row.payload.event_name) || ehEventoDeEtapaMeta(row.payload.event_name))
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
  // A regra de etapa é de UMA plataforma: o lead que veio da outra não é dela.
  // Sai sem linha no livro-razão — não há pendência, havia nada a reportar.
  if (qualificacao && !qualificacao.eventoMeta && plataforma !== "google_ads")
    return ok("skipped", "qualificacao_sem_origem_google");
  if (qualificacao?.eventoMeta && plataforma !== "meta_ads")
    return ok("skipped", "etapa_sem_origem_meta");

  /** O valor que a compra leva — `null` quando sai sem valor (0436). */
  let valorDaVenda: number | null =
    lead.value_cents !== null && lead.value_cents > 0 ? lead.value_cents : null;
  let moedaDaVenda: string | null = lead.currency;
  /** De onde veio o valor (ou por que faltou), quando ele foi lido da conversa. */
  let detalheDoValor: string | null = null;

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
          : valorDaVenda,
      ...(qualificacao
        ? {
            ocorridoEm: registro?.event_occurred_at ?? qualificacao.ocorridoEm,
            googleActionId: registro?.google_action_id ?? qualificacao.googleActionId,
            metaEventName: registro?.meta_event_name ?? qualificacao.eventoMeta,
          }
        : {}),
      moeda: registro?.remote_request_id ? registro.currency : moedaDaVenda,
      detalhe: detalhe ?? detalheDoValor,
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

  // `Purchase` exige valor E moeda na Meta. `crm_leads.value_cents` é
  // nullable e nada obriga a preenchê-lo no fechamento (baseline.sql:1452), então
  // esta é a pendência MAIS COMUM — e a razão de a tela existir. Mandar `0` para
  // "resolver" seria aceito e ensinaria ao otimizador que a venda não vale nada.
  //
  // No Google a organização escolhe (0436, `google_purchase_value_mode`): a
  // compra pode sair SEM valor — nunca com zero —, e o Google a conta como uma
  // conversão sem receita. Por isso a decisão do Google espera a credencial.
  //
  // Na Meta, antes de desistir, a conversa: quem opera pediu a venda sem passo
  // humano, então o valor DITO na conversa vale como valor da venda. Só o dito —
  // `valor-da-conversa.ts` recusa o que não consegue mostrar escrito, e aí a
  // pendência `sem_valor` segue, agora com o motivo no Histórico.
  //
  // Mas só DEPOIS de saber que a venda tem para onde ir — a conexão direta
  // ligada, ou o canal da conversa com a chave ligada. Ler antes gastava uma
  // chamada de IA e 80 mensagens em toda venda sem valor de contato atribuído à
  // Meta, inclusive na instalação que nunca conectou a Meta (o padrão), e fazia
  // a chave do canal, desligada, deixar de valer "nem as conversas são lidas".
  // Por isso a decisão da Meta sem valor também espera a credencial.
  const valorPodeVirDaConversa =
    !qualificacao &&
    !registro?.remote_request_id &&
    valorDaVenda === null &&
    plataforma === "meta_ads";
  let semValor = !qualificacao && !registro?.remote_request_id && valorDaVenda === null;
  const lerOValorNaConversa = async () => {
    const lido = await lerValorDaConversa(
      admin,
      row.organization_id,
      lead.contact_id,
      lead.currency ?? "BRL",
    );
    if (lido.ok) {
      valorDaVenda = lido.valorCentavos;
      moedaDaVenda = lido.moeda;
      // O produto fica no Histórico (banco da organização) e NÃO vai para a
      // Meta: é texto livre do modelo, ao lado do telefone em hash — numa
      // clínica, é dado de saúde.
      detalheDoValor = lido.produto
        ? `Valor lido da conversa (${lido.produto}): "${lido.trecho}"`
        : `Valor lido da conversa: "${lido.trecho}"`;
    } else {
      detalheDoValor = lido.motivo;
    }
    semValor = valorDaVenda === null;
  };
  if (semValor && plataforma !== "google_ads" && !valorPodeVirDaConversa) {
    await registra("skipped", "sem_valor");
    return ok("skipped", "sem_valor");
  }

  const credencial = await lerCredencial(admin, row.organization_id, plataforma, {
    exigirAcaoDeVenda: !qualificacao,
  });
  if (!credencial.ok) {
    if (credencial.motivo === "leitura_indisponivel")
      throw new Error("Leitura da conexão indisponível.");

    // ─── SEM CONEXÃO DIRETA: O CANAL DA CONVERSA ────────────────────────────
    //
    // Quando a conversa do cliente passa por um canal intermediado que já tem
    // a ponte com o conjunto de dados da Meta (configurada na tela do
    // provedor), é o canal quem guardou o vínculo com o clique — e a venda pode
    // ir por ele, sem token nem dataset no CRM. Até aqui essa venda virava a
    // pendência `sem_conexao`, que ninguém resolvia porque não havia o que
    // preencher do lado do CRM.
    //
    // Só quando NÃO há conexão direta. Quem já configurou a Meta direta segue
    // exatamente como antes — inclusive com ela desligada ou incompleta, que é
    // decisão de quem opera e que o canal não atropela. Um caminho por venda:
    // mandar pelos dois contaria a mesma compra duas vezes se os ids de
    // deduplicação não casassem do outro lado.
    //
    // Protocolo pendente (`remote_request_id`) é do transporte direto, e só ele
    // sabe consultá-lo: fica fora. Sem valor no negócio, a conversa só é lida
    // depois que a chave está ligada E o canal existe — antes, não há destino.
    //
    // O evento de ETAPA da Meta (0524) vai pelo mesmo caminho e com o mesmo
    // retrato do transporte direto: o nome padrão da Meta, o instante da
    // entrada na etapa e nenhum valor. Sem isto, quem só tem o canal via toda
    // etapa virar `sem_conexao` — uma conexão direta que ali nunca vai existir.
    const eventoNoCanal = eventoParaOCanal(qualificacao, registro?.meta_event_name);
    if (
      credencial.motivo === "sem_conexao" &&
      plataforma === "meta_ads" &&
      eventoNoCanal !== null &&
      !registro?.remote_request_id &&
      (qualificacao !== undefined || valorDaVenda !== null || valorPodeVirDaConversa)
    ) {
      // A chave vem ANTES de tudo (doc 76): desligada — o padrão —, nem as
      // conversas são lidas, e nada sai para o provedor.
      let canal = null;
      try {
        if (await lerVendaPeloCanal(admin, row.organization_id))
          canal = await canalQueReportaConversao(admin, row.organization_id, lead.contact_id);
      } catch (err) {
        // Instabilidade na leitura não pode virar a pendência `sem_conexao`
        // de uma venda que tem caminho: espera e tenta de novo.
        return {
          consumer_key: CONSUMER_KEY,
          status: "retry",
          retry_at: new Date(Date.now() + ESPERA_PADRAO_MS).toISOString(),
          detail: `leitura do canal falhou: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (canal && valorPodeVirDaConversa) await lerOValorNaConversa();
      if (canal && (qualificacao !== undefined || valorDaVenda !== null)) {
        const pelo = await canal.reportar({
          event: eventoNoCanal,
          eventId: `${lead.id}:${EVENTO}`,
          occurredAt: new Date(
            qualificacao
              ? (registro?.event_occurred_at ?? qualificacao.ocorridoEm)
              : (lead.closed_at ?? row.created_at ?? Date.now()),
          ),
          phone: telefone,
          valueCents: qualificacao ? null : valorDaVenda,
          currency: moedaDaVenda ?? "BRL",
        });
        return desfecho(doCanal(pelo), false);
      }
    }

    // ─── EVENTO DE ETAPA FORA DO VOCABULÁRIO DO CANAL (#2457) ──────────────
    //
    // `eventoNoCanal` é null quando o nome escolhido para a etapa não está em
    // `ChannelConversionInput` — `QualifiedLead` e `ViewContent` estão na lista
    // que a própria tela oferece (`EVENTOS_DA_META`) e fora da do canal. Sem
    // conexão direta não há CAMINHO nenhum para eles, e gravar `sem_conexao`
    // mandava a pessoa preencher um token que esta instalação só-com-canal
    // nunca vai ter.
    //
    // A decisão é PENDER COM MOTIVO VISÍVEL, não inventar um caminho: mandar
    // `QualifiedLead` renomeado como `LeadSubmitted` contaria à Meta um
    // acontecimento que não aconteceu, e o vocabulário do canal é contrato do
    // provedor, não lista nossa. O motivo novo diz o que fazer — escolher um
    // evento que o canal repassa, ou configurar a conexão direta.
    //
    // Vale mesmo com a chave do canal desligada: ligá-la não resolve, o nome
    // continua fora da lista. E só para etapa da Meta: sem `eventoMeta` não é
    // etapa desta plataforma e a pendência segue `sem_conexao` de sempre.
    const foraDoVocabularioDoCanal =
      credencial.motivo === "sem_conexao" &&
      plataforma === "meta_ads" &&
      Boolean(qualificacao?.eventoMeta) &&
      eventoNoCanal === null;
    const motivoDaPendencia = foraDoVocabularioDoCanal
      ? EVENTO_FORA_DO_CANAL
      : semValor
        ? "sem_valor"
        : credencial.motivo;
    await registra(
      "skipped",
      motivoDaPendencia,
      foraDoVocabularioDoCanal
        ? eventoForaDoCanal(registro?.meta_event_name ?? qualificacao?.eventoMeta ?? "")
        : undefined,
    );
    return ok("skipped", motivoDaPendencia);
  }

  if (valorPodeVirDaConversa) await lerOValorNaConversa();
  // O modo de valor é do Google (0436). A Meta exige valor na compra sempre —
  // agora que a decisão dela também passa por aqui, a plataforma é explícita.
  const modoDeValor =
    plataforma === "google_ads"
      ? (credencial.credencial.google?.modoDeValorDaVenda ?? "obrigatorio")
      : "obrigatorio";
  if (semValor && modoDeValor === "obrigatorio") {
    await registra("skipped", "sem_valor");
    return ok("skipped", "sem_valor");
  }
  if (!qualificacao && modoDeValor === "nunca") valorDaVenda = null;

  const acaoDoGoogle = registro?.google_action_id ?? qualificacao?.googleActionId;
  if (qualificacao && acaoDoGoogle && credencial.credencial.google) {
    credencial.credencial.google.conversionActionId = acaoDoGoogle;
  }
  if (qualificacao && !registro?.event_occurred_at) {
    await registra("skipped", "nova_tentativa_agendada");
    // O primeiro snapshot vence também quando dois movimentos concorrem.
    const salvo = await lerRegistro(admin, row.organization_id, lead.id, EVENTO);
    if (qualificacao.eventoMeta) {
      if (!salvo?.event_occurred_at || !salvo.meta_event_name)
        throw new Error("Snapshot do evento de etapa ausente.");
      qualificacao = { ocorridoEm: salvo.event_occurred_at, eventoMeta: salvo.meta_event_name };
    } else {
      if (!salvo?.event_occurred_at || !salvo.google_action_id)
        throw new Error("Snapshot da qualificação ausente.");
      qualificacao = {
        ocorridoEm: salvo.event_occurred_at,
        googleActionId: salvo.google_action_id,
      };
      if (credencial.credencial.google)
        credencial.credencial.google.conversionActionId = salvo.google_action_id;
    }
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
    moeda: moedaDaVenda ?? "BRL",
    valorCentavos: qualificacao ? null : valorDaVenda,
    // O nome no fio do evento de etapa da Meta: o retrato, e só na falta dele a
    // regra — mudar a regra depois não rebatiza uma conversão já registrada.
    eventoNaPlataforma: qualificacao?.eventoMeta
      ? (registro?.meta_event_name ?? qualificacao.eventoMeta)
      : null,
  };

  // Protocolo já recebido: consultar é a única operação permitida até concluir.
  const resultado =
    registro?.remote_request_id && transporte.consultar
      ? await transporte.consultar(credencial.credencial, registro.remote_request_id)
      : await transporte.enviar(credencial.credencial, conversao);

  return desfecho(resultado, Boolean(credencial.credencial.testEventCode));

  /**
   * O desfecho de UM envio, venha ele do transporte direto ou do canal — o
   * mesmo livro-razão e a mesma espera, para as duas vias não divergirem.
   */
  async function desfecho(
    resultado: ResultadoDeEnvio,
    modoDeTeste: boolean,
  ): Promise<HandlerResult> {
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
      if (modoDeTeste) {
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
}

/**
 * O slug do motivo quando o nome da etapa não está em
 * `EVENTOS_DE_ETAPA_NO_CANAL`. Estável, como todos os outros: o banco guarda o
 * slug e `MOTIVO_LEGIVEL` (em `estado-da-conexao.ts`) traduz com o que fazer.
 */
const EVENTO_FORA_DO_CANAL = "evento_fora_do_canal";

/** O detalhe da pendência: o evento escolhido, pelo rótulo da tela e pelo nome da Meta. */
function eventoForaDoCanal(nome: string): string {
  return `Evento escolhido: ${rotuloDoEventoDaMeta(nome)} (${nome}).`;
}

/**
 * O nome que sai pelo canal: a compra, ou o evento padrão da Meta da etapa — o
 * do retrato gravado no primeiro envio e, só na falta dele, o da regra (a mesma
 * precedência do transporte direto). Etapa do Google, ou evento da Meta fora do
 * vocabulário do canal, não tem caminho por ele.
 */
function eventoParaOCanal(
  qualificacao: EventoDeEtapa | undefined,
  retrato: string | null | undefined,
): ChannelConversionInput["event"] | null {
  if (!qualificacao) return "Purchase";
  if (!qualificacao.eventoMeta) return null;
  const nome = retrato ?? qualificacao.eventoMeta;
  return EVENTOS_DE_ETAPA_NO_CANAL.find((e) => e === nome) ?? null;
}

/** O desfecho do canal, no vocabulário do transporte — um só caminho de registro. */
function doCanal(r: ChannelConversionResult): ResultadoDeEnvio {
  if (r.outcome === "ok") return { tipo: "ok", detalhe: r.detail };
  if (r.outcome === "retry")
    return { tipo: "transitorio", detalhe: r.detail, tentarEmMs: r.retryInMs };
  return { tipo: "permanente", detalhe: r.detail };
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
  naOrgParada: "pula",
  // As duas portas. Ver o cabeçalho: `lead.stage_changed` cobre o arrasto no
  // kanban E o mover em lote, e o `status` do payload não é confiável em nenhum.
  events: ["lead.won", "lead.stage_changed", "ad_conversion.retry_requested"],
  handle,
};
