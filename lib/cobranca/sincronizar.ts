/**
 * SINCRONIZAR E A RÉGUA EM AÇÃO (spec da cobrança do revendedor §3.2, §7c, §7d).
 *
 * O ÚNICO lugar que grava `estado`, `vencida_desde`, `relida_em` e
 * `link_de_pagamento`, e que suspende ou reativa por cobrança. Regras:
 *   - o provedor é lido FORA de qualquer transação ou lock (anti-pattern 9);
 *   - a leitura é gravada por compare-and-set em `relida_em`: sinal e cron
 *     podem reler ao mesmo tempo, e a leitura mais velha perde — nunca apaga a
 *     mais nova;
 *   - leitura que falha grava só `ultimo_erro`: o estado fica intacto, e a
 *     régua não roda sobre ele (com o provedor fora, nada é suspenso);
 *   - a régua age só por funções SQL idempotentes, e o aviso nasce junto com o
 *     item da Central (`fn_cobranca_registrar_aviso`); o e-mail vem depois,
 *     melhor esforço.
 * O `service_role` ignora RLS: toda cadeia filtra `organization_id`, que vem do
 * evento, da rodada do cron ou da sessão — nunca de um corpo de requisição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { textoDoAviso, type TextoDoAviso } from "@/lib/cobranca/avisos";
import { toleranciaDias } from "@/lib/cobranca/configuracao";
import { enviarAvisoAosAdmins } from "@/lib/cobranca/emails";
import { aplicarLeitura } from "@/lib/cobranca/estado";
import { adaptador as adaptadorPadrao } from "@/lib/cobranca/provedores";
import {
  ErroDoProvedor,
  paraErroDeLeitura,
  type AdaptadorDeCobranca,
  type ProvedorDeCobranca,
  type Situacao,
} from "@/lib/cobranca/provedores/contrato";
import { decidirRegua, type AcaoDaRegua } from "@/lib/cobranca/regua";
import type { AvisoDaRegua, ErroDeLeitura, EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";

export interface DependenciasDaCobranca {
  adaptador?: (id: ProvedorDeCobranca) => AdaptadorDeCobranca;
  agora?: () => Date;
  tolerancia?: () => Promise<number>;
  enviarAviso?: typeof enviarAvisoAosAdmins;
}

export type ResultadoDaSincronizacao =
  | { tipo: "isenta" }
  | { tipo: "sem_provedor"; acao: AcaoDaRegua["tipo"] }
  | { tipo: "aplicada"; estado: EstadoDaAssinatura; mudou: boolean; acao: AcaoDaRegua["tipo"] }
  | { tipo: "descartada" }
  | { tipo: "falhou"; erro: ErroDeLeitura; transitorio: boolean };

const COLUNAS =
  "organization_id, plano_id, plano_agendado_id, estado, trial_ate, provedor, provedor_cliente_id, provedor_assinatura_id, " +
  "vencida_desde, proximo_vencimento, cancela_no_fim, prazo_extra_ate, ultimo_aviso, ultimo_aviso_em, relida_em, " +
  "link_de_pagamento, assinaturas_vivas, updated_at";

interface Linha {
  organization_id: string;
  plano_id: string;
  plano_agendado_id: string | null;
  estado: EstadoDaAssinatura;
  trial_ate: string | null;
  provedor: ProvedorDeCobranca | null;
  provedor_cliente_id: string | null;
  provedor_assinatura_id: string | null;
  vencida_desde: string | null;
  proximo_vencimento: string | null;
  cancela_no_fim: boolean;
  prazo_extra_ate: string | null;
  ultimo_aviso: AvisoDaRegua | null;
  ultimo_aviso_em: string | null;
  relida_em: string | null;
  link_de_pagamento: string | null;
  assinaturas_vivas: number;
  /** Carimbado pelo gatilho `fn_touch_updated_at` em TODA escrita: é a versão da linha. */
  updated_at: string;
}

const SUSPENSAO_DE_COBRANCA: TipoDeSuspensao = "cobranca";
const MOTIVO_DA_SUSPENSAO = "Falta de pagamento";
const emData = (v: string | null) => (v === null ? null : new Date(v));
const emTexto = (d: Date | null) => (d === null ? null : d.toISOString());

async function lerLinha(admin: SupabaseClient, orgId: string): Promise<Linha | null> {
  const { data, error } = await admin.from("cobranca_assinaturas").select(COLUNAS).eq("organization_id", orgId).maybeSingle();
  if (error) throw new Error(`cobranca: leitura da assinatura falhou (${error.code ?? "sem_codigo"})`);
  return (data as Linha | null) ?? null;
}

function auditar(action: AuditAction, orgId: string, metadata: Record<string, unknown>): void {
  void audit({
    action,
    actorUserId: null,
    organizationId: orgId,
    bypassedRls: true,
    resourceType: "cobranca_assinatura",
    resourceId: orgId,
    metadata,
  });
}

export async function sincronizar(
  admin: SupabaseClient,
  orgId: string,
  deps: DependenciasDaCobranca = {},
): Promise<ResultadoDaSincronizacao> {
  const agora = deps.agora ?? (() => new Date());
  const primeira = await lerLinha(admin, orgId);
  if (!primeira) return { tipo: "isenta" };
  if (primeira.provedor === null || primeira.provedor_cliente_id === null) {
    return { tipo: "sem_provedor", acao: await aplicarRegua(admin, orgId, deps) };
  }
  const provedor = primeira.provedor;
  const cliente = primeira.provedor_cliente_id;

  const lidoEm = agora();
  let situacao: Situacao;
  try {
    situacao = await (deps.adaptador ?? adaptadorPadrao)(provedor).lerSituacao({ clienteRef: cliente });
  } catch (e) {
    const erro = paraErroDeLeitura(e);
    const { error } = await admin
      .from("cobranca_assinaturas")
      .update({ ultimo_erro: erro, ultimo_erro_em: lidoEm.toISOString() })
      .eq("organization_id", orgId)
      .eq("provedor_cliente_id", cliente);
    logger.warn("cobranca.leitura_falhou", {
      organization_id: orgId,
      erro,
      status: e instanceof ErroDoProvedor ? e.status : null,
      codigo: e instanceof ErroDoProvedor ? e.codigo : "fora_do_adaptador",
      erro_gravado: !error,
    });
    return { tipo: "falhou", erro, transitorio: erro === "provedor_fora" };
  }

  // Concorrência otimista na linha INTEIRA: `updated_at` é a versão dela. Se
  // alguém gravou entre a leitura da linha e agora (troca de plano, publicação,
  // prazo, outra releitura), relê a linha e recalcula UMA vez — sem isso a
  // escrita, calculada sobre a linha velha, apagaria a do outro (o
  // `plano_agendado_id` recém-agendado, ou o "voltou ao teste" da publicação).
  // O provedor NÃO é relido: a leitura dele é o dado mais novo que existe.
  let linha: Linha | null = primeira;
  for (let tentativa = 1; ; tentativa += 1) {
    // Isentada, publicada ou com outro cliente no meio: esta leitura é de outra
    // conta ou de ninguém. Aplicá-la daria "ativa" a quem voltou ao teste.
    if (!linha || linha.provedor !== provedor || linha.provedor_cliente_id !== cliente) return { tipo: "descartada" };
    const r = aplicarLeitura(
      {
        estado: linha.estado,
        planoId: linha.plano_id,
        planoAgendadoId: linha.plano_agendado_id,
        trialAte: emData(linha.trial_ate),
        vencidaDesde: emData(linha.vencida_desde),
        proximoVencimento: emData(linha.proximo_vencimento),
        provedorAssinaturaId: linha.provedor_assinatura_id,
      },
      situacao,
      lidoEm,
    );
    const campos: Record<string, unknown> = {
      estado: r.estado,
      vencida_desde: emTexto(r.vencidaDesde),
      proximo_vencimento: emTexto(r.proximoVencimento),
      cancela_no_fim: r.cancelaNoFim,
      provedor_assinatura_id: r.provedorAssinaturaId,
      assinaturas_vivas: r.assinaturasVivas,
      relida_em: lidoEm.toISOString(),
      ultimo_erro: r.ultimoErro,
      ultimo_erro_em: r.ultimoErro === null ? null : lidoEm.toISOString(),
      link_de_pagamento: situacao.linkDePagamento,
      updated_at: lidoEm.toISOString(),
      // O plano só existe no nosso banco: a leitura o toca só quando o agendado virou.
      ...(r.planoAplicado ? { plano_id: r.planoId, plano_agendado_id: r.planoAgendadoId } : {}),
      // Assinatura morta: o agendado era dela. Sem gravar o descarte, ele viraria na renovação seguinte.
      ...(r.descartarAgendado ? { plano_agendado_id: null } : {}),
      ...(r.zerarAviso ? { ultimo_aviso: null, ultimo_aviso_em: null } : {}),
      ...(r.limparCheckout ? { checkout_url: null, checkout_expira_em: null } : {}),
    };
    // Duas guardas: a linha é a que foi lida (updated_at) e nenhuma leitura
    // mais NOVA já foi aplicada (relida_em) — sinal e cron correm juntos.
    const { data: aplicada, error } = await admin
      .from("cobranca_assinaturas")
      .update(campos)
      .eq("organization_id", orgId)
      .eq("updated_at", linha.updated_at)
      .or(`relida_em.is.null,relida_em.lt."${lidoEm.toISOString()}"`)
      .select("organization_id")
      .maybeSingle();
    if (error) throw new Error(`cobranca: gravação da leitura falhou (${error.code ?? "sem_codigo"})`);
    if (aplicada) {
      if (r.mudouEstado) {
        auditar("cobranca.estado_mudou", orgId, { de: linha.estado, para: r.estado, status_bruto: situacao.statusBruto });
      }
      if (r.planoAplicado) {
        auditar("cobranca.plano_trocado", orgId, { de: linha.plano_id, para: r.planoId, quando: "aplicado" });
      }
      if (r.zerarAviso) await fecharAvisosDaRegua(admin, orgId);
      return { tipo: "aplicada", estado: r.estado, mudou: r.mudouEstado, acao: await aplicarRegua(admin, orgId, deps) };
    }
    if (tentativa === 2) return { tipo: "descartada" };
    linha = await lerLinha(admin, orgId);
  }
}

/** Pagou: os avisos da régua na Central saem de "abertos" (o problema acabou). */
async function fecharAvisosDaRegua(admin: SupabaseClient, orgId: string): Promise<void> {
  const { error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("kind", "cobranca")
    .is("ref_kind", null)
    .eq("status", "open");
  if (error) logger.warn("cobranca.avisos_nao_fechados", { organization_id: orgId, codigo: error.code ?? null });
}

async function registrarAviso(
  admin: SupabaseClient,
  orgId: string,
  aviso: AvisoDaRegua,
  desde: Date | null,
  texto: TextoDoAviso,
): Promise<boolean> {
  const { data, error } = await admin.rpc("fn_cobranca_registrar_aviso", {
    p_org: orgId,
    p_aviso: aviso,
    p_desde: emTexto(desde),
    p_titulo: texto.titulo,
    p_corpo: texto.corpo,
    p_severidade: texto.severidade,
  });
  if (error) throw new Error(`cobranca: aviso não registrado (${error.code ?? "sem_codigo"})`);
  return data === true;
}

const mudou = (data: unknown) => (data as { changed?: unknown } | null)?.changed === true;

export async function aplicarRegua(
  admin: SupabaseClient,
  orgId: string,
  deps: DependenciasDaCobranca = {},
): Promise<AcaoDaRegua["tipo"]> {
  const agora = (deps.agora ?? (() => new Date()))();
  const linha = await lerLinha(admin, orgId);
  if (!linha) return "nada";
  const { data: orgLida, error: erroDaOrg } = await admin
    .from("organizations")
    .select("status, suspended_kind, locale, timezone")
    .eq("id", orgId)
    .maybeSingle();
  if (erroDaOrg) throw new Error(`cobranca: leitura da empresa falhou (${erroDaOrg.code ?? "sem_codigo"})`);
  const org = orgLida as { status: string; suspended_kind: string | null; locale: string | null; timezone: string | null } | null;
  if (!org) return "nada";

  const decisao = decidirRegua(
    {
      estado: linha.estado,
      temProvedor: linha.provedor !== null,
      cancelaNoFim: linha.cancela_no_fim,
      assinaturasVivas: linha.assinaturas_vivas,
      trialAte: emData(linha.trial_ate),
      vencidaDesde: emData(linha.vencida_desde),
      proximoVencimento: emData(linha.proximo_vencimento),
      prazoExtraAte: emData(linha.prazo_extra_ate),
      ultimoAviso: linha.ultimo_aviso,
      ultimoAvisoEm: emData(linha.ultimo_aviso_em),
      relidaEm: emData(linha.relida_em),
    },
    { status: org.status, suspendedKind: org.suspended_kind },
    agora,
    await (deps.tolerancia ?? toleranciaDias)(),
  );

  if (decisao.estado !== linha.estado || decisao.gravarVencidaDesde !== null) {
    // Compare-and-set no estado lido: se alguém mudou a linha no meio, a próxima rodada decide de novo.
    const { data: gravou, error } = await admin
      .from("cobranca_assinaturas")
      .update({
        estado: decisao.estado,
        ...(decisao.gravarVencidaDesde ? { vencida_desde: decisao.gravarVencidaDesde.toISOString() } : {}),
        updated_at: agora.toISOString(),
      })
      .eq("organization_id", orgId)
      .eq("estado", linha.estado)
      .select("organization_id")
      .maybeSingle();
    if (error) throw new Error(`cobranca: transição de tempo não gravada (${error.code ?? "sem_codigo"})`);
    if (!gravou) return "nada";
    if (decisao.estado !== linha.estado) {
      auditar("cobranca.estado_mudou", orgId, { de: linha.estado, para: decisao.estado, status_bruto: "regua:fim_do_teste" });
    }
  }

  const idioma = normalizarIdioma(org.locale);
  const contexto = { idioma, fuso: org.timezone };
  const enviar = deps.enviarAviso ?? enviarAvisoAosAdmins;
  const acao = decisao.acao;
  switch (acao.tipo) {
    case "nada":
      return "nada";
    case "reativar": {
      const { data, error } = await admin.rpc("fn_reativar_organizacao", {
        p_org: orgId,
        p_kind_exigido: SUSPENSAO_DE_COBRANCA,
        p_ator: null,
      });
      if (error) throw new Error(`cobranca: reativação falhou (${error.code ?? "sem_codigo"})`);
      if (!mudou(data)) return "nada";
      auditar("cobranca.org_reativada", orgId, { motivo: "pagamento_confirmado" });
      await enviar(admin, { id: orgId, idioma }, textoDoAviso("liberada", { ...contexto, data: null, origem: "atraso" }), null);
      return "reativar";
    }
    case "suspender": {
      // A decisão veio da linha lida acima; um pagamento pode ter sido gravado
      // no meio. A função trava a linha e só suspende quem AINDA deve.
      const { data, error } = await admin.rpc("fn_cobranca_suspender_se_devendo", {
        p_org: orgId,
        p_motivo: MOTIVO_DA_SUSPENSAO,
      });
      if (error) throw new Error(`cobranca: suspensão falhou (${error.code ?? "sem_codigo"})`);
      if (!mudou(data)) return "nada";
      auditar("cobranca.org_suspensa", orgId, { debito_desde: acao.debitoDesde.toISOString() });
      const texto = textoDoAviso("suspensa", { ...contexto, data: null, origem: "atraso" });
      if (await registrarAviso(admin, orgId, "suspensa", acao.debitoDesde, texto)) {
        await enviar(admin, { id: orgId, idioma }, texto, linha.link_de_pagamento);
      }
      return "suspender";
    }
    case "avisar": {
      const texto = textoDoAviso(acao.aviso, { ...contexto, data: acao.data, origem: acao.origem });
      if (!(await registrarAviso(admin, orgId, acao.aviso, acao.debitoDesde, texto))) return "nada";
      await enviar(admin, { id: orgId, idioma }, texto, linha.link_de_pagamento);
      return "avisar";
    }
    case "cancelar_no_provedor": {
      if (linha.provedor === null || linha.provedor_assinatura_id === null) return "nada";
      // HTTP antes da escrita curta, fora de transação (§7, regra comum).
      await (deps.adaptador ?? adaptadorPadrao)(linha.provedor).cancelarNoFim(linha.provedor_assinatura_id);
      const { error } = await admin
        .from("cobranca_assinaturas")
        .update({ cancela_no_fim: true, updated_at: agora.toISOString() })
        .eq("organization_id", orgId);
      if (error) throw new Error(`cobranca: cancelamento não gravado (${error.code ?? "sem_codigo"})`);
      auditar("cobranca.assinatura_cancelada", orgId, { motivo: "org_redigida" });
      return "cancelar_no_provedor";
    }
  }
}
