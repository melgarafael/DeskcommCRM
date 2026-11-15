/**
 * GET/POST /api/v1/cron/catalog-feed-sync — o catálogo da revenda se atualiza
 * sozinho (#3587, fatia 2).
 *
 * ─── O que este cron faz ────────────────────────────────────────────────────
 *
 * Para cada fonte ATIVA de `catalog_feed_sources`, busca o feed que a revenda
 * publica, planeja a rodada (`lib/catalogo/feed.ts`) e aplica
 * (`lib/catalogo/feed-aplicacao.ts`): cria o que é novo, atualiza o que mudou e
 * marca `ativo = false` no que saiu do feed. É o mesmo caminho da rota
 * `POST /api/v1/products/feed` com `dry_run: false` — a rota é a interface, o
 * cron é a mesma regra sem ninguém clicar.
 *
 * ─── Três regras que valem mais que a conveniência ──────────────────────────
 *
 * 1. **O portão vem ANTES de qualquer leitura** (`recursoOcioso`). Instalação
 *    sem fonte é o caso normal — a maioria não tem revenda com feed — e uma
 *    ida ao PostgREST por batida só para descobrir que a tabela está vazia é
 *    exatamente o custo que o #3731 mediu (o piso ocioso). O predicado do
 *    portão é "existe fonte ativa", que é MAIS LARGO que o da rodada (ele não
 *    filtra organização operante): fechar o portão com fonte na fila seria o
 *    defeito que o portão existe para não ter.
 *
 * 2. **Fonte que falhou não desfaz as outras.** Origem fora do ar, JSON torto,
 *    recusa de SSRF: a fonte é reportada e o laço continua. Um feed com defeito
 *    não pode deixar o catálogo de outra organização parado.
 *
 * 3. **Nada é apagado.** Item que saiu do feed vira `ativo = false`; histórico
 *    de conversa e proposta continuam apontando para a linha.
 *
 * ─── Módulo opcional, desligado de fábrica (doc 322, A) ─────────────────────
 *
 * A chave `catalogo_por_feed` é conferida DENTRO de `sincronizarFontes`, antes
 * de ler qualquer fonte: é ali que mora o efeito (buscar URL de fora, gravar no
 * catálogo), e o portão no ponto de execução vale para quem chamar a função,
 * não só para esta rota. Desligada, nenhuma fonte é lida — nem a de quem
 * configurou o feed antes de o dono do servidor desligar.
 *
 * ─── Falha repetida não fica muda ───────────────────────────────────────────
 *
 * Toda rodada grava o desfecho na própria fonte (`ultimo_resumo`,
 * `falhas_seguidas`, `ultimo_erro`), que a tela de Produtos mostra. Na
 * `LIMITE_DE_FALHAS`-ésima falha seguida abre UM aviso na Central; a primeira
 * rodada que dá certo zera a conta e resolve o aviso.
 *
 * Auth: mesmo contrato dos demais crons (Bearer `INTERNAL_CRON_SECRET` |
 * `INTERNAL_SECRET`, fail-closed) — `lib/auth/cron-auth.ts`.
 *
 * NOTA DE DEPLOY: o agendamento vive em `docker/scheduler/entrypoint.sh`
 * (serviço `scheduler` do compose), como os outros crons. Cadência de 2 em 2
 * horas: catálogo de revenda muda no ritmo do estoque, e preço errado por duas
 * horas é recuperável — 96 buscas por dia no site da revenda seriam abuso sem
 * ganho.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import {
  lerFeed,
  type FormatoDoFeed,
  planejarRodada,
  type ProdutoDoCatalogo,
  resumoDoPlano,
} from "@/lib/catalogo/feed";
import { aplicarPlano, type BancoDoFeed, type CamposDoUpdate, type LinhaDoProduto } from "@/lib/catalogo/feed-aplicacao";
import { REF_DO_AVISO } from "@/lib/catalogo/fonte-do-feed";
import { buscarFeedDaUrl } from "@/lib/catalogo/feed-remoto";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** O teto de fontes por batida — uma por organização, e o cron não é um varredor. */
const MAXIMO_DE_FONTES = 200;

/** Na 3ª rodada seguida sem conseguir ler o feed (6 h), abre aviso na Central. */
export const LIMITE_DE_FALHAS = 3;


/**
 * O que roda DEPOIS do portão do piso ocioso, na ordem do arquivo — lido pelo
 * `tests/unit/cron-passa-pelo-portao.test.ts`. Aqui o passo é a rodada inteira:
 * o `try` que lê as fontes, busca os feeds e aplica. É o desenho, não descuido:
 * sem fonte ativa a batida sai antes, e é justamente o custo que o portão evita.
 */
const PASSOS_DEPOIS_DO_PORTAO = ["try"] as const;
void PASSOS_DEPOIS_DO_PORTAO;

interface FonteDoFeed {
  id: string;
  organization_id: string;
  falhas_seguidas: number;
  url: string;
  formato: FormatoDoFeed;
  mapeamento: Record<string, string>;
}

export interface ResultadoDaFonte {
  organization_id: string;
  criados: number;
  atualizados: number;
  desativados: number;
  inalterados: number;
  erros: number;
  falhou?: string;
}

/**
 * Separado do handler para o teste exercitar a REGRA sem montar auth — mesmo
 * padrão de `sync-model-catalog`/`recover-stuck-messages`.
 *
 * Recebe o admin client como argumento: é o que deixa o teste injetar um banco
 * de mentira e contar escritas sem tocar em RLS.
 */
export async function sincronizarFontes(
  admin: ReturnType<typeof createAdminClient>,
): Promise<ResultadoDaFonte[] | null> {
  // O PORTÃO DO MÓDULO, antes de ler qualquer fonte. `null` = desligado.
  if (!(await moduloLigado(admin, "catalogo_por_feed"))) return null;

  const { data: fontes, error } = await admin
    .from("catalog_feed_sources")
    .select("id,organization_id,url,formato,mapeamento,falhas_seguidas")
    .eq("ativo", true)
    .limit(MAXIMO_DE_FONTES);
  if (error) throw new Error(`fonte_do_catalogo_leitura_falhou: ${error.message}`);

  const resultados: ResultadoDaFonte[] = [];
  const lista = (fontes ?? []) as unknown as FonteDoFeed[];

  // Organização parada (suspensa, redigida ou arquivada) não gasta nem sai para
  // a internet: a régua é a mesma dos outros crons (`lib/organizacao/operante`).
  // A fonte continua na fila — a organização pode voltar a operar —, só não é
  // lida nesta batida, e a rodada diz por quê no resumo.
  const paradas = lista.length > 0 ? new Set(await idsDeOrgsParadas(admin)) : new Set<string>();

  for (const fonte of lista) {
    if (paradas.has(fonte.organization_id)) {
      resultados.push({
        organization_id: fonte.organization_id,
        criados: 0,
        atualizados: 0,
        desativados: 0,
        inalterados: 0,
        erros: 0,
        falhou: "organizacao_parada",
      });
      continue;
    }
    const resumo: ResultadoDaFonte = {
      organization_id: fonte.organization_id,
      criados: 0,
      atualizados: 0,
      desativados: 0,
      inalterados: 0,
      erros: 0,
    };

    try {
      const remoto = await buscarFeedDaUrl(fonte.url);
      if (!remoto.ok) throw new Error(remoto.motivo);

      const leitura = lerFeed(remoto.texto, fonte.formato === "csv" ? "csv" : "json");
      if (!leitura.ok) throw new Error(leitura.motivo);

      const { data: lidos, error: erroLeitura } = await admin
        .from("catalog_products")
        .select("id,id_externo,nome,descricao,preco_cents,fotos,quantidade,ativo")
        .eq("organization_id", fonte.organization_id);
      if (erroLeitura) throw new Error(erroLeitura.message);

      const existentes = ((lidos ?? []) as unknown as ProdutoDoCatalogo[]).filter(
        (produto) => produto.id_externo !== null,
      );

      const plano = planejarRodada(leitura.registros, {
        existentes,
        mapeamento: fonte.mapeamento ?? {},
      });
      // Trava da desativação (feed sem item reconhecível, ou mais da metade fora
      // de linha): nada é aplicado e a rodada é FALHA — conta para o aviso.
      if (plano.recusa) throw new Error(plano.recusa);
      const contagem = resumoDoPlano(plano);

      const moeda = await moedaDaOrganizacao(admin, fonte.organization_id);

      const banco: BancoDoFeed = {
        criar: async (linha: LinhaDoProduto) => {
          // O tenant vai EXPLÍCITO no payload, resolvido da fonte (não do plano):
          // o service role contorna a RLS por desenho, então o `organization_id`
          // é a única coisa que impede a linha de nascer no tenant errado.
          const { error: erroInsert } = await admin
            .from("catalog_products")
            .insert({ ...linha, organization_id: fonte.organization_id });
          return erroInsert ? erroInsert.message : null;
        },
        atualizar: async (id: string, campos: CamposDoUpdate) => {
          const { error: erroUpdate } = await admin
            .from("catalog_products")
            .update(campos)
            .eq("id", id)
            .eq("organization_id", fonte.organization_id);
          return erroUpdate ? erroUpdate.message : null;
        },
        desativar: async (ids: readonly string[]) => {
          const { error: erroDesativar } = await admin
            .from("catalog_products")
            .update({ ativo: false })
            .in("id", [...ids])
            .eq("organization_id", fonte.organization_id);
          return erroDesativar ? erroDesativar.message : null;
        },
      };

      const aplicado = await aplicarPlano(banco, plano, {
        orgId: fonte.organization_id,
        moeda,
        t: (texto) => texto,
        requestId: randomUUID(),
      });

      Object.assign(resumo, {
        criados: aplicado.criados.length,
        atualizados: aplicado.atualizados.length,
        desativados: aplicado.desativados.length,
        inalterados: contagem.inalterados,
        erros: contagem.erros + aplicado.falhas.length,
      });

      // O resumo é o que o operador olha quando o catálogo parece parado.
      await admin
        .from("catalog_feed_sources")
        .update({ ultima_leitura_em: new Date().toISOString(), ultimo_resumo: resumo, falhas_seguidas: 0, ultimo_erro: null })
        .eq("organization_id", fonte.organization_id);
      if ((fonte.falhas_seguidas ?? 0) >= LIMITE_DE_FALHAS) await resolverAviso(admin, fonte);
      resultados.push(resumo);
    } catch (erro) {
      // Fonte com defeito não desfaz as outras: registra e segue.
      const detalhe = erro instanceof Error ? erro.message : String(erro);
      logger.warn("[catalog-feed-sync] fonte falhou", {
        organization_id: fonte.organization_id,
        erro: detalhe.slice(0, 300),
      });
      const falhou = { ...resumo, falhou: detalhe.slice(0, 300) };
      const falhas = (fonte.falhas_seguidas ?? 0) + 1;
      const { error: erroDoRastro } = await admin
        .from("catalog_feed_sources")
        .update({
          ultima_leitura_em: new Date().toISOString(),
          ultimo_resumo: falhou,
          falhas_seguidas: falhas,
          ultimo_erro: falhou.falhou,
        })
        .eq("organization_id", fonte.organization_id);
      if (erroDoRastro) {
        logger.error("[catalog-feed-sync] não gravou a falha na fonte", {
          organization_id: fonte.organization_id,
          erro: erroDoRastro.message,
        });
      }
      // Na travessia exata do limite: um aviso por sequência de falhas, não um por batida.
      if (falhas === LIMITE_DE_FALHAS) await abrirAviso(admin, fonte, falhou.falhou);
      resultados.push(falhou);
    }
  }

  return resultados;
}

async function abrirAviso(
  admin: ReturnType<typeof createAdminClient>,
  fonte: FonteDoFeed,
  motivo: string,
): Promise<void> {
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: fonte.organization_id,
    kind: "other",
    severity: "warn",
    status: "open",
    ref_kind: REF_DO_AVISO,
    ref_id: fonte.id,
    title: "O catálogo por feed não está sincronizando",
    body:
      `As últimas ${LIMITE_DE_FALHAS} tentativas de ler o feed da revenda falharam, então preços e produtos ` +
      `podem estar desatualizados. Último motivo: ${motivo}. Confira o endereço em Produtos; nada foi ` +
      "desativado por causa da falha, e o aviso some sozinho na primeira leitura que der certo.",
  });
  if (error) {
    logger.error("[catalog-feed-sync] aviso de falha repetida não abriu", {
      organization_id: fonte.organization_id,
      erro: error.message,
    });
  }
}

async function resolverAviso(admin: ReturnType<typeof createAdminClient>, fonte: FonteDoFeed): Promise<void> {
  const { error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", fonte.organization_id)
    .eq("ref_kind", REF_DO_AVISO)
    .eq("ref_id", fonte.id)
    .eq("status", "open");
  if (error) {
    logger.warn("[catalog-feed-sync] aviso de falha repetida não foi resolvido", {
      organization_id: fonte.organization_id,
      erro: error.message,
    });
  }
}

async function handler(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("unauthorized", "cron secret ausente ou inválido", 401, { requestId });
  }

  // ─── O PORTÃO, ANTES DE QUALQUER LEITURA ──────────────────────────────────
  // Sem fonte ativa, esta batida não faz requisição nenhuma ao PostgREST.
  if (await recursoOcioso("catalogo_do_feed")) {
    return ok({ pulado: "recurso_ocioso" }, { requestId });
  }

  try {
    const admin = createAdminClient();
    const fontes = await sincronizarFontes(admin);
    if (fontes === null) return ok({ pulado: "modulo_desligado" }, { requestId });
    const total = fontes.reduce(
      (soma, fonte) => ({
        criados: soma.criados + fonte.criados,
        atualizados: soma.atualizados + fonte.atualizados,
        desativados: soma.desativados + fonte.desativados,
        inalterados: soma.inalterados + fonte.inalterados,
        erros: soma.erros + fonte.erros,
      }),
      { criados: 0, atualizados: 0, desativados: 0, inalterados: 0, erros: 0 },
    );

    logger.info("[catalog-feed-sync] concluído", { fontes: fontes.length, ...total, request_id: requestId });
    if (total.criados + total.atualizados + total.desativados > 0) {
      void audit({
        action: "catalog_products.synced_from_feed",
        resourceType: "catalog_products",
        requestId,
        bypassedRls: true,
        metadata: { fontes: fontes.length, ...total },
      });
    }

    return ok({ fontes }, { requestId });
  } catch (erro) {
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    logger.error("[catalog-feed-sync] falhou", { error: detalhe, request_id: requestId });
    return fail("cron_failed", detalhe, 500, { requestId });
  }
}

export const GET = handler;
export const POST = handler;
