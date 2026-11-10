/**
 * A QUEDA DO NÚMERO VIRA IMPORTAÇÃO SOZINHA (Spec 32, itens 2 e 4).
 *
 * Quando a conexão de WhatsApp cai por mais de alguns minutos e volta com QR
 * novo, as mensagens trocadas pelo celular nesse período não chegam ao CRM.
 * Este módulo acha essas quedas pelo `event_log` (o par de
 * `channel_session.status_changed`: saída de `WORKING`, volta a `WORKING`),
 * abre uma importação `aguardando` para cada uma, e a promove a `rodando` só
 * depois de conferir ao vivo que o número ainda é o mesmo.
 *
 * ─── Por que o disparo mora aqui e não num consumidor de evento ─────────────
 *
 * O evento nasce `done` na lista de "registro" (`fn_event_log_e_registro`):
 * ninguém consome. Ler o `event_log` a cada minuto, por organização, é o
 * caminho que não mexe no registro do banco. Por isso a janela de olhar para
 * trás é fixa (7 dias) e a garantia de "uma importação por queda" fica no
 * banco (`evento_de_saida_id`, índice único parcial), não na memória do cron.
 *
 * ─── Por que a janela começa 10 min ANTES da saída e termina NA volta ───────
 *
 * Os eventos podem vir da varredura de saúde, com até 5 min de atraso. A
 * janela termina no instante do evento de volta (`ate`), nunca depois: uma
 * mensagem ao vivo, gravada antes pela recuperação, faria o webhook achar a
 * repetida (23505) e não aplicar os efeitos nem chamar o agente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { lerGuardarHistorico } from "@/lib/channels/acervo-do-historico";
import { CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { avisarResumoDaRecuperacao, type MotivoDoResumo } from "@/lib/channels/historico/avisos-da-queda";
import { numeroObservadoDaSessao } from "@/lib/channels/numero-observado";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { logger } from "@/lib/logger";
import { STATUS_OPERANTE } from "@/lib/organizacao/operante";
import { getWahaClient } from "@/lib/waha/client";

export interface Queda {
  organizationId: string;
  channelSessionId: string;
  eventoDeSaidaId: string;
  saidaEm: Date;
  voltaEm: Date;
}

/** Queda mais curta que isto é reinício: o servidor não perdeu nada (B1, B5). */
export const DURACAO_MINIMA_MS = 5 * 60_000;
/** Quanto antes da saída a janela começa (o evento pode chegar com atraso). */
export const MARGEM_ANTES_MS = 10 * 60_000;
/** Queda cuja volta é mais antiga que isto não é recuperada sozinha. */
export const OLHAR_PARA_TRAS_MS = 7 * 24 * 3_600_000;
/** Sem conseguir ler o número por este tempo, a importação é cancelada. */
export const TETO_PARA_CONFIRMAR_NUMERO_MS = 60 * 60_000;

const EVENTO_DE_STATUS = "channel_session.status_changed";
/** Janela do aviso "acervo desligado": só a volta recente avisa, para não repetir a cada minuto. */
const JANELA_DO_AVISO_DO_ACERVO_MS = 10 * 60_000;
const TABELA = "importacoes_de_historico";
const PAGINA_DE_EVENTOS = 1000;
const LOTE_DE_PREPARO = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Evento {
  id: string;
  created_at: string;
  payload: Record<string, unknown>;
}

/**
 * Pura: recebe os eventos de status de UMA conexão em ordem de created_at e
 * devolve as quedas fechadas (saída seguida de volta).
 *
 * Saída sem volta fica de fora: ainda não há o que recuperar. Uma saída que
 * volta em menos de 5 min também fica de fora, e a saída pendente é descartada
 * para a próxima volta não casar com ela.
 */
export function quedasDosEventos(
  eventos: Array<{ id: string; created_at: string; payload: Record<string, unknown> }>,
): Array<{ eventoDeSaidaId: string; saidaEm: Date; voltaEm: Date; numeroNaSaida: string | null }> {
  const quedas: Array<{ eventoDeSaidaId: string; saidaEm: Date; voltaEm: Date; numeroNaSaida: string | null }> = [];
  let saida: { id: string; em: Date; numero: string | null } | null = null;
  for (const ev of eventos) {
    if (saida === null) {
      if (ev.payload.from_status === "WORKING" && ev.payload.to_status !== "WORKING") {
        // O número de ANTES da queda é o que o gatilho gravou na saída. O
        // `channel_sessions.phone_number` de agora não serve: a tela de Conexões
        // o regrava quando outro aparelho é pareado, e a conferência compararia
        // o número novo com ele mesmo.
        const numero = ev.payload.phone_number;
        saida = { id: ev.id, em: new Date(ev.created_at), numero: typeof numero === "string" && numero ? numero : null };
      }
      continue;
    }
    if (ev.payload.to_status === "WORKING") {
      const volta = new Date(ev.created_at);
      if (volta.getTime() - saida.em.getTime() >= DURACAO_MINIMA_MS) {
        quedas.push({ eventoDeSaidaId: saida.id, saidaEm: saida.em, voltaEm: volta, numeroNaSaida: saida.numero });
      }
      saida = null;
    }
  }
  return quedas;
}

/**
 * As organizações que operam (a régua única de `lib/organizacao/operante.ts`).
 * Quem chama faz um laço por organização, e cada uma é filtrada à mão.
 */
export async function organizacoesOperantes(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("organizations").select("id").eq("status", STATUS_OPERANTE);
  if (error) throw new Error(`organizations: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((o) => o.id);
}

/** Todos os eventos de status de UMA organização desde `desde`, paginados. */
async function eventosDaOrganizacao(admin: SupabaseClient, organizationId: string, desde: string): Promise<Evento[]> {
  const todos: Evento[] = [];
  for (let de = 0; ; de += PAGINA_DE_EVENTOS) {
    // Toda consulta filtra a organização: o admin ignora RLS, e o log tem
    // eventos de todas as empresas.
    const { data, error } = await admin
      .from("event_log")
      .select("id, created_at, payload")
      .eq("organization_id", organizationId)
      .eq("event_type", EVENTO_DE_STATUS)
      .gte("created_at", desde)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(de, de + PAGINA_DE_EVENTOS - 1);
    if (error) throw new Error(`event_log: ${error.message}`);
    const pagina = (data ?? []) as Evento[];
    todos.push(...pagina);
    if (pagina.length < PAGINA_DE_EVENTOS) break;
  }
  return todos;
}

/** O aviso de "Guardar o histórico desligado" só sai da volta recente. */
function voltouHa(voltaEm: Date, agora: Date, janelaMs: number): boolean {
  return voltaEm.getTime() >= agora.getTime() - janelaMs;
}

/**
 * Para cada organização operante, acha as quedas fechadas recentes de conexões
 * WAHA ativas e abre UMA importação `aguardando` por queda. Com
 * "Guardar o histórico" desligado não há o que buscar: só avisa.
 */
export async function abrirRecuperacoesDasQuedas(admin: SupabaseClient, agora: Date): Promise<{ criadas: number }> {
  let criadas = 0;
  const desde = new Date(agora.getTime() - OLHAR_PARA_TRAS_MS - 24 * 3_600_000).toISOString();
  for (const organizationId of await organizacoesOperantes(admin)) {
    try {
      criadas += await abrirDaOrganizacao(admin, organizationId, desde, agora);
    } catch (err) {
      logger.warn("[historico-quedas] abrir recuperações falhou", {
        organizationId,
        detail: err instanceof Error ? err.message : "erro",
      });
    }
  }
  return { criadas };
}

async function abrirDaOrganizacao(admin: SupabaseClient, organizationId: string, desde: string, agora: Date): Promise<number> {
  const eventos = await eventosDaOrganizacao(admin, organizationId, desde);
  // Agrupa por conexão: a queda é um par de eventos da MESMA conexão.
  const porConexao = new Map<string, Evento[]>();
  for (const ev of eventos) {
    const conexao = ev.payload.channel_session_id;
    if (typeof conexao !== "string" || !UUID.test(conexao)) continue;
    const lista = porConexao.get(conexao) ?? [];
    lista.push(ev);
    porConexao.set(conexao, lista);
  }
  if (porConexao.size === 0) return 0;

  // Só vale a conexão que existe nesta organização, é WAHA e não está arquivada.
  // Conexão de outro provedor (redes sociais, voz) não dispara nada.
  const { data: sessoes, error } = await admin
    .from("channel_sessions")
    .select("id, metadata")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_WAHA)
    .is("archived_at", null)
    .in("id", [...porConexao.keys()]);
  if (error) throw new Error(`channel_sessions: ${error.message}`);
  const porId = new Map(
    ((sessoes ?? []) as Array<{ id: string; metadata: unknown }>).map((s) => [s.id, s]),
  );

  let criadas = 0;
  for (const [conexao, lista] of porConexao) {
    const sessao = porId.get(conexao);
    if (!sessao) continue;
    for (const queda of quedasDosEventos(lista.map((e) => ({ id: e.id, created_at: e.created_at, payload: e.payload })))) {
      // Volta antiga demais: não é recuperada sozinha.
      if (queda.voltaEm.getTime() < agora.getTime() - OLHAR_PARA_TRAS_MS) continue;
      const aberta: Queda = { organizationId, channelSessionId: conexao, ...queda };

      if (!lerGuardarHistorico(sessao.metadata)) {
        // Sem o acervo ligado não há o que buscar no servidor do canal.
        if (voltouHa(queda.voltaEm, agora, JANELA_DO_AVISO_DO_ACERVO_MS)) {
          await avisarResumoDaRecuperacao(admin, {
            organizationId,
            channelSessionId: conexao,
            motivo: "acervo_desligado",
          });
        }
        continue;
      }

      const desdeDaJanela = new Date(aberta.saidaEm.getTime() - MARGEM_ANTES_MS);
      const { data: criada, error: erroDeCriacao } = await admin
        .from(TABELA)
        .insert({
          organization_id: organizationId,
          channel_session_id: conexao,
          status: "aguardando",
          dias: null,
          desde: desdeDaJanela.toISOString(),
          ate: aberta.voltaEm.toISOString(),
          escopo: "so_crm",
          origem: "queda",
          evento_de_saida_id: aberta.eventoDeSaidaId,
          numero_esperado: queda.numeroNaSaida,
          criada_por: null,
          cursor: {},
        } as never)
        .select("id")
        .single();
      if (erroDeCriacao) {
        // 23505: outra passada já abriu a importação desta queda. Não é erro.
        if ((erroDeCriacao as { code?: string }).code === "23505") continue;
        throw new Error(`importacoes_de_historico: ${erroDeCriacao.message}`);
      }
      const id = (criada as { id: string }).id;
      criadas += 1;
      void audit({
        action: "channel.historico_import_started",
        organizationId,
        resourceType: "channel_session",
        resourceId: aberta.channelSessionId,
        bypassedRls: true,
        metadata: {
          importacao_id: id,
          origem: "queda",
          desde: desdeDaJanela.toISOString(),
          ate: aberta.voltaEm.toISOString(),
        },
      });
    }
  }
  return criadas;
}

/**
 * O número AO VIVO da conexão, ou `null` quando não dá para ler. `null` cobre
 * tudo o que não é confirmação: sem transporte, sem sessão, fora de `WORKING`
 * (onde o `me` do transporte pode ser do aparelho antigo, ver numero-observado).
 */
async function numeroAoVivo(nomeNoCanal: string | null): Promise<string | null> {
  if (!nomeNoCanal) return null;
  const canal = getWahaClient();
  if (!canal) return null;
  const sessao = await canal.getVerifiedSession(nomeNoCanal);
  if (!sessao) return null;
  return numeroObservadoDaSessao({
    jid: typeof sessao.me?.id === "string" ? sessao.me.id : null,
    statusAoVivo: sessao.status,
    gravado: null,
  });
}

interface LinhaAguardando {
  id: string;
  channel_session_id: string;
  numero_esperado: string | null;
  desde: string | null;
  ate: string | null;
  created_at: string;
}

/**
 * Antes de começar, confere ao vivo que o número da conexão é o mesmo da
 * queda. Igual: promove a `rodando`. Diferente: cancela e avisa. Ilegível:
 * segue esperando, e depois de 60 min cancela e avisa. Nunca começa sem confirmar.
 */
export async function prepararRecuperacoesAguardando(
  admin: SupabaseClient,
  agora: Date,
): Promise<{ promovidas: number; canceladas: number }> {
  let promovidas = 0;
  let canceladas = 0;
  for (const organizationId of await organizacoesOperantes(admin)) {
    try {
      const r = await prepararDaOrganizacao(admin, organizationId, agora);
      promovidas += r.promovidas;
      canceladas += r.canceladas;
    } catch (err) {
      logger.warn("[historico-quedas] preparo das recuperações falhou", {
        organizationId,
        detail: err instanceof Error ? err.message : "erro",
      });
    }
  }
  return { promovidas, canceladas };
}

async function prepararDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<{ promovidas: number; canceladas: number }> {
  const { data, error } = await admin
    .from(TABELA)
    .select("id, channel_session_id, numero_esperado, desde, ate, created_at")
    .eq("organization_id", organizationId)
    .eq("origem", "queda")
    .eq("status", "aguardando")
    .order("created_at", { ascending: true })
    .limit(LOTE_DE_PREPARO);
  if (error) throw new Error(`importacoes_de_historico: ${error.message}`);
  const linhas = (data ?? []) as LinhaAguardando[];
  if (linhas.length === 0) return { promovidas: 0, canceladas: 0 };

  const { data: sessoes, error: erroDeSessao } = await admin
    .from("channel_sessions")
    .select("id, waha_session_name")
    .eq("organization_id", organizationId)
    .in("id", linhas.map((l) => l.channel_session_id));
  if (erroDeSessao) throw new Error(`channel_sessions: ${erroDeSessao.message}`);
  const nomePorConexao = new Map(
    ((sessoes ?? []) as Array<{ id: string; waha_session_name: string | null }>).map((s) => [s.id, s.waha_session_name]),
  );

  let promovidas = 0;
  let canceladas = 0;
  for (const imp of linhas) {
    try {
      const nome = nomePorConexao.get(imp.channel_session_id) ?? null;
      let aoVivo: string | null = null;
      try {
        aoVivo = await numeroAoVivo(nome);
      } catch (err) {
        // Falha ao ler não é número diferente: conta como ilegível.
        logger.warn("[historico-quedas] leitura do número falhou", {
          importacaoId: imp.id,
          detail: err instanceof Error ? err.message : "erro",
        });
      }
      const esperado = imp.numero_esperado;
      // Conexão que nunca gravou número (`numero_esperado` nulo) não tem com o que comparar:
      // conta como ilegível, igual a uma leitura que falhou.
      if (aoVivo === null || !esperado) {
        // Ainda não dá para confirmar. Só cancela depois do teto de espera.
        if (agora.getTime() - new Date(imp.created_at).getTime() > TETO_PARA_CONFIRMAR_NUMERO_MS) {
          if (await cancelarAguardando(admin, organizationId, imp, "número não confirmado", "numero_nao_confirmado")) {
            canceladas += 1;
          }
        }
        continue;
      }

      // Comparação pelas variantes do nono dígito: 12 e 13 dígitos são o mesmo celular.
      if (canonicalPhoneBR(aoVivo) !== canonicalPhoneBR(esperado)) {
        if (await cancelarAguardando(admin, organizationId, imp, "o número da conexão mudou", "numero_mudou")) {
          canceladas += 1;
        }
        continue;
      }

      const { data: subiu, error: erroDePromocao } = await admin
        .from(TABELA)
        .update({ status: "rodando", updated_at: agora.toISOString() } as never)
        .eq("id", imp.id)
        .eq("organization_id", organizationId)
        .eq("status", "aguardando")
        .select("id");
      if (erroDePromocao) {
        // 23505: outra importação já está rodando nesta conexão. Espera a próxima passada.
        if ((erroDePromocao as { code?: string }).code === "23505") continue;
        throw new Error(`importacoes_de_historico: ${erroDePromocao.message}`);
      }
      if ((subiu ?? []).length > 0) promovidas += 1;
    } catch (err) {
      logger.warn("[historico-quedas] preparo de uma recuperação falhou", {
        importacaoId: imp.id,
        detail: err instanceof Error ? err.message : "erro",
      });
    }
  }
  return { promovidas, canceladas };
}

/** Cancela uma importação da queda que ainda espera, audita e abre o aviso. */
async function cancelarAguardando(
  admin: SupabaseClient,
  organizationId: string,
  imp: LinhaAguardando,
  erro: string,
  motivo: MotivoDoResumo,
): Promise<boolean> {
  const { data, error } = await admin
    .from(TABELA)
    .update({ status: "cancelada", erro, updated_at: new Date().toISOString() } as never)
    .eq("id", imp.id)
    .eq("organization_id", organizationId)
    .eq("status", "aguardando")
    .select("id");
  if (error) throw new Error(`importacoes_de_historico: ${error.message}`);
  if ((data ?? []).length === 0) return false;
  void audit({
    action: "channel.historico_import_cancelled",
    organizationId,
    resourceType: "channel_session",
    resourceId: imp.channel_session_id,
    bypassedRls: true,
    metadata: { importacao_id: imp.id, origem: "queda", motivo: erro },
  });
  await avisarResumoDaRecuperacao(admin, {
    organizationId,
    channelSessionId: imp.channel_session_id,
    motivo,
    ...(imp.desde ? { desde: imp.desde } : {}),
    ...(imp.ate ? { ate: imp.ate } : {}),
  });
  return true;
}
