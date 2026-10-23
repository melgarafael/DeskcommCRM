import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { chaveDoCodigo, lerPlanilha, type ErroDaLinha } from "@/lib/catalogo/planilha";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  CAMPOS_BASICOS,
  CAMPOS_EXTRAS,
  campoRecusadoPelaMeta,
  juntarFotos,
  mapearProdutoDaMeta,
  type MetaGraphProduct,
} from "@/lib/catalogo/meta-graph";
import { ehFotoExterna } from "@/lib/catalogo/fotos-externas";
import { EVENTO_DE_FOTOS_EXTERNAS } from "@/lib/catalogo/fotos-externas.handler";

export const dynamic = "force-dynamic";

const LOTE = 200;
const MAX_PAGINAS_GRAPH = 15; // até ~3.750 produtos via Graph API por rodada

interface MetaGraphResponse {
  data?: MetaGraphProduct[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
  };
  error?: {
    message?: string;
    type?: string;
    code?: number;
  };
}

function semALinha<T extends { linha?: number }>({ linha: _linha, ...resto }: T): Omit<T, "linha"> {
  return resto;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();

  // Buscar configurações da organização
  const { data: orgData, error: orgError } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();

  if (orgError) {
    return fail("database_error", orgError.message, 500, { requestId });
  }

  const settings = (orgData?.settings as Record<string, unknown> | null) ?? {};
  const metaCatalog = (settings.meta_catalog as Record<string, unknown> | null) ?? {};

  // Resolver catalog_id
  let catalogId = (metaCatalog.catalog_id as string | undefined) ?? null;
  if (!catalogId) {
    const { data: sessionData } = await admin
      .from("channel_sessions")
      .select("meta_catalog_id")
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .not("meta_catalog_id", "is", null)
      .limit(1)
      .maybeSingle();

    if (sessionData?.meta_catalog_id) {
      catalogId = sessionData.meta_catalog_id;
    }
  }

  const feedUrl = (metaCatalog.feed_url as string | undefined) ?? null;

  // Produtos que serão importados/atualizados
  type ItemParaUpsert = {
    linha?: number;
    organization_id: string;
    codigo: string;
    nome: string;
    descricao?: string | null;
    preco_cents: number;
    preco_de_cents?: number | null;
    custo_cents?: number | null;
    marca?: string | null;
    categoria?: string | null;
    controla_estoque: boolean;
    quantidade: number;
    origem: string;
    imagem_url?: string | null;
    fotos?: string[];
    link_loja?: string | null;
    condicao?: string | null;
    gtin?: string | null;
    moeda?: string | null;
    video_url?: string | null;
    peso_gramas?: number | null;
  };

  const itensParaUpsert: ItemParaUpsert[] = [];
  const erros: ErroDaLinha[] = [];
  /** Campos extras que a Meta recusou neste catálogo — vão na resposta. */
  const camposRecusados: string[] = [];

  // MODO 1: FEED URL (CSV do Gerenciador de Comércio da Meta)
  if (feedUrl && feedUrl.trim().length > 0) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const resp = await fetch(feedUrl.trim(), {
        signal: controller.signal,
        headers: {
          "User-Agent": "DeskcommCRM-MetaCatalogSync/1.0",
          Accept: "text/csv, text/plain, */*",
        },
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        return fail("feed_fetch_failed", `Erro ao baixar Feed da Meta: HTTP ${resp.status}`, 422, {
          requestId,
        });
      }

      const csvTexto = await resp.text();
      const leitura = lerPlanilha(csvTexto);
      if ("erro" in leitura) {
        return fail("feed_parse_error", leitura.erro, 422, { requestId });
      }

      for (const p of leitura.produtos) {
        itensParaUpsert.push({
          linha: p.linha,
          organization_id: orgId,
          codigo: p.codigo,
          nome: p.nome,
          descricao: p.descricao ?? null,
          preco_cents: p.preco_cents,
          preco_de_cents: p.preco_de_cents ?? null,
          custo_cents: p.custo_cents ?? null,
          marca: p.marca ?? null,
          categoria: p.categoria ?? null,
          controla_estoque: p.controla_estoque,
          quantidade: p.quantidade,
          origem: "meta_catalog_feed",
          imagem_url: p.imagem_url ?? null,
          fotos: p.imagem_url ? [p.imagem_url] : [],
          link_loja: p.link_loja ?? null,
          condicao: p.condicao ?? null,
          gtin: p.gtin ?? null,
        });
      }

      erros.push(...leitura.erros);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail("feed_error", `Falha ao processar Feed URL: ${msg}`, 422, { requestId });
    }
  } else {
    // MODO 2: GRAPH API DA META
    if (!catalogId) {
      return fail(
        "catalog_not_configured",
        "Nenhum ID de Catálogo ou URL de Feed configurado. Configure nas opções acima.",
        422,
        { requestId },
      );
    }

    // Resolver Token da Meta
    let token: string | null = null;
    if (metaCatalog.access_token_encrypted) {
      token = await decryptWebhookSecret(admin, metaCatalog.access_token_encrypted as string);
    }
    if (!token && metaCatalog.access_token) {
      token = metaCatalog.access_token as string;
    }

    // Se ainda não tiver token, tentar pegar da sessão oficial
    if (!token) {
      const { data: officialSession } = await admin
        .from("channel_sessions")
        .select("meta_token_encrypted")
        .eq("organization_id", orgId)
        .eq("provider", "meta")
        .is("archived_at", null)
        .not("meta_token_encrypted", "is", null)
        .limit(1)
        .maybeSingle();

      if (officialSession?.meta_token_encrypted) {
        token = await decryptWebhookSecret(admin, officialSession.meta_token_encrypted);
      }
    }

    if (!token) {
      return fail(
        "token_missing",
        "Token de acesso da Meta não encontrado. Insira um token de acesso ou conecte a API Oficial.",
        422,
        { requestId },
      );
    }

    // Paginação da Graph API. Pede o máximo (fotos extras, vídeo, descrição
    // formatada, preço promocional…); campo que a Meta recusar sai da lista e
    // a página é pedida de novo — nunca derruba a importação inteira.
    let campos: string[] = [...CAMPOS_BASICOS, ...CAMPOS_EXTRAS];
    const urlDaPrimeiraPagina = () =>
      `https://graph.facebook.com/v21.0/${encodeURIComponent(catalogId)}/products?` +
      `fields=${campos.join(",")}&limit=250`;
    let proximaUrl: string | null = urlDaPrimeiraPagina();

    let paginasLidas = 0;

    try {
      while (proximaUrl && paginasLidas < MAX_PAGINAS_GRAPH) {
        paginasLidas++;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const resp = await fetch(proximaUrl, {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
          const errBody = (await resp.json().catch(() => null)) as MetaGraphResponse | null;
          const mensagemMeta = errBody?.error?.message || `HTTP ${resp.status} na Graph API`;
          const codigo = errBody?.error?.code;
          const recusado = codigo === 100 ? campoRecusadoPelaMeta(mensagemMeta, CAMPOS_EXTRAS) : null;
          if (recusado && paginasLidas === 1 && campos.includes(recusado)) {
            camposRecusados.push(recusado);
            campos = campos.filter((c) => c !== recusado);
            proximaUrl = urlDaPrimeiraPagina();
            paginasLidas = 0;
            continue;
          }
          let dica = "";
          if (codigo === 100 && /nonexisting field \(products\)/i.test(mensagemMeta)) {
            dica =
              " — o ID informado não é de um Catálogo (parece ID de Página, Empresa ou Conta do WhatsApp). " +
              "Pegue o ID em Gerenciador de Comércio → selecione o catálogo → Configurações → ID do catálogo.";
          } else if (codigo === 100 || codigo === 803) {
            dica = " — ID de catálogo inexistente ou sem acesso por este token.";
          } else if (codigo === 190) {
            dica = " — token inválido ou expirado. Gere um novo token de Usuário do Sistema.";
          } else if (codigo === 10 || codigo === 200) {
            dica =
              " — o token não tem permissão no catálogo. Atribua o catálogo ao Usuário do Sistema e use a permissão catalog_management.";
          }
          return fail("meta_api_error", `Erro da Meta: ${mensagemMeta}${dica}`, 422, { requestId });
        }

        const data: MetaGraphResponse = await resp.json();
        const lista = data.data || [];

        for (const item of lista) {
          const produto = mapearProdutoDaMeta(item);
          if (!produto) continue;
          itensParaUpsert.push({
            organization_id: orgId,
            ...produto,
            controla_estoque: false,
            origem: "meta_catalog_api",
          });
        }

        proximaUrl = data.paging?.next ?? null;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail("meta_fetch_error", `Falha ao consultar produtos na Meta: ${msg}`, 422, {
        requestId,
      });
    }
  }

  if (itensParaUpsert.length === 0) {
    return ok({
      total: 0,
      criados: 0,
      atualizados: 0,
      erros,
      mensagem: "Nenhum produto encontrado no catálogo para sincronizar.",
    });
  }

  // Descobrir quais produtos já existem no banco para a organização
  const todosCodigos = itensParaUpsert.map((p) => p.codigo);
  type Existente = {
    fotos?: string[];
    imagem_url?: string | null;
    descricao?: string | null;
    video_url?: string | null;
    video_file_path?: string | null;
    preco_de_cents?: number | null;
    gtin?: string | null;
    categoria?: string | null;
    peso_gramas?: number | null;
    moeda?: string | null;
  };
  const antigosMap = new Map<string, Existente>();

  for (let i = 0; i < todosCodigos.length; i += 500) {
    const pedaco = todosCodigos.slice(i, i + 500);
    const { data: existentes } = await admin
      .from("catalog_products")
      .select("codigo, fotos, imagem_url, descricao, video_url, video_file_path, preco_de_cents, gtin, categoria, peso_gramas, moeda")
      .eq("organization_id", orgId)
      .in("codigo", pedaco);

    if (existentes) {
      for (const ex of existentes) {
        antigosMap.set(chaveDoCodigo(ex.codigo), ex as Existente);
      }
    }
  }

  const moeda = await moedaDaOrganizacao(admin, orgId);

  // Montar payload final preservando fotos e descrições customizadas de produtos existentes
  const paraGravar = itensParaUpsert.map((item) => {
    const existente = antigosMap.get(chaveDoCodigo(item.codigo));
    if (existente) {
      // Produto já existente: nada que alguém pôs à mão se perde. As fotos
      // atuais ficam (e na frente — a principal não muda) e as da Meta que
      // faltam entram depois; vídeo subido não é trocado; campo que a Meta
      // não trouxe mantém o valor de hoje. A descrição da Meta vence: é ela
      // que traz a formatação de volta.
      const fotosFinais = juntarFotos(existente.fotos ?? [], item.fotos ?? []);
      const temVideoProprio = Boolean(existente.video_file_path || existente.video_url);
      return {
        ...item,
        descricao: item.descricao || existente.descricao || null,
        imagem_url: existente.imagem_url || item.imagem_url || fotosFinais[0] || null,
        fotos: fotosFinais,
        video_url: temVideoProprio ? (existente.video_url ?? null) : (item.video_url ?? null),
        preco_de_cents: item.preco_de_cents ?? existente.preco_de_cents ?? null,
        gtin: item.gtin ?? existente.gtin ?? null,
        categoria: item.categoria ?? existente.categoria ?? null,
        peso_gramas: item.peso_gramas ?? existente.peso_gramas ?? null,
        moeda: item.moeda ?? existente.moeda ?? moeda,
      };
    }

    // Produto novo: a moeda da Meta, senão a da organização
    return {
      ...item,
      moeda: item.moeda ?? moeda,
    };
  });

  let gravados = 0;

  // Realizar upsert em lotes
  for (let i = 0; i < paraGravar.length; i += LOTE) {
    const lote = paraGravar.slice(i, i + LOTE);
    const { error: upsertErr } = await admin
      .from("catalog_products")
      .upsert(lote.map(semALinha), { onConflict: "organization_id,codigo" });

    if (!upsertErr) {
      gravados += lote.length;
      continue;
    }

    // Se o lote falhar, tenta item a item para não perder o lote inteiro
    for (const item of lote) {
      const { error: individualErr } = await admin
        .from("catalog_products")
        .upsert([semALinha(item)], { onConflict: "organization_id,codigo" });

      if (individualErr) {
        erros.push({
          linha: item.linha || 0,
          motivo: `"${item.nome}" (${item.codigo}): ${individualErr.message}`,
        });
      } else {
        gravados += 1;
      }
    }
  }

  // Fotos ainda em link externo vão para o bucket em segundo plano, um evento
  // por produto (`lib/catalogo/fotos-externas.handler.ts`): só foto do bucket
  // o atendente de IA consegue enviar, e baixar ~2.000 fotos aqui estouraria o
  // tempo da requisição.
  let fotosEmDownload = 0;
  for (let i = 0; i < todosCodigos.length; i += 500) {
    const { data: gravadosAgora } = await admin
      .from("catalog_products")
      .select("id, fotos")
      .eq("organization_id", orgId)
      .in("codigo", todosCodigos.slice(i, i + 500));
    for (const p of (gravadosAgora ?? []) as Array<{ id: string; fotos: string[] | null }>) {
      if (!(p.fotos ?? []).some(ehFotoExterna)) continue;
      const { error: erroEvento } = await admin.rpc("emit_event" as never, {
        p_event_type: EVENTO_DE_FOTOS_EXTERNAS,
        p_entity_kind: "catalog_product",
        p_entity_id: p.id,
        p_payload: { organization_id: orgId, product_id: p.id },
        p_metadata: { source: "meta_catalog_sync", request_id: requestId },
        p_organization_id: orgId,
      } as never);
      if (!erroEvento) fotosEmDownload++;
    }
  }

  const agoraIso = new Date().toISOString();
  const existentesCount = itensParaUpsert.filter((p) => antigosMap.has(chaveDoCodigo(p.codigo))).length;
  const criadosCount = Math.max(0, gravados - existentesCount);
  const atualizadosCount = Math.min(gravados, existentesCount);

  // Atualizar contadores e timestamp em organizations.settings.meta_catalog
  const updatedSettings = {
    ...settings,
    meta_catalog: {
      ...metaCatalog,
      catalog_id: catalogId,
      last_sync_at: agoraIso,
      products_count: gravados,
      last_sync_status: "success",
      last_sync_error: null,
    },
  };

  await admin
    .from("organizations")
    .update({ settings: updatedSettings })
    .eq("id", orgId);

  // Registrar auditoria
  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.meta_synced",
    requestId,
    resourceType: "catalog_products",
    resourceId: null,
    metadata: {
      catalog_id: catalogId,
      feed_url: feedUrl,
      total_encontrados: itensParaUpsert.length,
      gravados,
      criados: criadosCount,
      atualizados: atualizadosCount,
      erros_count: erros.length,
    },
  });

  return ok({
    total: itensParaUpsert.length,
    gravados,
    criados: criadosCount,
    atualizados: atualizadosCount,
    erros,
    campos_recusados: camposRecusados,
    fotos_em_download: fotosEmDownload,
    last_sync_at: agoraIso,
  });
}
