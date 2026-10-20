/**
 * A CAMPANHA POR TRANSMISSÃO (migration 0712): a lista inteira entregue ao
 * provedor numa chamada, e o relatório dele trazido de volta, destinatário a
 * destinatário, a cada rodada.
 *
 * ═══ O caminho ═══
 *
 *  1. A primeira rodada com a campanha `running` confere a janela (a da campanha
 *     e a do número), revalida cada pessoa (bloqueio, opt-out, exclusão — como a
 *     rodada de sempre: a pessoa pode ter pedido para parar depois da
 *     preparação), cria a transmissão, grava o id NA CAMPANHA antes de qualquer
 *     telefone sair, reserva os destinatários (`sending`), entrega os telefones e
 *     manda.
 *  2. Cada rodada seguinte lê o relatório do provedor e leva a cada destinatário
 *     o que aconteceu: enviado, entregue, lido ou falhou, com o código. Quando o
 *     provedor termina e ninguém está pendente, a campanha conclui.
 *  3. O eco de cada mensagem chega pelo webhook com o id da transmissão: a
 *     ingestão acha aqui o destinatário (`ecoDaTransmissao`), grava a linha com o
 *     texto do modelo e a liga ao destinatário — daí em diante entrega e leitura
 *     chegam também pelo gatilho de ack, como em qualquer campanha.
 *
 * ═══ Por que o id é gravado antes dos telefones ═══
 *
 * Se a rodada cair entre criar e mandar, a seguinte encontra o id, lê o estado
 * (`draft`) e termina o serviço — os telefones repetidos o provedor ignora. Sem
 * o id gravado, ela criaria uma SEGUNDA transmissão, e a lista receberia em
 * dobro.
 *
 * ═══ Por que os valores do modelo são os do destinatário ═══
 *
 * O provedor recebe um valor por variável, o mesmo para todos. A rota só deixa
 * escolher a transmissão quando toda variável é texto fixo; mesmo assim, o valor
 * que sai é o CONGELADO na preparação, conferido igual em todos os destinatários
 * — o mesmo que a rodada de sempre mandaria a cada um. Se algum diferir, a
 * campanha pausa em vez de mandar a alguém um texto que não era o dele.
 *
 * Nunca lança para o cron por falha do provedor: limite de velocidade espera a
 * próxima rodada; o resto pausa a campanha com a frase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { decidePacing } from "@/lib/agent-engine/pacing/engine";
import { loadChannelKnobs, loadPacingState, recordSends } from "@/lib/agent-engine/pacing/store";
import { buildComponents, slotKey } from "@/lib/channels/meta/build-components";
import {
  ESTADOS_FINAIS_DA_TRANSMISSAO,
  ErroDaTransmissao,
  digitosDoTelefone,
  transmissaoDaConexao,
  type DestinatarioDaTransmissao,
  type EstadoDaTransmissao,
  type ModeloDaTransmissao,
  type OpsDeTransmissao,
} from "@/lib/channels/transmissao";
import { logger } from "@/lib/logger";

import { variaveisPorPessoa } from "./conteudo-do-canal";
import { motivoParaExcluir, recusouMarketing, statusDaSaida } from "./elegibilidade";
import { hashDoEndereco } from "./exclusoes";
import { variaveisDaCampanhaSchema } from "./modelo";
import { contratoDe, definicaoDaCampanha } from "./modelo-da-conexao";
import { podeMandarAgora } from "./ritmo";
import type { MotivoDeExclusao } from "./tipos";

/** O que a rodada precisa da campanha — as colunas vêm de `rodada.ts`. */
export interface CampanhaDaTransmissao {
  id: string;
  organization_id: string;
  channel_session_id: string;
  name: string;
  provider_template_name: string | null;
  provider_template_language: string | null;
  provider_template_variables: unknown;
  provider_broadcast_id: string | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
}

export interface ResultadoDaTransmissao {
  enviadas: number;
  pulados: number;
  concluidas: number;
  detalhe: string;
}

/** Páginas lidas do banco e do provedor: uma lista de 20.000 cabe com folga. */
const POR_PAGINA = 1_000;
const POR_PAGINA_DO_PROVEDOR = 100;
const MAX_PAGINAS = 200;
/** Ids por filtro `in (...)`: a URL do PostgREST tem teto, e lista longa corta sem aviso. */
const IDS_POR_FILTRO = 200;

const SO_O_CONTADOR = { enviadas: 0, pulados: 0, concluidas: 0 } as const;

export async function rodarCampanhaEmTransmissao(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  agora: Date,
): Promise<ResultadoDaTransmissao> {
  const ops = await transmissaoDaConexao(admin, {
    organizationId: campanha.organization_id,
    channelSessionId: campanha.channel_session_id,
  });
  if (!ops) {
    await pausar(admin, campanha.id, agora, {
      codigo: "transmissao_indisponivel",
      detalhe: "Este número não faz broadcast. Troque a velocidade para Rápido e retome a campanha.",
    });
    return { ...SO_O_CONTADOR, detalhe: "pausada:transmissao_indisponivel" };
  }

  try {
    const id = campanha.provider_broadcast_id;
    if (!id) return await entregarAoProvedor(admin, campanha, ops, agora, null);
    const { estado } = await ops.ler(id);
    if (estado === "draft") return await entregarAoProvedor(admin, campanha, ops, agora, id);
    return await acompanhar(admin, campanha, ops, id, estado, agora);
  } catch (err) {
    if (!(err instanceof ErroDaTransmissao)) throw err;
    if (err.ehLimiteDeVelocidade) return { ...SO_O_CONTADOR, detalhe: "limite:429" };
    logger.warn("[campanha] transmissão recusada pelo provedor", {
      campanha: campanha.id,
      status: err.status,
      codigo: err.codigo,
    });
    await pausar(admin, campanha.id, agora, {
      codigo: `transmissao_${err.codigo}`.slice(0, 80),
      detalhe: `O provedor recusou o broadcast: ${err.message}`.slice(0, 500),
    });
    return { ...SO_O_CONTADOR, detalhe: `pausada:transmissao_${err.codigo}` };
  }
}

// ─── 1. Entregar a lista ────────────────────────────────────────────────────

async function entregarAoProvedor(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  ops: OpsDeTransmissao,
  agora: Date,
  idExistente: string | null,
): Promise<ResultadoDaTransmissao> {
  const janela = await janelaAberta(admin, campanha, agora);
  if (!janela.aberta) return { ...SO_O_CONTADOR, detalhe: `ritmo:${janela.motivo}` };

  const { prontos, pulados } = await revalidarPendentes(admin, campanha, agora);
  const emVoo = await jaReservados(admin, campanha.id);
  if (prontos.length === 0 && emVoo.length === 0) {
    const concluidas = await concluirSeNadaEmVoo(admin, campanha.id, agora);
    return { enviadas: 0, pulados, concluidas, detalhe: concluidas > 0 ? "concluida" : "aguardando" };
  }

  const modelo = await modeloDaTransmissao(admin, campanha, [...prontos, ...emVoo]);
  if (!modelo.ok) {
    await pausar(admin, campanha.id, agora, { codigo: modelo.codigo, detalhe: modelo.detalhe });
    return { ...SO_O_CONTADOR, pulados, detalhe: `pausada:${modelo.codigo}` };
  }

  let id = idExistente;
  if (!id) {
    const criada = await ops.criar({ nome: campanha.name, modelo: modelo.modelo });
    const { data } = await admin
      .from("campaigns")
      .update({ provider_broadcast_id: criada.id })
      .eq("id", campanha.id)
      .eq("status", "running")
      .is("provider_broadcast_id", null)
      .select("id");
    if ((data ?? []).length === 0) {
      // Outra rodada chegou antes (ou a campanha saiu de `running`): a nossa
      // transmissão fica vazia no rascunho, e é ela que se descarta.
      await ops.cancelar(criada.id).catch(() => undefined);
      return { ...SO_O_CONTADOR, pulados, detalhe: "ja_entregue" };
    }
    id = criada.id;
  }

  const reservados = await reservar(admin, campanha, prontos, agora);
  const lista = [...reservados, ...emVoo];
  let estado: EstadoDaTransmissao;
  let puladosNoProvedor: number;
  try {
    puladosNoProvedor = (
      await ops.adicionar(
        id,
        lista.map((d) => d.telefone),
      )
    ).pulados;
    estado = (await ops.enviar(id)).estado;
  } catch (err) {
    // Nada saiu (ou não dá para saber): quem foi reservado volta à fila. Se o
    // provedor tiver mandado mesmo assim, o relatório da próxima rodada corrige
    // — `desfechoDaTransmissao` aceita `pending` como ponto de partida.
    await devolverAFila(
      admin,
      reservados.map((d) => d.id),
    );
    throw err;
  }

  // Fora do `try` de propósito: a lista JÁ saiu. Uma falha ao contar no livro do
  // ritmo não pode devolver à fila quem o provedor está entregando agora.
  try {
    await recordSends(getRequestPool(), campanha.organization_id, campanha.channel_session_id, agora, lista.length);
  } catch (err) {
    logger.warn("[campanha] envios da transmissão não contados no ritmo do número", {
      campanha: campanha.id,
      motivo: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    enviadas: lista.length,
    pulados,
    concluidas: 0,
    detalhe: `transmissao:${estado}:${lista.length}${puladosNoProvedor > 0 ? `:sem_whatsapp_${puladosNoProvedor}` : ""}`,
  };
}

interface Pronto {
  id: string;
  telefone: string;
  valores: Record<string, string> | null;
}

/**
 * Os pendentes da campanha, com os vetos por PESSOA refeitos agora — os mesmos
 * da rodada de sempre (`rodarUmaCampanha`), em lote. Quem caiu num veto sai da
 * fila com o motivo; o resto vai para o provedor.
 */
async function revalidarPendentes(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  agora: Date,
): Promise<{ prontos: Pronto[]; pulados: number }> {
  const candidatos: Array<Pronto & { motivo: MotivoDeExclusao | null; endereco: string }> = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .select(
        "id, contact_id, recipient_address, variables, " +
          "contacts(phone_number, is_blocked, is_personal, is_anonymized, consent)",
      )
      .eq("campaign_id", campanha.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
    if (error) throw new Error(`pendentes da transmissão: ${error.message}`);
    const linhas = (data ?? []) as unknown as Array<{
      id: string;
      contact_id: string;
      recipient_address: string | null;
      variables: unknown;
      contacts: {
        phone_number: string | null;
        is_blocked: boolean;
        is_personal: boolean;
        is_anonymized: boolean;
        consent: unknown;
      } | null;
    }>;
    for (const l of linhas) {
      const telefone = l.contacts?.phone_number ?? l.recipient_address;
      candidatos.push({
        id: l.id,
        telefone: (telefone ?? "").trim(),
        endereco: (telefone ?? "").trim(),
        valores: valoresCongelados(l.variables),
        motivo: motivoParaExcluir({
          contactId: l.contact_id,
          telefone,
          bloqueado: !!l.contacts?.is_blocked,
          pessoal: !!l.contacts?.is_personal,
          anonimizado: !!l.contacts?.is_anonymized,
          recusouMarketing: recusouMarketing(l.contacts?.consent),
        }),
      });
    }
    if (linhas.length < POR_PAGINA) break;
  }

  // A lista de exclusão da operação, revalidada AQUI e não só na preparação:
  // ela pode ter crescido depois do snapshot, e o ponto dela é impedir o envio.
  const semVeto = candidatos.filter((c) => c.motivo === null && c.endereco !== "");
  const suprimidos = new Set<string>();
  const hashes = [...new Set(semVeto.map((c) => hashDoEndereco(c.endereco)))];
  for (let i = 0; i < hashes.length; i += IDS_POR_FILTRO) {
    const { data } = await admin
      .from("campaign_suppressions")
      .select("recipient_address_hash")
      .eq("organization_id", campanha.organization_id)
      .in("recipient_address_hash", hashes.slice(i, i + IDS_POR_FILTRO));
    for (const l of (data ?? []) as Array<{ recipient_address_hash: string }>) suprimidos.add(l.recipient_address_hash);
  }

  const porMotivo = new Map<string, string[]>();
  const prontos: Pronto[] = [];
  for (const c of candidatos) {
    const motivo = c.motivo ?? (suprimidos.has(hashDoEndereco(c.endereco)) ? "suprimido" : null);
    if (motivo === null) {
      prontos.push({ id: c.id, telefone: c.telefone, valores: c.valores });
      continue;
    }
    porMotivo.set(motivo, [...(porMotivo.get(motivo) ?? []), c.id]);
  }
  let pulados = 0;
  for (const [motivo, ids] of porMotivo) {
    for (let i = 0; i < ids.length; i += IDS_POR_FILTRO) {
      const { data } = await admin
        .from("campaign_recipients")
        .update({
          status: motivo === "suprimido" ? "skipped" : statusDaSaida(motivo as MotivoDeExclusao),
          eligibility_status: "excluded",
          exclusion_reason: motivo,
          opted_out_at: motivo === "opt_out" ? agora.toISOString() : null,
        })
        .in("id", ids.slice(i, i + IDS_POR_FILTRO))
        .eq("status", "pending")
        .select("id");
      pulados += (data ?? []).length;
    }
  }
  return { prontos, pulados };
}

/** Quem uma rodada anterior já reservou e não chegou a sair (a rodada caiu). */
async function jaReservados(admin: SupabaseClient, campanhaId: string): Promise<Pronto[]> {
  const reservados: Pronto[] = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .select("id, recipient_address, variables, contacts(phone_number)")
      .eq("campaign_id", campanhaId)
      .eq("status", "sending")
      .order("id", { ascending: true })
      .range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
    if (error) throw new Error(`reservados da transmissão: ${error.message}`);
    const linhas = (data ?? []) as unknown as Array<{
      id: string;
      recipient_address: string | null;
      variables: unknown;
      contacts: { phone_number: string | null } | null;
    }>;
    for (const l of linhas) {
      reservados.push({
        id: l.id,
        telefone: (l.contacts?.phone_number ?? l.recipient_address ?? "").trim(),
        valores: valoresCongelados(l.variables),
      });
    }
    if (linhas.length < POR_PAGINA) break;
  }
  return reservados;
}

async function reservar(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  prontos: Pronto[],
  agora: Date,
): Promise<Pronto[]> {
  const reservadosIds = new Set<string>();
  for (let i = 0; i < prontos.length; i += IDS_POR_FILTRO) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .update({
        status: "sending",
        sending_at: agora.toISOString(),
        last_attempt_at: agora.toISOString(),
        attempt_count: 1,
        channel_session_id: campanha.channel_session_id,
      })
      .in(
        "id",
        prontos.slice(i, i + IDS_POR_FILTRO).map((p) => p.id),
      )
      .eq("status", "pending")
      .select("id");
    if (error) throw new Error(`reserva da transmissão: ${error.message}`);
    for (const l of (data ?? []) as Array<{ id: string }>) reservadosIds.add(l.id);
  }
  return prontos.filter((p) => reservadosIds.has(p.id));
}

async function devolverAFila(admin: SupabaseClient, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += IDS_POR_FILTRO) {
    await admin
      .from("campaign_recipients")
      .update({ status: "pending", sending_at: null })
      .in("id", ids.slice(i, i + IDS_POR_FILTRO))
      .eq("status", "sending");
  }
}

/**
 * A janela da campanha E a do número, como na rodada de sempre. A transmissão
 * não espaça mensagens nem conta teto: a lista sai inteira, de uma vez — o que
 * ela respeita é QUANDO sair.
 */
async function janelaAberta(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  agora: Date,
): Promise<{ aberta: true } | { aberta: false; motivo: string }> {
  const pool = getRequestPool();
  const k = await loadChannelKnobs(pool, campanha.organization_id, campanha.channel_session_id);
  const daCampanha = podeMandarAgora(
    {
      intervaloSegundos: null,
      janelaInicioHora: campanha.janela_inicio_hora,
      janelaFimHora: campanha.janela_fim_hora,
      tetoDiario: null,
      tetoHorario: null,
    },
    { ultimoEnvio: null, enviadasHoje: 0, enviadasNaUltimaHora: 0 },
    agora,
    k.knobs.timezone,
  );
  if (!daCampanha.pode) return { aberta: false, motivo: daCampanha.motivo };

  const { data: canal } = await admin
    .from("channel_sessions")
    .select("status, daily_message_limit")
    .eq("organization_id", campanha.organization_id)
    .eq("id", campanha.channel_session_id)
    .maybeSingle();
  const linha = canal as { status: string; daily_message_limit: number | null } | null;
  if (!linha || linha.status !== "WORKING") return { aberta: false, motivo: "canal_fora_do_ar" };

  const estado = await loadPacingState(pool, campanha.organization_id, campanha.channel_session_id, {
    now: agora,
    timezone: k.knobs.timezone,
    numberActivatedAt: k.numberActivatedAt,
  });
  const decisao = decidePacing({
    now: agora,
    knobs: k.knobs,
    state: estado,
    crmDailyLimit: linha.daily_message_limit ?? null,
    // A transmissão só existe no número oficial: o que vale aqui é a janela.
    banRisk: false,
  });
  return decisao.allow ? { aberta: true } : { aberta: false, motivo: `canal_${decisao.code}` };
}

/** Os valores do modelo congelados em `variables.modelo`, ou `null` se não há. */
function valoresCongelados(variables: unknown): Record<string, string> | null {
  if (!variables || typeof variables !== "object") return null;
  const modelo = (variables as Record<string, unknown>).modelo;
  if (!modelo || typeof modelo !== "object" || Array.isArray(modelo)) return null;
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(modelo as Record<string, unknown>)) {
    if (typeof v === "string") saida[k] = v;
  }
  return saida;
}

/** Os mesmos valores, sem depender da ordem das chaves. */
function assinatura(valores: Record<string, string> | null): string {
  if (valores === null) return "null";
  return JSON.stringify(Object.keys(valores).sort().map((k) => [k, valores[k]]));
}

export async function modeloDaTransmissao(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  destinatarios: Pick<Pronto, "valores">[],
): Promise<{ ok: true; modelo: ModeloDaTransmissao } | { ok: false; codigo: string; detalhe: string }> {
  const name = campanha.provider_template_name?.trim() ?? "";
  const language = campanha.provider_template_language?.trim() ?? "";
  if (!name || !language) {
    return { ok: false, codigo: "modelo_inexistente", detalhe: "Escolha o modelo aprovado da campanha." };
  }
  const variaveis = variaveisDaCampanhaSchema.safeParse(campanha.provider_template_variables ?? {});
  const porPessoa = variaveis.success ? variaveisPorPessoa(variaveis.data) : [];
  if (!variaveis.success || porPessoa.length > 0) {
    return {
      ok: false,
      codigo: "transmissao_variavel",
      detalhe:
        "O broadcast manda o mesmo texto a todos, e este modelo usa dados de cada pessoa. " +
        "Troque a velocidade para Rápido e retome a campanha.",
    };
  }

  const valores = destinatarios[0]?.valores ?? {};
  const referencia = assinatura(destinatarios[0]?.valores ?? null);
  if (destinatarios.some((d) => assinatura(d.valores) !== referencia)) {
    return {
      ok: false,
      codigo: "transmissao_variavel",
      detalhe:
        "Os destinatários têm valores diferentes no modelo, e o broadcast manda o mesmo a todos. " +
        "Troque a velocidade para Rápido e retome a campanha.",
    };
  }

  const definicao = await definicaoDaCampanha(admin, {
    organizationId: campanha.organization_id,
    channelSessionId: campanha.channel_session_id,
    name,
    language,
  });
  if (!definicao) {
    return { ok: false, codigo: "modelo_inexistente", detalhe: "O modelo da campanha não existe mais neste número." };
  }
  const contrato = contratoDe(definicao);
  let components: ModeloDaTransmissao["components"] = [];
  try {
    if (contrato.slots.length > 0) components = buildComponents(contrato, valores);
  } catch (err) {
    return {
      ok: false,
      codigo: "modelo_sem_valores",
      detalhe: err instanceof Error ? err.message.slice(0, 300) : "Falta valor para uma variável do modelo.",
    };
  }
  const valoresDoCorpo = contrato.slots
    .filter((s) => s.address.kind === "body" && /^\d+$/.test(s.key))
    .sort((a, b) => Number(a.key) - Number(b.key))
    .map((s) => valores[slotKey(s.address, s.key)] ?? "");
  return { ok: true, modelo: { name, language, components, valoresDoCorpo } };
}

// ─── 2. Acompanhar o relatório ──────────────────────────────────────────────

interface Nosso {
  id: string;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  message_id: string | null;
  rendered_body: string | null;
  telefone: string;
}

/** Status que nenhuma notícia do provedor muda: a pessoa já respondeu, saiu ou ficou de fora. */
const STATUS_ESTAVEIS = new Set(["replied", "opted_out", "cancelled", "skipped", "personal"]);
const ORDEM: Record<string, number> = { pending: 0, queued: 0, sending: 0, sent: 1, delivered: 2, read: 3 };

/**
 * O que o relatório do provedor muda num destinatário — puro, para o teste.
 * Nunca rebaixa: o relatório é lido a cada rodada, e uma leitura atrasada não
 * pode tirar o "lido" que o eco já trouxe.
 */
export function desfechoDaTransmissao(
  atual: Pick<Nosso, "status" | "sent_at" | "delivered_at" | "read_at">,
  item: DestinatarioDaTransmissao | undefined,
): Record<string, string | null> | null {
  if (!item) return null;
  const patch: Record<string, string | null> = {};
  if (item.enviadoEm && !atual.sent_at) patch.sent_at = item.enviadoEm;
  if (item.entregueEm && !atual.delivered_at) patch.delivered_at = item.entregueEm;
  if (item.lidoEm && !atual.read_at) patch.read_at = item.lidoEm;

  if (!STATUS_ESTAVEIS.has(atual.status)) {
    if (item.status === "failed") {
      if (atual.status in ORDEM && atual.status !== "delivered" && atual.status !== "read") {
        patch.status = "failed";
        patch.last_error_code = item.codigoDoErro ?? "transmissao_falhou";
        patch.last_error_detail = item.erro;
        patch.sending_at = null;
      }
    } else if (item.status !== "pending" && atual.status !== "failed") {
      if ((ORDEM[item.status] ?? 0) > (ORDEM[atual.status] ?? 0)) patch.status = item.status;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

async function acompanhar(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  ops: OpsDeTransmissao,
  id: string,
  estado: EstadoDaTransmissao,
  agora: Date,
): Promise<ResultadoDaTransmissao> {
  const { mudancas, pendentesNoProvedor } = await sincronizarTransmissao(admin, campanha, ops, id);
  if (!ESTADOS_FINAIS_DA_TRANSMISSAO.has(estado) || pendentesNoProvedor > 0) {
    return { ...SO_O_CONTADOR, detalhe: `transmissao:${estado}:${mudancas}` };
  }
  // O provedor terminou. Quem ainda está `sending` não está no relatório dele:
  // o número não tem WhatsApp, ou se repetia na lista — nunca vai sair.
  await fecharQuemFicou(admin, campanha.id, estado === "cancelled" ? "cancelled" : "failed", agora);
  const concluidas = await concluirSeNadaEmVoo(admin, campanha.id, agora);
  return { ...SO_O_CONTADOR, concluidas, detalhe: `transmissao:${estado}:${mudancas}:concluida` };
}

/**
 * Lê o relatório inteiro e leva a cada destinatário o que mudou. Exportada para
 * o cancelamento, que precisa do último retrato antes de fechar a campanha.
 */
export async function sincronizarTransmissao(
  admin: SupabaseClient,
  campanha: Pick<CampanhaDaTransmissao, "id" | "organization_id">,
  ops: OpsDeTransmissao,
  id: string,
): Promise<{ mudancas: number; pendentesNoProvedor: number }> {
  const porTelefone = new Map<string, DestinatarioDaTransmissao>();
  let pular = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const p = await ops.destinatarios(id, { pular, quantos: POR_PAGINA_DO_PROVEDOR });
    for (const item of p.itens) porTelefone.set(item.telefone, item);
    if (!p.temMais || p.lidos === 0) break;
    pular += p.lidos;
  }
  const pendentesNoProvedor = [...porTelefone.values()].filter((i) => i.status === "pending").length;

  const nossos = await destinatariosEntregues(admin, campanha.id);
  let mudancas = 0;
  const semMensagem: Array<{ id: string; wamid: string; corpo: string | null }> = [];
  for (const n of nossos) {
    const item = porTelefone.get(digitosDoTelefone(n.telefone));
    const patch = desfechoDaTransmissao(n, item);
    if (patch) {
      const { data } = await admin
        .from("campaign_recipients")
        .update(patch)
        .eq("id", n.id)
        .eq("status", n.status)
        .select("id");
      mudancas += (data ?? []).length;
    }
    if (item?.idDaMensagem && !n.message_id) {
      semMensagem.push({ id: n.id, wamid: item.idDaMensagem, corpo: n.rendered_body });
    }
  }
  await ligarAsMensagens(admin, campanha.organization_id, semMensagem);
  return { mudancas, pendentesNoProvedor };
}

async function destinatariosEntregues(admin: SupabaseClient, campanhaId: string): Promise<Nosso[]> {
  const nossos: Nosso[] = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .select(
        "id, status, sent_at, delivered_at, read_at, message_id, rendered_body, recipient_address, contacts(phone_number)",
      )
      .eq("campaign_id", campanhaId)
      .in("status", ["pending", "queued", "sending", "sent", "delivered", "read", "failed"])
      .order("id", { ascending: true })
      .range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
    if (error) throw new Error(`destinatários da transmissão: ${error.message}`);
    const linhas = (data ?? []) as unknown as Array<
      Omit<Nosso, "telefone"> & { recipient_address: string | null; contacts: { phone_number: string | null } | null }
    >;
    for (const l of linhas) {
      nossos.push({
        id: l.id,
        status: l.status,
        sent_at: l.sent_at,
        delivered_at: l.delivered_at,
        read_at: l.read_at,
        message_id: l.message_id,
        rendered_body: l.rendered_body,
        telefone: l.contacts?.phone_number ?? l.recipient_address ?? "",
      });
    }
    if (linhas.length < POR_PAGINA) break;
  }
  return nossos;
}

/**
 * O destinatário aponta para a linha da conversa quando o eco já chegou e a
 * ingestão não conseguiu ligar (o contato resolvido não era o da lista, por
 * exemplo). Com a ligação, entrega e leitura passam a vir também pelo gatilho de
 * ack — e a linha que nasceu com "[Template: nome]" ganha o texto que a pessoa
 * leu, que é o que o agente precisa quando ela responder.
 */
async function ligarAsMensagens(
  admin: SupabaseClient,
  organizationId: string,
  pares: Array<{ id: string; wamid: string; corpo: string | null }>,
): Promise<void> {
  for (let i = 0; i < pares.length; i += IDS_POR_FILTRO) {
    const lote = pares.slice(i, i + IDS_POR_FILTRO);
    const { data } = await admin
      .from("messages")
      .select("id, external_id, conversation_id")
      .eq("organization_id", organizationId)
      .in(
        "external_id",
        lote.map((p) => p.wamid),
      );
    const porWamid = new Map(
      ((data ?? []) as Array<{ id: string; external_id: string; conversation_id: string }>).map((m) => [m.external_id, m]),
    );
    for (const p of lote) {
      const m = porWamid.get(p.wamid);
      if (!m) continue;
      await admin
        .from("campaign_recipients")
        .update({ message_id: m.id, conversation_id: m.conversation_id })
        .eq("id", p.id)
        .is("message_id", null);
      if (p.corpo) {
        await admin
          .from("messages")
          .update({ body: p.corpo })
          .eq("organization_id", organizationId)
          .eq("id", m.id)
          .like("body", "[Template:%");
      }
    }
  }
}

async function fecharQuemFicou(
  admin: SupabaseClient,
  campanhaId: string,
  como: "failed" | "cancelled",
  agora: Date,
): Promise<void> {
  await admin
    .from("campaign_recipients")
    .update(
      como === "cancelled"
        ? { status: "cancelled", cancelled_at: agora.toISOString(), sending_at: null }
        : {
            status: "failed",
            sending_at: null,
            last_error_code: "transmissao_sem_registro",
            last_error_detail:
              "O provedor não registrou este destinatário: o número não tem WhatsApp ou estava repetido na lista.",
          },
    )
    .eq("campaign_id", campanhaId)
    .in("status", ["pending", "queued", "sending"]);
}

async function concluirSeNadaEmVoo(admin: SupabaseClient, campanhaId: string, agora: Date): Promise<number> {
  const { count } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campanhaId)
    .in("status", ["pending", "queued", "sending"]);
  if ((count ?? 0) > 0) return 0;
  const { data } = await admin
    .from("campaigns")
    .update({ status: "completed", completed_at: agora.toISOString() })
    .eq("id", campanhaId)
    .eq("status", "running")
    .select("id");
  return (data ?? []).length;
}

async function pausar(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  falha: { codigo: string; detalhe: string },
): Promise<void> {
  await admin
    .from("campaigns")
    .update({ status: "paused", paused_at: agora.toISOString(), failure_code: falha.codigo, failure_detail: falha.detalhe })
    .eq("id", campanhaId)
    .eq("status", "running");
}

// ─── 3. O cancelamento ──────────────────────────────────────────────────────

/**
 * Cancelar a campanha cancela o que o provedor ainda não mandou, traz o último
 * retrato do relatório e fecha quem ficou. Melhor esforço: a campanha já está
 * cancelada no CRM quando isto roda, e uma falha do provedor não a desfaz — fica
 * no log, com o id para conferir no painel dele.
 */
export async function encerrarTransmissao(
  admin: SupabaseClient,
  campanha: { id: string; organization_id: string; channel_session_id: string; provider_broadcast_id: string | null },
  agora: Date,
): Promise<void> {
  if (!campanha.provider_broadcast_id) return;
  try {
    const ops = await transmissaoDaConexao(admin, {
      organizationId: campanha.organization_id,
      channelSessionId: campanha.channel_session_id,
    });
    if (!ops) return;
    await ops.cancelar(campanha.provider_broadcast_id);
    await sincronizarTransmissao(admin, campanha, ops, campanha.provider_broadcast_id);
  } catch (err) {
    logger.warn("[campanha] cancelamento da transmissão no provedor falhou", {
      campanha: campanha.id,
      transmissao: campanha.provider_broadcast_id,
      motivo: err instanceof Error ? err.message : String(err),
    });
  }
  await fecharQuemFicou(admin, campanha.id, "cancelled", agora);
}

// ─── 4. O eco de cada mensagem ──────────────────────────────────────────────

export interface EcoDaTransmissao {
  campanhaId: string;
  destinatarioId: string;
  /** O texto do modelo congelado no destinatário — o que a pessoa recebeu. */
  corpo: string | null;
  modelo: string | null;
  idioma: string | null;
  versaoDoConteudo: number;
  transmissaoId: string;
}

/**
 * A campanha e o destinatário de uma mensagem que o provedor mandou por uma
 * transmissão — ou `null` quando a transmissão não é de campanha nenhuma (criada
 * no painel do provedor, por exemplo).
 */
export async function ecoDaTransmissao(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    transmissaoId: string;
    contactId: string;
    /** O telefone do outro lado, em E.164 — para quando o contato resolvido não é o da lista. */
    telefone?: string | null;
  },
): Promise<EcoDaTransmissao | null> {
  const { data: campanha } = await admin
    .from("campaigns")
    .select("id, content_version, provider_template_name, provider_template_language")
    .eq("organization_id", entrada.organizationId)
    .eq("provider_broadcast_id", entrada.transmissaoId)
    .maybeSingle();
  if (!campanha) return null;
  const c = campanha as {
    id: string;
    content_version: number;
    provider_template_name: string | null;
    provider_template_language: string | null;
  };
  const porContato = await admin
    .from("campaign_recipients")
    .select("id, rendered_body")
    .eq("campaign_id", c.id)
    .eq("contact_id", entrada.contactId)
    .limit(1)
    .maybeSingle();
  // O contato que a ingestão resolveu pode não ser o da lista (o mesmo número
  // gravado de outro jeito): o telefone para que a pessoa foi é a outra chave.
  const destinatario =
    porContato.data ??
    (entrada.telefone
      ? (
          await admin
            .from("campaign_recipients")
            .select("id, rendered_body")
            .eq("campaign_id", c.id)
            .eq("recipient_address", entrada.telefone)
            .limit(1)
            .maybeSingle()
        ).data
      : null);
  if (!destinatario) return null;
  const d = destinatario as { id: string; rendered_body: string | null };
  return {
    campanhaId: c.id,
    destinatarioId: d.id,
    corpo: d.rendered_body,
    modelo: c.provider_template_name,
    idioma: c.provider_template_language,
    versaoDoConteudo: c.content_version,
    transmissaoId: entrada.transmissaoId,
  };
}

/** Liga o destinatário à linha do eco: dali em diante o ack chega pelo gatilho. */
export async function ligarEcoAoDestinatario(
  admin: SupabaseClient,
  eco: EcoDaTransmissao,
  mensagem: { id: string; conversationId: string; enviadaEm: string | null },
): Promise<void> {
  await admin
    .from("campaign_recipients")
    .update({ message_id: mensagem.id, conversation_id: mensagem.conversationId })
    .eq("id", eco.destinatarioId)
    .is("message_id", null);
  await admin
    .from("campaign_recipients")
    .update({ status: "sent", sent_at: mensagem.enviadaEm ?? new Date().toISOString() })
    .eq("id", eco.destinatarioId)
    .in("status", ["pending", "queued", "sending"]);
}

/** Os metadados da linha do eco — os mesmos que o envio de campanha grava. */
export function metadataDoEco(eco: EcoDaTransmissao): Record<string, unknown> {
  return {
    source: "campaign",
    campaign_id: eco.campanhaId,
    campaign_recipient_id: eco.destinatarioId,
    campaign_content_version: eco.versaoDoConteudo,
    provider_broadcast_id: eco.transmissaoId,
  };
}
