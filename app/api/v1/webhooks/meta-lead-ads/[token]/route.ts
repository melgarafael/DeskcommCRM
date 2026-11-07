/**
 * GET|POST /api/v1/webhooks/meta-lead-ads/[token] — o lead do formulário
 * instantâneo da Meta entrando no funil (issue #3768, fatias 1 e 1-bis).
 *
 * ═══ O QUE ESTA ROTA É, E O QUE ELA NÃO É ═══════════════════════════════════
 *
 * É a PORTA: resolve a fonte pelo `path_token` e pelo `page_id`, confere a
 * assinatura da plataforma em FALHA FECHADA, completa as respostas quando o aviso
 * vem sem elas (busca autenticada, opção da fonte), e entrega o corpo ao parser
 * puro (`lib/leads/lead-ads/payload.ts`), que diz quais leads entraram. A escrita
 * fica em `lib/leads/lead-ads/entrada.ts`.
 *
 * NÃO é a conexão: tela de OAuth, escolha de página, listagem de formulários e
 * sincronização de campanhas continuam FORA desta fatia (declarado no fio da
 * issue). O que a fatia 1-bis acrescentou está abaixo, ponto por ponto.
 *
 * ═══ 1. O `GET` DE VERIFICAÇÃO (`hub.challenge`) ════════════════════════════
 *
 * A plataforma confere a URL cadastrada como destino ANTES de entregar nada, e a
 * conferência é um `GET` com `hub.mode=subscribe`, `hub.verify_token` e
 * `hub.challenge` — e o endpoint tem de devolver o desafio em TEXTO PURO. A rota
 * do canal oficial (`app/api/v1/webhooks/meta/[token]`) serve esse mesmo
 * handshake, mas ela resolve a sessão do canal pelo token do path e responde 404
 * para o `path_token` de uma fonte de captação: a URL nova não passaria por lá.
 * Por isso o `GET` mora aqui também, com o verificador de lá (`verificationChallenge`).
 *
 * ⚠️ O `GET` NÃO resolve a fonte. O desafio prova posse do verify token, que é da
 * INSTALAÇÃO (`platform_meta_app`, via `appDaMeta()`), e não de uma fonte; exigir
 * que o token do path resolvesse uma fonte faria a conferência falhar para a URL
 * de uma fonte que ainda não foi salva — que é o estado normal de quem está
 * configurando. Quem responde 404 é o `POST`, que escreve.
 *
 * ═══ 2. DE QUEM É O LEAD: `page_id`, E NÃO O TOKEN DO PATH ══════════════════
 *
 * A plataforma tem UMA URL de destino para o objeto `page`, e ela vale para todas
 * as páginas do App. Um token por fonte, sozinho, deixaria todas as páginas
 * entregando na fonte de quem cadastrou a URL. O dono do lead é a coluna
 * `webhook_sources.meta_page_id` (migration 9081), casada com o `entry[].id` do
 * aviso:
 *
 *   1. fonte que declara aquela página → é a dona, MESMO que o token da URL seja
 *      de outra fonte (e de outra organização — é o caso de uma instalação com
 *      duas empresas e um App só);
 *   2. página que nenhuma fonte declara → a fonte do token é a dona, e só quando
 *      ela não declara página nenhuma (configuração de uma página só, a de quem
 *      nunca preencheu a coluna). Fonte que declara OUTRA página não herda lead
 *      de página alheia: herdar seria escrever na empresa errada;
 *   3. nada disso → o lead é IGNORADO com motivo nomeado, e a resposta é 200 (ver
 *      adiante). `pagina_sem_dono` é configuração faltando; `pagina_desligada` é
 *      a fonte dona com o interruptor desligado.
 *
 * `uniq_webhook_sources_meta_page` (índice único parcial) é o que impede o caso
 * ambíguo: duas fontes com a mesma página não existem no banco.
 *
 * ═══ 3. O SEGREDO DA ASSINATURA É O DO APP, NÃO UMA CÓPIA POR FONTE ═════════
 *
 * Quem assina a entrega é o App da Meta, e o App Secret é da INSTALAÇÃO: ele mora
 * em `platform_meta_app` e é lido por `appDaMeta()` (banco primeiro, `.env` como
 * piso), que é a mesma leitura do webhook do canal oficial. Uma cópia por fonte
 * seria uma segunda verdade sobre o mesmo segredo: trocar o segredo no painel da
 * plataforma deixaria a fonte com o valor velho, e o sintoma seria `401` em toda
 * entrega sem ninguém ligar uma coisa à outra. Segredo que não existe (nada no
 * banco e nada no `.env`) RECUSA com `segredo_ausente` — falha fechada.
 *
 * ═══ 4. A JANELA NÃO RECUSA MAIS — ELA CARIMBA ══════════════════════════════
 *
 * A plataforma reentrega o que não recebe 2xx, em backoff, por HORAS. Uma
 * instalação fora do ar por dez minutos acordava com uma fila de reentregas
 * assinadas; a janela de cinco minutos recusava todas com 401, e o lead se perdia
 * de vez. A repetição que a janela tentava conter já é contida pela idempotência
 * de `leadgen_id` (índice único `uniq_crm_leads_org_source_external`). Então a
 * entrega antiga entra, e a idade vai no RASTRO: log `recebido_com_atraso` e a
 * chave `recebido_com_atraso_segundos` no `utm` da linha de captação. O 401 fica
 * reservado ao que não tem conserto: assinatura ausente, inválida, ou segredo que
 * não decifra. Ver `lib/leads/lead-ads/assinatura.ts`.
 *
 * ═══ 5. AS RESPOSTAS: BUSCA AUTENTICADA, DESLIGADA POR PADRÃO ═══════════════
 *
 * O aviso real não traz `field_data`. Sem ele, nenhum lead real entra — e é por
 * isso que a busca na Graph API (`lib/leads/lead-ads/respostas-na-meta.ts`) faz
 * parte desta entrega. Ela é opção da FONTE (`meta_lead_retrieval`), DESLIGADA por
 * padrão e ligada por quem administra, com o critério da doc 235: no núcleo,
 * desligada por padrão, e só aparece quando funciona de ponta a ponta.
 *
 * Desligada, um aviso sem respostas é IGNORADO com motivo `sem_field_data`.
 * Ligada e sem token, `sem_token_da_pagina`; ligada e a plataforma não respondeu,
 * `sem_respostas_na_meta` com o motivo da falha no `detalhe`. Em NENHUM desses
 * casos o lead entra com dado inventado.
 *
 * ═══ POR QUE 200 EM TANTA COISA ═════════════════════════════════════════════
 *
 * A plataforma reentrega o que não recebe 2xx, em backoff. 4xx/5xx, portanto, é
 * uma AFIRMAÇÃO: "este corpo ainda pode dar certo, tente de novo". Ela é verdadeira
 * para falha nossa (500) e para JSON quebrado (400), e é FALSA para tudo o que esta
 * rota recusa de propósito — evento que não é leadgen, lead sem as respostas,
 * página sem dono, reentrega do mesmo `leadgen_id`. Recusar essas com erro faria a
 * plataforma martelar para sempre um corpo que nunca vai melhorar, e é o mesmo
 * raciocínio escrito no cabeçalho de `webhooks/meta/[token]`.
 */
import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { appDaMeta } from "@/lib/channels/meta/app";
import { verificationChallenge } from "@/lib/channels/meta/webhook";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CABECALHO_DA_ASSINATURA_DA_META, assinaturaDaMetaConfere, idadeDoSinal } from "@/lib/leads/lead-ads/assinatura";
import { entradaDoLeadDoFormulario, type FonteDoLeadAds } from "@/lib/leads/lead-ads/entrada";
import {
  leadComRespostas,
  lerLeadsDoFormularioMeta,
  type LeadDoFormulario,
  type MotivoDoDescarte,
} from "@/lib/leads/lead-ads/payload";
import { buscarRespostasDoLead, type ResultadoDaBusca } from "@/lib/leads/lead-ads/respostas-na-meta";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

/**
 * Teto do corpo. O formulário da Meta é pequeno (três a vinte respostas), então
 * 1 MB é folga larga — e é o mesmo teto da cobrança, para não existirem dois
 * números de "aviso grande demais" no produto.
 */
const LIMITE_DO_CORPO = 1_048_576;

/** O que a fonte precisa ter para a porta funcionar, venha do path ou da página. */
interface FonteDaPorta {
  id: string;
  nome: string;
  organizationId: string;
  funilId: string;
  etapaId: string;
  /** A página que ela representa; `null` = não reivindica nenhuma. */
  pageId: string | null;
  /** Opção da fonte (migration 9081): buscar as respostas, DESLIGADA por padrão. */
  buscaLigada: boolean;
  /** Cifrado; decifrado uma vez por entrega, nunca devolvido. */
  tokenCifrado: string | null;
  ativa: boolean;
}

const COLUNAS_DA_FONTE =
  "id, name, organization_id, default_pipeline_id, default_stage_id, is_active, " +
  "meta_page_id, meta_lead_retrieval, meta_page_token_encrypted";

function fonteDaPorta(linha: Record<string, unknown>): FonteDaPorta {
  return {
    id: linha.id as string,
    nome: (linha.name as string | null) ?? "Formulário da Meta",
    organizationId: linha.organization_id as string,
    funilId: linha.default_pipeline_id as string,
    etapaId: linha.default_stage_id as string,
    pageId: (linha.meta_page_id as string | null) ?? null,
    buscaLigada: linha.meta_lead_retrieval === true,
    tokenCifrado: (linha.meta_page_token_encrypted as string | null) ?? null,
    ativa: linha.is_active === true,
  };
}

function comoFonteDoLead(fonte: FonteDaPorta): FonteDoLeadAds {
  return {
    id: fonte.id,
    organizationId: fonte.organizationId,
    nome: fonte.nome,
    funilId: fonte.funilId,
    etapaId: fonte.etapaId,
  };
}

/**
 * Por que um lead foi IGNORADO — o vocabulário da porta, mais largo que o do
 * parser: é aqui que mora a decisão que depende da configuração da fonte.
 */
type MotivoDoIgnorado =
  | MotivoDoDescarte
  /** O aviso não trouxe as respostas e a busca está desligada nesta fonte. */
  | "sem_field_data"
  /** A busca está ligada e não devolveu respostas: ver o `detalhe`. */
  | "sem_respostas_na_meta"
  /** Nenhuma fonte reivindica a página do aviso. */
  | "pagina_sem_dono"
  /** A fonte dona da página está com o interruptor desligado. */
  | "pagina_desligada";

interface LeadIgnorado {
  leadgen_id: string | null;
  motivo: MotivoDoIgnorado;
  /** Diagnóstico curto e sem PII. Só entra quando existe, para o corpo não mentir. */
  detalhe?: string;
}

/**
 * `GET` — o handshake de verificação da URL.
 *
 * Responde o desafio em TEXTO PURO quando o `hub.verify_token` confere, e 403
 * quando não confere (ou quando a instalação ainda não configurou o token). Ver o
 * cabeçalho: este `GET` não resolve a fonte de propósito.
 */
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  // `ctx.params` é lido mesmo sem uso: em App Router o parâmetro do path compõe a
  // rota, e ignorá-lo deixaria um `await` implícito para quem ler depois.
  await ctx.params;
  const { verifyToken } = await appDaMeta();
  const challenge = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });

  // Texto puro, sem o wrapper `{data:…}` da nossa API: a plataforma compara o
  // corpo com o desafio que enviou, e um envelope JSON reprova a URL.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const requestId = randomUUID();
  const { token } = await params;
  const admin = createAdminClient();

  // A fonte do path é o ENDEREÇO, não o dono do lead (ver o cabeçalho, §2). Ela
  // resolve o tenant quando não há página, e é o que responde 404 para URL
  // desconhecida — quem chama é público, e um `organization_id` no corpo seria
  // escrita na empresa que o atacante escolhesse.
  const { data: fonteDoToken, error: erroDaFonte } = await admin
    .from("webhook_sources")
    .select(COLUNAS_DA_FONTE)
    .eq("path_token", token)
    .maybeSingle();
  if (erroDaFonte) {
    logger.error("[lead-ads] fonte do webhook não pôde ser lida", {
      request_id: requestId,
      error_code: erroDaFonte.code,
    });
    return fail("internal_error", "Não foi possível ler a fonte.", 500, { requestId });
  }
  if (!fonteDoToken || (fonteDoToken as unknown as Record<string, unknown>).is_active !== true) {
    // 404 para token desconhecido E para fonte desligada, com a mesma frase: a
    // diferença entre "não existe" e "existe e está desligada" é informação de
    // quem opera, e não de quem chama.
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }
  const fonteDaUrl = fonteDaPorta(fonteDoToken as unknown as Record<string, unknown>);

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }
  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  // ─── A PORTA: assinatura ──────────────────────────────────────────────────
  //
  // A assinatura vem PRIMEIRO e sobre o corpo CRU — antes de qualquer parse,
  // porque parsear corpo não confiável para depois recusá-lo é trabalho de graça.
  // O segredo é o do APP (ver o cabeçalho, §3): banco primeiro, `.env` como piso.
  const { appSecret } = await appDaMeta();
  const recusaDaAssinatura = assinaturaDaMetaConfere(
    corpo,
    req.headers.get(CABECALHO_DA_ASSINATURA_DA_META),
    appSecret ?? null,
  );
  if (recusaDaAssinatura !== null) {
    // Rastro com o MOTIVO e sem o corpo: o corpo é de quem não se autenticou, e
    // ele pode carregar PII de terceiro. Sem org também — não há tenant provado
    // do outro lado desta linha.
    logger.warn("[lead-ads] entrega recusada na assinatura", {
      request_id: requestId,
      webhook_source_id: fonteDaUrl.id,
      motivo: recusaDaAssinatura,
    });
    return fail("unauthorized", recusaDaAssinatura, 401, { requestId });
  }

  const leitura = lerLeadsDoFormularioMeta(corpo);
  if (!leitura.ok) {
    // 400 e não 200: JSON fora do contrato não é "evento que não nos interessa",
    // é o fio ter mudado — e o 200 generoso desta rota existe para o segundo
    // caso, não para o primeiro.
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  // ─── De quem é cada lead: a página manda (§2) ─────────────────────────────
  const donasPorPagina = await fontesDasPaginas(
    admin,
    leitura.leads.map((l) => l.pageId),
    requestId,
  );
  if (donasPorPagina === null) {
    return fail("internal_error", "Não foi possível ler a fonte da página.", 500, { requestId });
  }

  const agora = new Date();
  const ignorados: LeadIgnorado[] = leitura.descartados.map((d) => ({
    leadgen_id: d.leadgenId,
    motivo: d.motivo,
  }));

  /** Token decifrado por fonte, uma vez por entrega (a decifra é uma RPC). */
  const tokensDecifrados = new Map<string, string | null>();

  const aEntrar: Array<{ lead: LeadDoFormulario; fonte: FonteDaPorta; atrasoSegundos: number | null }> = [];

  for (const lead of leitura.leads) {
    const fonte = donaDoLead(lead, fonteDaUrl, donasPorPagina);
    if (fonte === null) {
      ignorados.push({ leadgen_id: lead.leadgenId, motivo: "pagina_sem_dono" });
      continue;
    }
    if (!fonte.ativa) {
      // A página tem dona e a dona está desligada: nada é escrito, e o motivo é
      // outro — quem desligou a fonte precisa ver isso na resposta.
      ignorados.push({ leadgen_id: lead.leadgenId, motivo: "pagina_desligada" });
      continue;
    }

    let completo = lead;
    if (completo.respostas.length === 0) {
      const busca = await completarRespostas(admin, fonte, lead, tokensDecifrados);
      if (!busca.ok) {
        // O lead NÃO entra com dado inventado. O motivo é nomeado, e o `detalhe`
        // só existe quando há o que dizer (status HTTP, sem token, tempo).
        ignorados.push(
          busca.motivo === "busca_desligada"
            ? { leadgen_id: lead.leadgenId, motivo: "sem_field_data" }
            : {
                leadgen_id: lead.leadgenId,
                motivo: "sem_respostas_na_meta",
                ...(busca.detalhe ? { detalhe: `${busca.motivo}:${busca.detalhe}` } : { detalhe: busca.motivo }),
              },
        );
        logger.warn("[lead-ads] aviso sem as respostas do formulário", {
          request_id: requestId,
          webhook_source_id: fonte.id,
          leadgen_id: lead.leadgenId,
          motivo: busca.motivo,
          detalhe: busca.detalhe ?? null,
        });
        continue;
      }
      completo = leadComRespostas(lead, busca.respostas);
    }

    const idade = idadeDoSinal(lead.entradaEm, agora);
    if (idade.atrasada) {
      logger.info("[lead-ads] entrega recebida com atraso — entra e fica marcada", {
        request_id: requestId,
        webhook_source_id: fonte.id,
        leadgen_id: lead.leadgenId,
        idade_segundos: idade.segundos,
      });
    }
    // Só a entrega ATRASADA carrega o carimbo: o nome do campo é "recebido com
    // atraso de N segundos", e gravar `0` numa entrega no prazo faria todo lead
    // normal parecer atrasado para quem lê o `utm` depois.
    aEntrar.push({ lead: completo, fonte, atrasoSegundos: idade.atrasada ? idade.segundos : null });
  }

  const leads: Array<{
    leadgen_id: string;
    desfecho: string;
    lead_id: string | null;
    contato_id: string | null;
  }> = [];
  for (const entrada of aEntrar) {
    try {
      const resultado = await entradaDoLeadDoFormulario(
        admin,
        comoFonteDoLead(entrada.fonte),
        entrada.lead,
        requestId,
        { atrasoSegundos: entrada.atrasoSegundos },
      );
      leads.push({
        leadgen_id: resultado.leadgenId,
        desfecho: resultado.desfecho,
        lead_id: resultado.leadId,
        contato_id: resultado.contatoId,
      });
    } catch (erro) {
      // A recusa já está em `webhook_lead_captures` (com o motivo de gente) e no
      // log; o status é o do erro para que quem depura a fonte veja qual é. 200
      // aqui esconderia um funil apagado atrás de "recebido".
      if (erro instanceof ApiError) {
        return fail(erro.code, erro.message ?? "recusado", erro.status, { requestId });
      }
      throw erro;
    }
  }

  for (const ignorado of ignorados) {
    // O descarte é NOMEADO e fica registrado: um lead que a plataforma avisou e
    // não entrou é a informação que quem opera a campanha precisa ter. Silêncio
    // aqui faria "não chegou nada" e "chegou sem as respostas" terem a mesma cara.
    logger.warn("[lead-ads] lead ignorado antes da escrita", {
      request_id: requestId,
      webhook_source_id: fonteDaUrl.id,
      leadgen_id: ignorado.leadgen_id,
      motivo: ignorado.motivo,
      detalhe: ignorado.detalhe ?? null,
    });
  }

  return ok(
    {
      recebido: true,
      leads,
      // Vazio na entrega boa: é a lista que responde "a plataforma avisou e não
      // entrou" sem obrigar ninguém a abrir o log.
      ignorados,
    },
    { requestId },
  );
}

/**
 * As fontes que reivindicam as páginas desta entrega, por `page_id`.
 *
 * Uma consulta só, e ela NÃO filtra `is_active`: a fonte desligada precisa ser
 * encontrada para o lead ser ignorado com o motivo certo (`pagina_desligada`) em
 * vez de cair no fallback da URL e entrar na organização errada.
 *
 * `null` = a leitura falhou (quem chama responde 500, para a plataforma
 * reentregar); mapa vazio = nenhuma página reivindicada.
 */
async function fontesDasPaginas(
  admin: ReturnType<typeof createAdminClient>,
  pageIds: Array<string | null>,
  requestId: string,
): Promise<Map<string, FonteDaPorta> | null> {
  const procuradas = [...new Set(pageIds.filter((p): p is string => Boolean(p)))];
  if (procuradas.length === 0) return new Map();

  const { data, error } = await admin
    .from("webhook_sources")
    .select(COLUNAS_DA_FONTE)
    .in("meta_page_id", procuradas);
  if (error) {
    logger.error("[lead-ads] fontes das páginas do aviso não puderam ser lidas", {
      request_id: requestId,
      error_code: error.code,
    });
    return null;
  }
  const mapa = new Map<string, FonteDaPorta>();
  for (const linha of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const fonte = fonteDaPorta(linha);
    if (fonte.pageId) mapa.set(fonte.pageId, fonte);
  }
  return mapa;
}

/**
 * A dona do lead — as três regras do cabeçalho (§2), nesta ordem.
 *
 * `null` = nenhuma fonte é dona, e o lead é ignorado com motivo nomeado. Devolver
 * a fonte da URL "no escuro" escreveria o lead de uma página alheia na
 * organização de quem cadastrou o endereço.
 */
function donaDoLead(
  lead: LeadDoFormulario,
  fonteDaUrl: FonteDaPorta,
  donasPorPagina: Map<string, FonteDaPorta>,
): FonteDaPorta | null {
  const dona = lead.pageId ? donasPorPagina.get(lead.pageId) : undefined;
  if (dona) return dona;
  // Regra 2: a fonte do token só herda quando não reivindica página nenhuma —
  // é a configuração de uma página só, a de quem nunca preencheu a coluna.
  if (fonteDaUrl.pageId === null) return fonteDaUrl;
  return null;
}

/**
 * Completa as respostas de um lead pela busca autenticada.
 *
 * Só é chamada quando o aviso chegou sem `field_data`, e a decisão de chamar é da
 * fonte (`meta_lead_retrieval`). O token é decifrado UMA vez por entrega mesmo
 * com vários leads da mesma página: a decifra é uma RPC, e um lote de dez leads
 * não deve pagar dez vezes.
 */
async function completarRespostas(
  admin: ReturnType<typeof createAdminClient>,
  fonte: FonteDaPorta,
  lead: LeadDoFormulario,
  cache: Map<string, string | null>,
): Promise<ResultadoDaBusca> {
  if (!fonte.buscaLigada) return { ok: false, motivo: "busca_desligada" };
  if (!fonte.tokenCifrado) return { ok: false, motivo: "sem_token_da_pagina" };

  let token = cache.get(fonte.id);
  if (token === undefined) {
    token = await decryptWebhookSecret(admin, fonte.tokenCifrado);
    cache.set(fonte.id, token);
  }
  // Token que não decifra é `token_indecifravel` — "não dá para ler" tem o mesmo
  // desfecho de "não tem": nada entra, e o motivo diz qual dos dois foi.
  if (!token) return { ok: false, motivo: "token_indecifravel" };

  return buscarRespostasDoLead({ leadgenId: lead.leadgenId, token });
}
