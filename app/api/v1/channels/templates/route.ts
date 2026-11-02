import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/channels/templates — o espelho local + o CONTRATO derivado de cada um.
 * POST  /api/v1/channels/templates — sincroniza com a Graph API; e CRIA, EDITA ou APAGA
 *                                    uma definição pelo CRM (#3635).
 * PATCH /api/v1/channels/templates — salva (ou esquece) o link da mídia de um modelo.
 *
 * O contrato vai derivado no payload, e não guardado no banco, de propósito: guardar
 * o derivado criaria a segunda fonte da verdade que esta fase inteira existe para
 * eliminar. A tela e o montador de envio chamam a MESMA `deriveTemplateContract`.
 *
 * Nenhum campo aqui é "quantidade de parâmetros". O número é consequência dos slots;
 * se algum dia aparecer um campo editável com esse nome, o desenho vazou.
 *
 * ─── Criar/editar/apagar: o modelo pertence à CONTA (#3635) ─────────────────
 *
 * Até aqui quem usa o canal oficial DIRETO saía do CRM, criava no Gerenciador do
 * WhatsApp, esperava a aprovação e voltava para "Sincronizar" — enquanto o canal
 * de parceiro já fazia tudo pela tela. As três ações entram nesta rota pelo
 * mesmo motivo que o sync já está nela: terminam no espelho, e separá-las
 * obrigaria a tela a saber que criar também sincroniza.
 *
 * A plataforma é chamada pelo MESMO cliente do parceiro
 * (`lib/channels/templates-graph.ts`), parametrizado por host/token; o que muda
 * aqui é a credencial, que é a da SESSÃO oficial (`resolveMetaCreds`) e a WABA
 * dela (`metaWabaDoNumero`). Aprovação e sincronização não mudaram.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  acaoApagarSchema,
  acaoEditarSchema,
  executarGestao,
  linhasDoModeloNaConexao,
  type EscopoDaGestao,
} from "@/lib/channels/gestao-de-modelos";
import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { metaSessionForOrg } from "@/lib/channels/meta/session";
import { metaCloudTemplateOps } from "@/lib/channels/meta/templates";
import { normalizeRejectedReason } from "@/lib/channels/meta/webhook";
import { deriveTemplateContract, describeAddress } from "@/lib/channels/meta/template-contract";
import { slotKey } from "@/lib/channels/meta/build-components";
import { syncTemplates } from "@/lib/channels/meta/template-sync";
import { mesclarValoresSalvos } from "@/lib/channels/meta/valores-salvos";
import { erroDePermissaoDeGestao } from "@/lib/channels/templates-graph";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Um template pronto para a tela: o que a Meta diz + o contrato derivado. */
export interface TemplateView {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  slots: Array<{
    key: string;
    expects: string;
    onde: string;
    /**
     * A chave de `template_values` para ESTE slot, montada por `slotKey` — a
     * mesma função que o montador do payload de envio usa.
     *
     * A `key` sozinha não endereça: um carrossel de dois cards tem dois slots
     * com a mesma `key`, e um cabeçalho de mídia colide com o `{{1}}` do corpo.
     * A tela teria de remontar o prefixo a partir de `onde`, que é rótulo
     * humano ("cabeçalho", "botão 1 (url)") e não sobrevive a isso. Montar a
     * chave de dois jeitos é o mismatch voltando pela porta dos fundos.
     */
    valueKey: string;
  }>;
  /**
   * Texto de cada componente que carrega parâmetro, INTEIRO e uma vez só.
   * Antes a tela mostrava o corpo repetido a cada slot, cada linha destacando o
   * seu e deixando o vizinho cru — correto e ilegível. A UI marca os `{{n}}`.
   */
  previews: Array<{ onde: string; text: string }>;
  /** A definição crua — de onde sai o texto que vai no corpo do envio. */
  components: unknown[];
  /**
   * Links de mídia que o operador salvou para este modelo, na chave de
   * `template_values`. O painel da janela fechada pré-preenche com eles.
   */
  savedValues: Record<string, string>;
  /**
   * O modelo é DA CONTA OFICIAL desta conexão — o único que esta tela pode
   * editar ou apagar. O espelho é da organização inteira: o modelo do parceiro
   * aparece na lista, mas editar/apagar aqui miraria a WABA oficial pelo nome.
   */
  daConexao: boolean;
}

/** Textos com placeholder, achatados (inclui os de dentro de card de carrossel). */
function textPreviews(components: unknown): Array<{ onde: string; text: string }> {
  const out: Array<{ onde: string; text: string }> = [];
  const visita = (lista: unknown, prefixo: string) => {
    if (!Array.isArray(lista)) return;
    for (const c of lista as Array<Record<string, unknown>>) {
      const tipo = String(c.type ?? "").toUpperCase();
      if (Array.isArray(c.cards)) {
        (c.cards as Array<Record<string, unknown>>).forEach((card, i) =>
          visita(card.components, `card ${i + 1} › `),
        );
        continue;
      }
      const texto = typeof c.text === "string" ? c.text : "";
      if (!texto.includes("{{")) continue;
      out.push({ onde: `${prefixo}${tipo === "HEADER" ? "cabeçalho" : "corpo"}`, text: texto });
    }
  };
  visita(components, "");
  return out;
}

type OrgGate =
  /** `userId` só é usado no audit das ações de escrita (#3635). */
  | { autorizado: true; orgId: string; userId: string; idioma: Idioma }
  | { autorizado: false; resposta: NextResponse };

/**
 * Quem pode ──────────────────────────────────────────────────────────────────
 *
 * Ler (`agent`): esta lista é a que alimenta o seletor da janela fechada no
 * inbox, e quem atende é quem precisa dela — a rota do canal intermediado já
 * funciona assim (`partner/templates`: "Ler (agent): é a lista que o seletor do
 * inbox usa"). Aqui ela pedia `admin` em TODOS os métodos, e o `agent` levava
 * `403 forbidden_role`: o `useQuery` do painel ficava sem `data`, a lista
 * filtrada por `APPROVED` virava `[]` e o seletor aparecia VAZIO — a #2328.
 *
 * Escrever (`admin`): sincronizar modelos e gravar link de mídia mexem na
 * configuração do canal da empresa (e por isso seguem bloqueados em sessão de
 * suporte). Mesmo recorte do canal intermediado.
 */
async function orgOrFail(requestId: string, papel: "agent" | "admin"): Promise<OrgGate> {
  const authz = await requireRole(papel, { requestId, resource: "channels_templates" });
  if (!authz.ok) return { autorizado: false, resposta: authz.response };
  return { autorizado: true, orgId: authz.org.orgId, userId: authz.user.id, idioma: authz.user.idioma };
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const r = await orgOrFail(requestId, "agent");
  if (!r.autorizado) return r.resposta;

  const sessao = await metaSessionForOrg(r.orgId);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_templates")
    .select(
      "name, language, status, category, rejected_reason, quality_score, parameter_format, contract_hash, components, synced_at, saved_values, channel_session_id, waba_id",
    )
    .eq("organization_id", r.orgId)
    .order("status")
    .order("name");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const templates: TemplateView[] = (data ?? []).map((row) => {
    const contrato = deriveTemplateContract({
      name: row.name,
      language: row.language,
      parameter_format: row.parameter_format,
      components: row.components as never,
    });
    return {
      name: row.name,
      language: row.language,
      status: row.status,
      category: row.category,
      // Normaliza na LEITURA também: o "NONE" da Meta pode ter sido gravado por
      // uma versão anterior ao conserto, e um clone atualizado ainda o carrega.
      rejectedReason: normalizeRejectedReason(row.rejected_reason),
      qualityScore: row.quality_score,
      parameterFormat: contrato.parameterFormat,
      contractHash: row.contract_hash,
      syncedAt: row.synced_at,
      slots: contrato.slots.map((s) => ({
        key: s.key,
        expects: s.expects,
        onde: describeAddress(s.address),
        valueKey: slotKey(s.address, s.key),
      })),
      previews: textPreviews(row.components),
      // A DEFINIÇÃO crua, como a rota do canal intermediado já devolve.
      //
      // `previews` não serve para isto: ele filtra por `{{` (só interessa
      // mostrar o que tem variável), então um modelo SEM variável sai com a
      // lista vazia — e são exatamente esses que o operador consegue disparar
      // sem preencher nada. O seletor da janela fechada monta o corpo da
      // mensagem a partir daqui; sem o campo, ele caía no NOME TÉCNICO do
      // modelo e era isso que o cliente recebia.
      components: (row.components as unknown[]) ?? [],
      // Filtrado pelo contrato de HOJE: link salvo para um cabeçalho que deixou
      // de ser mídia não pode pré-preencher nada.
      savedValues: (() => {
        const r = mesclarValoresSalvos(contrato, (row.saved_values ?? {}) as Record<string, unknown>, {});
        return r.ok ? r.valores : {};
      })(),
      // A mesma régua de `linhasDoModeloNaConexao`: linha oficial = sem conexão
      // e com a WABA desta sessão.
      daConexao: !!sessao?.wabaId && row.channel_session_id === null && row.waba_id === sessao.wabaId,
    };
  });

  return ok({
    // `null` aqui não é "erro": é o estado de quem não tem canal oficial ATIVO —
    // nunca conectou, ou conectou e excluiu —, e a tela precisa distingui-lo de
    // "conectado, porém sem template".
    waba: sessao?.wabaId ?? null,
    templates,
  });
}

/**
 * O corpo do POST. Sem `acao` é SINCRONIZAR — é o contrato que a tela já usava
 * (`{}`) desde antes desta fatia, e mudá-lo quebraria o botão "Sincronizar" de
 * toda instalação. `components` viaja cru até a plataforma: ela é quem valida o
 * formato e devolve o motivo; aqui só se garante a forma e o vocabulário fechado
 * da categoria.
 */
const corpoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("sincronizar") }),
  z.object({
    acao: z.literal("criar"),
    name: z.string().trim().min(1).max(512),
    language: z.string().trim().min(2).max(15),
    category: z.enum(["AUTHENTICATION", "MARKETING", "UTILITY"]).default("UTILITY"),
    components: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
  }),
  acaoEditarSchema,
  acaoApagarSchema,
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await orgOrFail(requestId, "admin");
  if (!r.autorizado) return r.resposta;
  const t = (texto: string) => traduzir(texto, r.idioma);

  const sessao = await metaSessionForOrg(r.orgId);
  if (!sessao?.wabaId) {
    return fail("invalid_request", "no_meta_channel", 400, { requestId });
  }

  // A credencial vem da SESSÃO que o operador conectou na tela, com o ambiente só
  // como RESERVA — a mesma porta que `send`, `checkHealth` e `fetchInboundMedia` já
  // usam. Antes disto este 400 olhava só `META_SYSTEM_USER_TOKEN`: numa instalação que
  // conectou o número pela TELA, "Sincronizar modelos" respondia
  // `400 missing_meta_token` a quem tinha credencial salva e visível na própria tela,
  // e o 2º número oficial da instalação nunca sincronizava um modelo.
  //
  // A ORDEM dos desfechos NÃO muda: sem canal oficial a resposta continua
  // `no_meta_channel`; com canal e sem credencial nenhuma (nem na sessão, nem no
  // ambiente) continua `missing_meta_token` 400 — o que muda é só de ONDE a
  // credencial sai quando existe.
  const creds = await resolveMetaCreds(createAdminClient(), {
    organizationId: r.orgId,
    phoneNumberId: sessao.phoneNumberId ?? "",
  });
  if (!creds) return fail("invalid_request", "missing_meta_token", 400, { requestId });

  // O corpo é validado ANTES de falar com a plataforma: um `acao` inventado não
  // pode virar "sincronizar por omissão" nem tocar a conta.
  const cru = (await req.json().catch(() => null)) as unknown;
  const parsed = corpoSchema.safeParse(
    // Sem corpo é SINCRONIZAR: era o contrato da rota antes da #3635 (o POST
    // nem lia o corpo), e integração que chama sem corpo não pode virar 422.
    cru === null
      ? { acao: "sincronizar" }
      : typeof cru === "object" && !Array.isArray(cru)
        ? { acao: "sincronizar", ...cru }
        : {},
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Faltam nome, idioma ou conteúdo."), 422, { requestId });
  }
  const corpo = parsed.data;

  try {
    // A gestão (editar/apagar) precisa do `sessionRef` desta conexão: no canal
    // oficial ele é o `phone_number_id`, e é por ele que a credencial e a WABA
    // são resolvidas. Sem número gravado não há conta a alcançar.
    if (corpo.acao !== "sincronizar" && !sessao.phoneNumberId) {
      return fail("failed_precondition", t("A conexão oficial não tem número gravado."), 409, {
        requestId,
      });
    }

    if (corpo.acao === "editar" || corpo.acao === "apagar") {
      const escopo: EscopoDaGestao = {
        orgId: r.orgId,
        sessionId: sessao.id,
        sessionRef: sessao.phoneNumberId ?? "",
        wabaOficial: sessao.wabaId,
      };
      // A plataforma acha o modelo pelo NOME dentro da WABA oficial. Um homônimo
      // de outra conexão (o parceiro) listado no espelho não pode virar edição —
      // ou apagamento, que é irreversível — na conta oficial.
      if ((await linhasDoModeloNaConexao(createAdminClient(), escopo, corpo)).length === 0) {
        return fail("not_found", t("Este modelo não é da conta oficial desta conexão."), 404, { requestId });
      }
      const gestao = await executarGestao(metaCloudTemplateOps, createAdminClient(), escopo, corpo);
      if (!gestao.ok) {
        // Apagar um modelo em uso faria o passo do follow-up pular e o agente
        // errar o envio, em silêncio. A tela mostra ONDE e pede a confirmação.
        return fail("template_in_use", t("Este modelo está em uso. Confirme para apagar assim mesmo."), 409, {
          requestId,
          details: {
            usos: gestao.usos.map((u) => `${u.tipo === "fluxo" ? t("Follow-up") : t("Agente")} «${u.nome}»`),
          },
        });
      }
      await audit({
        action: gestao.acao === "editar" ? "template.updated" : "template.deleted",
        actorUserId: r.userId,
        organizationId: r.orgId,
        resourceType: "channel_session",
        resourceId: sessao.id,
        requestId,
        metadata: { name: corpo.name, language: corpo.language },
      });
    }

    if (corpo.acao === "criar") {
      // A plataforma valida o formato do nome e devolve o motivo com código. Não
      // duplicamos a regra: regra copiada envelhece separado da fonte.
      await metaCloudTemplateOps.create({
        organizationId: r.orgId,
        sessionRef: sessao.phoneNumberId ?? "",
        draft: {
          name: corpo.name,
          language: corpo.language,
          category: corpo.category,
          components: corpo.components,
        },
      });
      await audit({
        action: "template.created",
        actorUserId: r.userId,
        organizationId: r.orgId,
        resourceType: "channel_session",
        resourceId: sessao.id,
        requestId,
        metadata: { name: corpo.name, language: corpo.language },
      });
    }

    // Sincroniza sempre — inclusive depois de criar: a definição nasce em
    // revisão, e o operador precisa VER que ela existe e está pendente. Sem
    // isso ele criaria a mesma de novo, achando que não salvou. Depois de
    // editar, é isso que traz o estado de volta para PENDING; depois de apagar,
    // a linha já saiu do espelho (a plataforma não a devolve).
    const counts = await syncTemplates({
      organizationId: r.orgId,
      wabaId: sessao.wabaId,
      token: creds.token,
      graphVersion: creds.graphVersion,
    });
    return ok(counts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "sync_failed";
    // Permissão de gestão de modelo (`whatsapp_business_management`) é problema
    // ACIONÁVEL e não pode sair como "não deu": a conta precisa do escopo, e
    // quem lê isso tem de saber a quem pedir.
    if (erroDePermissaoDeGestao(err)) {
      return fail(
        "forbidden",
        t(
          "A conta do WhatsApp não permite gerenciar modelos por esta conexão. Falta a permissão whatsapp_business_management no app da Meta.",
        ),
        403,
        { requestId },
      );
    }
    // Conexão sem conta/token não é falha da plataforma, é PRECONDIÇÃO da nossa
    // configuração: 409 com o motivo, e não 502 pedindo para tentar de novo.
    if (msg.startsWith("meta_modelo_sem_waba")) {
      return fail(
        "failed_precondition",
        t("Esta conexão oficial não tem conta do WhatsApp (WABA) gravada. Reconecte o número."),
        409,
        { requestId },
      );
    }
    if (msg.startsWith("meta_modelo_sem_credencial")) {
      return fail(
        "failed_precondition",
        t("Esta conexão oficial não tem token para gerenciar modelos. Reconecte o número."),
        409,
        { requestId },
      );
    }
    // A falha da Graph API vira mensagem legível na tela, não 500 mudo — o
    // operador precisa saber se é token vencido, WABA errada ou rede.
    return fail("internal_error", msg, 502, {
      requestId,
    });
  }
}

/**
 * Salva o link da mídia de um modelo, para o painel da janela fechada
 * pré-preencher no próximo disparo. Valor vazio esquece o link.
 *
 * Só slot de mídia e só `https://` — ver `lib/channels/meta/valores-salvos.ts`.
 * Mesmo papel do sync (`admin`), e bloqueado em sessão de suporte, porque
 * escreve na configuração do canal.
 *
 * Grava em TODAS as linhas do mesmo nome e idioma da organização: a tela lista
 * o modelo uma vez só, e dois números oficiais com a mesma definição
 * divergiriam em silêncio se só um recebesse o link.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await orgOrFail(requestId, "admin");
  if (!r.autorizado) return r.resposta;

  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    language?: unknown;
    values?: unknown;
  } | null;
  const valores = body?.values;
  if (
    typeof body?.name !== "string" ||
    typeof body?.language !== "string" ||
    !valores ||
    typeof valores !== "object" ||
    Array.isArray(valores) ||
    !Object.values(valores).every((v) => typeof v === "string")
  ) {
    return fail("validation_failed", "esperado { name, language, values: { chave: link } }", 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const { data: linhas, error } = await admin
    .from("meta_templates")
    .select("id, name, language, parameter_format, components, saved_values")
    .eq("organization_id", r.orgId)
    .eq("name", body.name)
    .eq("language", body.language);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!linhas || linhas.length === 0) {
    return fail("not_found", "modelo não encontrado", 404, { requestId });
  }

  // Confere TUDO antes de escrever qualquer linha: recusar a segunda depois de
  // gravar a primeira deixaria os números divergindo.
  const planos: Array<{ id: string; valores: Record<string, string> }> = [];
  for (const linha of linhas) {
    const contrato = deriveTemplateContract({
      name: linha.name,
      language: linha.language,
      parameter_format: linha.parameter_format,
      components: linha.components as never,
    });
    const m = mesclarValoresSalvos(
      contrato,
      (linha.saved_values ?? {}) as Record<string, unknown>,
      valores as Record<string, string>,
    );
    if (!m.ok) {
      return fail("validation_failed", m.motivo, 422, { requestId, details: { chave: m.chave } });
    }
    planos.push({ id: linha.id, valores: m.valores });
  }

  for (const plano of planos) {
    const { error: erro } = await admin
      .from("meta_templates")
      .update({ saved_values: plano.valores })
      .eq("organization_id", r.orgId)
      .eq("id", plano.id);
    if (erro) return fail("internal_error", erro.message, 500, { requestId });
  }

  return ok({ savedValues: planos[0]!.valores });
}
