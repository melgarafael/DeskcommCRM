import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH/DELETE /api/v1/pipelines/[id] — renomear, descrever, reordenar, eleger
 * padrão, arquivar e (só no caso limpo) excluir um funil.
 *
 * ⚠️ DELETE ARQUIVA POR PADRÃO. Três dependências cobram isso, e só uma delas o
 * banco defende sozinho: `crm_leads_pipeline_id_fkey` é `ON DELETE RESTRICT` (o
 * Postgres recusa funil com negócio), mas `webhook_sources.default_pipeline_id` é
 * `ON DELETE CASCADE` — apagar o funil apagaria a fonte de webhook do cliente EM
 * SILÊNCIO — e `automation_rules.actions` cita `pipeline_id` dentro de jsonb, sem
 * FK nenhuma. `?definitivo=1` só passa pelo caso honesto do "criei sem querer":
 * funil sem negócio, sem formulário e sem automação apontando para ele.
 *
 * Auth: sessão por cookie, papel manager+. `organization_id` sai do JWT — nunca
 * do body nem da URL. As regras vivem em `lib/pipelines/pipeline-editing.ts`
 * (puras, testadas); aqui só há transporte e a ORDEM das escritas, que é o que o
 * índice único de padrão cobra.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  nomeOcupadoPorAtivo,
  podeExcluirDeVez,
  posicaoEntre,
  updatesDeMarcaExclusiva,
  updatesDePadrao,
  validarArquivamento,
  validarNomeDeFunil,
  type FunilEditavel,
} from "@/lib/pipelines/pipeline-editing";
import { createClient } from "@/lib/supabase/server";

import { conflitoDoBanco, corpo, lerDependencias, lerFunis } from "../_funis";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * `depois_de` é o vizinho DE CIMA (`null` = primeiro da lista), não um número de
 * posição: quem clica na seta sabe onde o funil vai parar, não qual fração de
 * `position` isso vira. Mandar o número da tela duplicaria a conta que
 * `posicaoEntre` já faz — e as duas divergiriam no primeiro ajuste.
 */
const bodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(280).nullable().optional(),
    is_default: z.boolean().optional(),
    /**
     * ⚠️ `false` É ACEITO AQUI, ao contrário de `is_default: false` — e a
     * assimetria é deliberada, não descuido. Toda organização PRECISA de um
     * funil padrão (sem ele, lead criado sem funil escolhido fica sem destino);
     * nenhuma precisa de um funil de clientes, e não ter é o estado de fábrica.
     * Recusar o desligamento prenderia o operador numa escolha que ele fez para
     * experimentar. Quem "consertar" esta assimetria quebra o desfazer.
     */
    is_client_pipeline: z.boolean().optional(),
    /**
     * TIRAR DO ARQUIVO (#979). `true` é aceito pelo schema e recusado pelo
     * handler, de propósito: quem manda `is_archived: true` quer arquivar, e
     * arquivar tem porta própria (`DELETE`) porque conta as dependências antes
     * — formulário apontando para o funil, automação ativa, ser o padrão ou o
     * último vivo. Deixar o PATCH arquivar daria a volta em todas elas. Recusar
     * no handler, e não com `z.literal(false)`, é o que permite responder
     * "use o DELETE" em vez de "não entendi o que mudar neste funil".
     */
    is_archived: z.boolean().optional(),
    depois_de: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nada para alterar." });

type PatchDoFunil = {
  name?: string;
  description?: string | null;
  position?: number;
  is_default?: boolean;
  is_client_pipeline?: boolean;
  is_archived?: boolean;
};

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que mudar neste funil."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const pedido = parsed.data;

  const supabase = await createClient();

  let funis: FunilEditavel[];
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  // Funil de outra org morre AQUI, antes de qualquer escrita: `lerFunis` filtra
  // por `organization_id`, então ele simplesmente não está nesta lista — e a
  // resposta é a mesma de um funil inexistente (dizer "existe, mas não é seu" já
  // vaza a existência).
  const alvo = funis.find((f) => f.id === pipelineId);
  if (!alvo) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  // ⚠️ ARQUIVAR É DO `DELETE`, NÃO DAQUI — ele conta as dependências antes
  // (`validarArquivamento`), e este handler não conta nenhuma.
  if (pedido.is_archived === true) {
    return fail(
      "unprocessable_entity",
      `Para arquivar «${alvo.name}», use a opção Arquivar da lista de funis — ela confere antes se algum ` +
        `formulário ou automação ainda manda negócio para ele. Por aqui só dá para tirar do arquivo.`,
      422,
      { requestId },
    );
  }

  // ⚠️ ARQUIVADO NÃO SE EDITA — e a guarda fica, mas o MOTIVO escrito aqui era
  // falso. Dizia que `uniq_crm_pipelines_org_default` é parcial em
  // `is_archived`, e que por isso marcar um arquivado como padrão "passa pelo
  // índice". Medido em `supabase/baseline.sql`: ele é `where (is_default = true)`
  // e mais nada, então essa marcação bate em 23505, não passa.
  //
  // O que a guarda evita de verdade é pior de explicar ao usuário: editar nome,
  // posição ou marca de um funil que sumiu da lista dele. Alcançável sem má-fé —
  // uma aba aberta antes de o funil ser arquivado — e o erro do banco, quando
  // vem, fala de índice, não do que a pessoa fez.
  //
  // ⚠️ A ÚNICA EXCEÇÃO É TIRÁ-LO DO ARQUIVO, E SÓ SE FOR ISSO SOZINHO (#979).
  // Pedido MISTO (desarquivar + renomear, por exemplo) continua 409: quem o
  // montou está com uma tela antiga na frente, e as validações de nome e de
  // posição são medidas contra a lista de ATIVOS — lista de onde o alvo ainda
  // não saiu no instante em que elas rodariam. Aceitar metade do pedido seria
  // pior: o funil voltaria com o nome velho e ninguém saberia por quê.
  const soTiraDoArquivo = pedido.is_archived === false && Object.keys(pedido).length === 1;
  if (alvo.is_archived && !soTiraDoArquivo) {
    return fail(
      "state_conflict",
      `O funil «${alvo.name}» está arquivado e não está mais na sua lista. Tire-o do arquivo antes de editar.`,
      409,
      { requestId },
    );
  }

  if (pedido.name !== undefined) {
    const veredito = validarNomeDeFunil(pedido.name, funis, pipelineId);
    if (!veredito.ok) return fail("unprocessable_entity", veredito.erro, 422, { requestId });
  }

  // ⚠️ O PADRÃO SE MUDA, NÃO SE APAGA — mesma regra da marcação de ganho nas
  // etapas. Sem funil padrão, todo lead criado sem funil escolhido fica sem
  // destino; e o índice único não impede a organização de ficar com ZERO.
  if (pedido.is_default === false) {
    return fail(
      "unprocessable_entity",
      `«${alvo.name}» é o funil padrão e a organização precisa de um. Marque OUTRO funil como padrão — ` +
        `o padrão se muda, não se apaga.`,
      422,
      { requestId },
    );
  }

  const patchDoAlvo: PatchDoFunil = {};
  if (pedido.name !== undefined) patchDoAlvo.name = pedido.name.trim();
  if (pedido.description !== undefined) {
    patchDoAlvo.description = pedido.description?.trim() || null;
  }

  // Tirar do arquivo é update SIMPLES: nenhum índice a disputar (nem o de slug
  // nem o de padrão são parciais em `is_archived`, então o funil já ocupava o
  // lugar dele enquanto estava arquivado). Só entra no patch se ele ESTIVER
  // arquivado — pedir de novo em quem já está fora é pedido já atendido, e uma
  // escrita vazia viraria linha de auditoria sem fato nenhum por trás.
  const tiraDoArquivo = pedido.is_archived === false && alvo.is_archived;
  if (tiraDoArquivo) {
    patchDoAlvo.is_archived = false;

    // #2559 — TIRAR DO ARQUIVO TAMBÉM CONFERE O NOME. O pedido misto
    // (desarquivar + renomear) é recusado lá em cima de propósito, então este é
    // o ÚNICO ponto onde a volta do funil poderia colidir: se alguém criou outro
    // funil ATIVO com o mesmo nome enquanto ele estava arquivado, o update
    // simples devolveria dois funis iguais na lista, sem aviso e sem como
    // renomear no mesmo passo. Recusa com 409 e o conselho — mesma família do
    // 409 do pedido misto; a renomeação automática sairia de baixo de quem.
    const ocupado = nomeOcupadoPorAtivo(funis, pipelineId);
    if (ocupado) {
      return fail(
        "state_conflict",
        t("Já existe um funil ativo chamado «{nome}». Renomeie um dos dois antes de tirar este funil do arquivo.").replace(
          "{nome}",
          ocupado,
        ),
        409,
        { requestId },
      );
    }
  }

  if (pedido.depois_de !== undefined) {
    // Só os ativos compõem a régua: arquivado não ocupa lugar na lista.
    const ativos = funis.filter((f) => !f.is_archived && f.id !== pipelineId);
    const i = pedido.depois_de === null ? -1 : ativos.findIndex((f) => f.id === pedido.depois_de);
    if (pedido.depois_de !== null && i < 0) {
      return fail(
        "unprocessable_entity",
        t("O funil que você escolheu como vizinho não está mais na lista. Recarregue a página."),
        422,
        { requestId },
      );
    }
    const posicao = posicaoEntre(ativos[i]?.position ?? null, ativos[i + 1]?.position ?? null);
    // `posicaoEntre` devolve NaN com vizinhos de MESMA posição (lista que precisa
    // de rebalanceamento). NaN vira `null` no JSON e a coluna é NOT NULL: seria um
    // 23502 cru. Recusar aqui é a diferença entre "tente de novo" e "null value in
    // column position violates not-null constraint".
    if (!Number.isFinite(posicao)) {
      return fail(
        "state_conflict",
        t("Os funis desta lista estão empatados na ordenação. Recarregue a página e mova o funil para outro lugar."),
        409,
        { requestId },
      );
    }
    patchDoAlvo.position = posicao;
  }

  // Eleger padrão pode exigir DOIS updates (liberar o antigo, ocupar o lugar);
  // nome, descrição e posição viajam junto com o update do alvo, nunca num terceiro.
  // O tipo é o mais LARGO dos dois de propósito: `UpdateDePadrao` (só `is_default`)
  // cabe aqui dentro, e declarar assim evita o cast que esconderia um erro real
  // se o formato do patch de padrão mudasse.
  const updates: Array<{ pipelineId: string; patch: PatchDoFunil }> =
    pedido.is_default === true
      ? updatesDePadrao(funis, pipelineId)
      : pedido.is_client_pipeline === true
        ? updatesDeMarcaExclusiva(funis, pipelineId, "is_client_pipeline")
        : [];

  // Desligar é update SIMPLES: não há anterior a liberar, e nenhum índice a
  // disputar. Entra pelo patch do alvo como nome e descrição entram.
  if (pedido.is_client_pipeline === false) patchDoAlvo.is_client_pipeline = false;
  if (Object.keys(patchDoAlvo).length > 0) {
    const i = updates.findIndex((u) => u.pipelineId === pipelineId);
    if (i >= 0) updates[i] = { pipelineId, patch: { ...updates[i]!.patch, ...patchDoAlvo } };
    else updates.push({ pipelineId, patch: patchDoAlvo });
  }

  // ⚠️ EM SEQUÊNCIA, NA ORDEM QUE `updatesDePadrao` DEVOLVE.
  // `uniq_crm_pipelines_org_default` é imediato (não deferível): marcar o novo
  // antes de liberar o antigo é 23505 na cara do usuário. Disparar em paralelo
  // desfaz exatamente essa proteção.
  for (const u of updates) {
    const { error } = await supabase
      .from("crm_pipelines")
      .update(u.patch)
      .eq("id", u.pipelineId)
      .eq("organization_id", orgId);
    if (!error) continue;

    const nome = funis.find((f) => f.id === u.pipelineId)?.name ?? alvo.name;
    const conflito = conflitoDoBanco(error as { code?: string }, nome, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }

  if (updates.length > 0) {
    void audit({
      // Tirar do arquivo tem código PRÓPRIO, espelhando o `pipeline.archived`
      // que o DELETE emite: quem audita quer saber quem trouxe o funil de volta,
      // e `pipeline.updated` esconderia isso entre os renames.
      action: tiraDoArquivo ? "pipeline.unarchived" : "pipeline.updated",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_pipeline",
      resourceId: pipelineId,
      requestId,
      metadata: { pedido, updates },
    });
  }

  try {
    return ok(corpo(await lerFunis(supabase, orgId)), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { id: pipelineId } = await ctx.params;
  const definitivo = req.nextUrl.searchParams.get("definitivo") === "1";

  const supabase = await createClient();

  let funis: FunilEditavel[];
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  const alvo = funis.find((f) => f.id === pipelineId);
  if (!alvo) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  let deps;
  try {
    deps = await lerDependencias(supabase, orgId, pipelineId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  const veredito = definitivo
    ? podeExcluirDeVez(funis, pipelineId, deps)
    : validarArquivamento(funis, pipelineId, deps);
  if (!veredito.ok) {
    // A CONTAGEM VAI EM `details`, não só dentro da frase: a tela mostra "este
    // funil tem N negócios" sem precisar extrair o número da mensagem com regex —
    // segunda régua que quebraria na primeira vez que alguém melhorasse o texto.
    //
    // `t()` + `replace("{nome}")` É O QUE DÁ IDIOMA À RECUSA NOVA DA #2559:
    // `validarArquivamento` devolve o `{nome}` por preencher justamente para a
    // frase casar a chave do dicionário. As outras recusas já vêm com o nome
    // colado, não são chave de nada e caem no fallback do `traduzir` — que
    // devolve o texto como está, sem mudar uma letra.
    return fail("unprocessable_entity", t(veredito.erro).replace("{nome}", alvo.name), 422, {
      requestId,
      details: {
        negocios: deps.negocios,
        fontes_de_webhook: deps.fontesDeWebhook,
        automacoes: deps.regrasAtivas,
      },
    });
  }

  const { error } = definitivo
    ? await supabase.from("crm_pipelines").delete().eq("id", pipelineId).eq("organization_id", orgId)
    : await supabase
        .from("crm_pipelines")
        .update({ is_archived: true })
        .eq("id", pipelineId)
        .eq("organization_id", orgId);

  if (error) {
    const conflito = conflitoDoBanco(error as { code?: string }, alvo.name, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: definitivo ? "pipeline.deleted" : "pipeline.archived",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: pipelineId,
    requestId,
    metadata: { name: alvo.name, slug: alvo.slug, negocios: deps.negocios },
  });

  try {
    return ok(corpo(await lerFunis(supabase, orgId)), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}
