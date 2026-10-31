/**
 * GET /api/v1/message-templates/exportar — as respostas rápidas COMPARTILHADAS
 * da organização ativa, como arquivo (issue #1995).
 *
 * ─── Por que esta rota existe ───────────────────────────────────────────────
 *
 * Abrir a segunda clínica do mesmo segmento hoje é redigitar a operação: o
 * produto não tinha nenhuma porta de saída para CONFIGURAÇÃO (as que existem —
 * `contacts/export`, `conversations/[id]/export`, `audit/export`,
 * `admin/tenants/export` — levam DADO, não estrutura). O primeiro recorte é o
 * único que não exige decisão de negócio: ver `lib/templates/blueprint.ts`
 * para a medição que escolheu a resposta rápida e para o que fica fora.
 *
 * ─── Só as COMPARTILHADAS ───────────────────────────────────────────────────
 *
 * `owner_user_id is null`. As pessoais pertencem a um usuário da organização de
 * ORIGEM e não têm dono no destino: importá-las seria dar a um estranho o
 * script de um vendedor, e não há campo no arquivo que diga de quem elas são.
 * Quem quer levar as próprias respostas compartilha antes — é o mesmo ato que
 * as torna visíveis para o time.
 *
 * ─── Papel `manager` ────────────────────────────────────────────────────────
 *
 * A mesma régua do export de contatos e do de auditoria: levar configuração
 * embora não é rotina de atendimento (exportar é o primeiro passo de sair do
 * produto). As compartilhadas já são escritas só por `manager`+, então o papel
 * do export e o da escrita batem.
 *
 * ─── A leitura é a MESMA da tela ────────────────────────────────────────────
 *
 * `ordem asc` + os dois desempates do `GET /api/v1/message-templates`: o arquivo
 * tem de sair na ordem que o operador montou, senão o import reproduz outra
 * operação — a ordem é a informação que mais se perde numa migração.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import {
  blueprintDasRespostasRapidas,
  nomeDoArquivo,
  type LinhaExportavel,
} from "@/lib/templates/blueprint";

export const dynamic = "force-dynamic";

/** `midias` não vai para o arquivo — entra para CONTAR o que ficou de fora. */
const COLUNAS = "title, body, shortcut, mostrar_na_barra, midias";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", {
    requestId,
    resource: "message_templates",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("message_templates")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    // Só as compartilhadas — ver o cabeçalho.
    .is("owner_user_id", null)
    .order("ordem", { ascending: true })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });

  if (error) {
    return fail("internal_error", t("Erro ao exportar respostas rápidas."), 500, { requestId });
  }

  const linhas = (data ?? []) as unknown as LinhaExportavel[];
  // Arquivo vazio não é blueprint: quem importa não teria o que aplicar, e a
  // tela mostraria "importei zero" como se tivesse dado certo. 409 porque o
  // pedido está certo e o ESTADO é que não tem o que exportar.
  if (linhas.length === 0) {
    return fail(
      "state_conflict",
      t("Não há respostas rápidas compartilhadas para exportar."),
      409,
      { requestId },
    );
  }

  const { blueprint, midiasNaoExportadas } = blueprintDasRespostasRapidas(linhas);

  await audit({
    action: "template.exported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "message_templates",
    resourceId: null,
    requestId,
    metadata: {
      // QUANTAS e QUANTAS COM MÍDIA — nunca título nem corpo: o audit de export
      // existe para provar o que saiu, não para guardar o script de venda.
      total: blueprint.itens.length,
      midias_nao_exportadas: midiasNaoExportadas,
      versao: blueprint.versao,
      tipo: blueprint.tipo,
    },
  });

  return new Response(JSON.stringify(blueprint, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeDoArquivo()}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      // O que o arquivo deixou para trás, legível por quem integra sem abrir o
      // corpo: mídia não viaja (o caminho é da organização de origem).
      ...(midiasNaoExportadas > 0
        ? { "X-Blueprint-Midias-Nao-Exportadas": String(midiasNaoExportadas) }
        : {}),
    },
  });
}
