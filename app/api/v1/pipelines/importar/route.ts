/**
 * POST /api/v1/pipelines/importar — aplica um blueprint de FUNIS na
 * organização ativa (issue #1995, fatia 2).
 *
 * ─── O que esta rota faz, em uma frase ─────────────────────────────────────
 *
 * Para cada funil do arquivo, cria um funil NOVO com as etapas na ordem do
 * arquivo. Não existe update, upsert nem "mesclar" em caminho nenhum: o
 * original nunca é tocado.
 *
 * ─── Nome repetido vira cópia ──────────────────────────────────────────────
 *
 * A decisão de duplicidade que o envelope de respostas rápidas NÃO precisou
 * tomar (lá não há índice único de conteúdo) aqui é obrigatória: funil tem
 * `uniq_crm_pipelines_org_slug` e nome repetido é recusado pelo POST. Em vez de
 * recusar o arquivo inteiro por causa de um nome, o import cria a cópia —
 * `Clínica (importado)`, `Clínica (importado 2)` — na MESMA régua de
 * comparação da tela (`chaveDeNome`: caixa, acento e espaço não distinguem).
 * Quem importou vê os dois funis e decide o que fazer; nada foi sobrescrito.
 *
 * ─── UMA operação, ou nada ─────────────────────────────────────────────────
 *
 * São duas escritas por funil (funil + etapas) e o PostgREST não dá transação
 * entre requisições. O desenho é o mesmo do POST de funil: compensação por
 * DELETE do que ESTA requisição criou. Funil recém-criado não tem negócio, e
 * `crm_leads_pipeline_id_fkey` é RESTRICT — o desfazimento é seguro por
 * construção. `crm_stages_pipeline_id_fkey` é CASCADE, então as etapas vão
 * junto.
 *
 * ─── O que NÃO é importado ─────────────────────────────────────────────────
 *
 * Ver o cabeçalho de `lib/templates/blueprint-de-funis.ts`: slug, posição
 * numérica, `is_default`/`is_client_pipeline`, vocabulário/custom fields e os
 * ajustes finos da etapa (janela, probabilidade, aviso na Central). O `is_default`
 * tem UMA exceção deliberada: organização sem nenhum funil recebe o primeiro
 * importado como padrão — a mesma regra do POST, e sem ela o destino ficaria sem
 * destino para lead criado sem funil escolhido.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { marcaDaSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { slugDeNome } from "@/lib/leads/stage-editing";
import { posicaoEntre, slugDeFunil, type FunilEditavel } from "@/lib/pipelines/pipeline-editing";
import { createClient } from "@/lib/supabase/server";
import { TETO_DE_ITENS_DO_BLUEPRINT, type MotivoDeRecusa } from "@/lib/templates/blueprint";
import {
  PASSO_DA_POSICAO_DA_ETAPA,
  lerBlueprintDeFunis,
  nomeDeCopia,
} from "@/lib/templates/blueprint-de-funis";
import { lerFunis } from "../_funis";

export const dynamic = "force-dynamic";

/**
 * 2 MB, o mesmo teto do import de respostas rápidas. Um arquivo de 200 funis ×
 * 200 etapas cabe com folga; o teto existe para corpo forjado não chegar ao
 * parser.
 */
const TAMANHO_MAXIMO = 2 * 1024 * 1024;

/**
 * Cada motivo de recusa tem a sua mensagem — as três primeiras são as MESMAS do
 * import de respostas rápidas (o motivo é do envelope, não do tipo); só a de
 * `tipo` e a de `itens` mudam, porque o conteúdo é outro.
 *
 * `{marca}` NÃO é preenchido aqui: a chave precisa chegar inteira em
 * `traduzir()` para casar com o dicionário; quem cola o nome é o chamador.
 */
function mensagemDoMotivo(motivo: MotivoDeRecusa): string {
  switch (motivo) {
    case "formato":
      return "Este arquivo não é um blueprint do {marca}.";
    case "versao":
      return "Este blueprint é de outra versão do formato — esta instalação lê a versão 1.";
    case "tipo":
      return "Este blueprint não é de funis.";
    case "itens":
      return "O arquivo tem funis inválidos: confira a quantidade (de 1 a 200), o nome do funil (até 80), a descrição (até 280) e as etapas (de 1 a 200 por funil, com nome de até 80).";
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "crm_pipelines",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  // O teto vale sobre os BYTES lidos, com ou sem `content-length`.
  const corpo = await lerCorpoComTeto(req, TAMANHO_MAXIMO, {
    requestId,
    idioma: authz.user.idioma,
    acimaDoTeto: t("O arquivo passa de 2 MB."),
  });
  if (!corpo.ok) return corpo.response;
  const texto = await corpo.corpo.text();

  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return fail("invalid_request", t("O arquivo não é um JSON válido."), 400, { requestId });
  }

  const lido = lerBlueprintDeFunis(bruto);
  if (!lido.ok) {
    // A marca é resolvida só quando a recusa a cita (formato) — a mesma ordem do
    // import de respostas rápidas: `traduzir()` na chave intacta e só depois
    // `.replace("{marca}", …)`.
    const marca = lido.motivo === "formato" ? (await marcaDaSaida(orgId)).nome : "";
    const recusa = t(mensagemDoMotivo(lido.motivo)).replace("{marca}", marca);
    return fail("validation_failed", recusa, 422, {
      requestId,
      details: lido.detalhes,
    });
  }

  const supabase = await createClient();

  let funis: FunilEditavel[];
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  const criados: string[] = [];
  let etapasCriadas = 0;
  let renomeados = 0;

  // Em série de propósito: o nome do próximo depende dos anteriores (sufixo de
  // cópia e ordem da lista), e o volume é de até 200 funis.
  for (const item of lido.itens) {
    const nome = nomeDeCopia(
      item.nome,
      funis.map((funil) => funil.name),
    );
    if (nome !== item.nome.trim()) renomeados += 1;

    const linha = {
      organization_id: orgId,
      name: nome,
      description: item.descricao,
      // Arquivados entram na conta do slug: o índice não é parcial.
      slug: slugDeFunil(
        nome,
        funis.map((funil) => funil.slug),
      ),
      // No fim da lista: o arquivo não decide o meio do quadro.
      position: posicaoEntre(funis[funis.length - 1]?.position ?? null, null),
      // Organização sem funil vivo ganha o primeiro importado como padrão — a
      // mesma regra do POST /pipelines (ver o cabeçalho).
      is_default: funis.filter((funil) => !funil.is_archived).length === 0,
      is_archived: false,
    };

    const { data: criado, error: erroDoFunil } = await supabase
      .from("crm_pipelines")
      .insert(linha)
      .select("id")
      .single();

    if (erroDoFunil || !criado) {
      await desfazerCriados(supabase, orgId, criados);
      return fail("internal_error", t("Não consegui importar o blueprint de funis. Nada foi aplicado."), 500, {
        requestId,
        details: { erro: erroDoFunil?.message },
      });
    }

    const pipelineId = (criado as { id: string }).id;
    criados.push(pipelineId);

    // A ordem é a do array: posição 1000, 2000, … — a mesma régua do POST.
    const slugsDaEtapa: string[] = [];
    const etapas = item.etapas.map((etapa, indice) => {
      const slug = slugDeNome(etapa.nome, slugsDaEtapa);
      slugsDaEtapa.push(slug);
      return {
        organization_id: orgId,
        pipeline_id: pipelineId,
        name: etapa.nome,
        slug,
        position: (indice + 1) * PASSO_DA_POSICAO_DA_ETAPA,
        color: etapa.cor,
        is_won: etapa.is_won,
        is_lost: etapa.is_lost,
        is_archived: false,
      };
    });

    const { error: erroDasEtapas } = await supabase.from("crm_stages").insert(etapas);

    if (erroDasEtapas) {
      await desfazerCriados(supabase, orgId, criados);
      return fail("internal_error", t("Não consegui importar o blueprint de funis. Nada foi aplicado."), 500, {
        requestId,
        details: { erro: erroDasEtapas.message },
      });
    }

    etapasCriadas += etapas.length;
    // O próximo funil já enxerga este: nome e posição entram na conta.
    funis = funis.concat({
      id: pipelineId,
      name: linha.name,
      slug: linha.slug,
      description: linha.description,
      position: linha.position,
      is_default: linha.is_default,
      is_client_pipeline: false,
      is_archived: false,
    });
  }

  await audit({
    action: "pipeline.imported",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: null,
    requestId,
    metadata: {
      // Contagem, nunca nomes: o audit diz o que a organização recebeu.
      total: lido.itens.length,
      etapas: etapasCriadas,
      renomeados,
      teto: TETO_DE_ITENS_DO_BLUEPRINT,
    },
  });

  return ok(
    { importados: lido.itens.length, etapas: etapasCriadas, renomeados },
    { status: 201, requestId },
  );
}

/**
 * Desfaz TUDO o que esta requisição criou, na ordem inversa.
 *
 * `crm_stages_pipeline_id_fkey` é CASCADE (as etapas vão junto) e o funil
 * recém-criado não tem negócio, então `crm_leads_pipeline_id_fkey` (RESTRICT)
 * não atrapalha. Falha no desfazimento não vira outra resposta: a rota já vai
 * responder 500, e o operador precisa saber que precisa conferir a lista.
 */
async function desfazerCriados(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  criados: readonly string[],
): Promise<void> {
  for (const id of [...criados].reverse()) {
    await supabase.from("crm_pipelines").delete().eq("id", id).eq("organization_id", orgId);
  }
}
