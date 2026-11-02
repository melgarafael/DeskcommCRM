/**
 * POST /api/v1/message-templates/importar — aplica um arquivo de blueprint de
 * respostas rápidas na organização ativa (issue #1995).
 *
 * ─── O recorte: ADITIVO, e só onde não há nada ──────────────────────────────
 *
 * A issue pede três coisas: o blueprint nunca sobrescreve, duplicidade é tratada
 * "conforme a entidade", e a aplicação respeita o isolamento entre organizações.
 * A primeira e a terceira este recorte cumpre por construção. A do meio é uma
 * DECISÃO (usar o existente? criar outro? mesclar? ignorar?) e é exatamente o
 * que este PR não inventa: em vez de escolher por entidade, a rota só aplica em
 * organização que ainda não tem NENHUMA resposta rápida compartilhada, e recusa
 * o resto com 409 sem efeito. Aplicar em base vazia é a única forma de "adicionar,
 * nunca substituir" que não precisa de política de merge.
 *
 * De quebra, isso dá idempotência de graça: o segundo POST do mesmo arquivo cai
 * no mesmo 409, porque o primeiro deixou a organização não-vazia. Não há
 * `Idempotency-Key` aqui — a trava é o estado, não um recibo.
 *
 * ─── Por que compartilhadas, e por que `manager` ────────────────────────────
 *
 * O arquivo não carrega dono (ver `lib/templates/blueprint.ts`), então tudo
 * entra como compartilhado (`owner_user_id null`) — que é o que a RLS
 * `message_templates_write` deixa `manager`+ gravar. O guarda de QUAL organização
 * recebe é o `requireRole`, que resolve a org ativa do cookie, nunca do corpo;
 * nada no arquivo escolhe o destino.
 *
 * ─── Uma transação, ou nada ─────────────────────────────────────────────────
 *
 * Um único `insert` com todos os itens: o PostgREST executa a instrução inteira
 * ou nenhuma linha. Import pela metade é pior que import recusado — quem
 * reaplicasse depois cairia no 409 do guarda e não teria como terminar a
 * primeira metade.
 *
 * ─── O que NÃO é importado ──────────────────────────────────────────────────
 *
 * Mídia. `midias` nasce vazia em toda linha, porque o `storage_path` do arquivo
 * seria caminho de OUTRA organização no bucket privado (é o mesmo motivo pelo
 * qual o export não a leva). A resposta chega como texto; a imagem se recarrega
 * na tela de destino, com os bytes do destino.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { marcaDaSaida } from "@/lib/branding/saida";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import {
  TETO_DE_ITENS_DO_BLUEPRINT,
  lerBlueprintDeRespostasRapidas,
  type MotivoDeRecusa,
} from "@/lib/templates/blueprint";

export const dynamic = "force-dynamic";

/**
 * 2 MB. O teto de conteúdo é 200 itens × 4 KB de corpo (~800 KB); 2 MB é folga
 * para JSON indentado e acento em UTF-8, e é o que impede um corpo forjado de
 * chegar ao parser. O mesmo desenho do import de modelo de proposta (5 MB lá,
 * porque lá tem PDF).
 */
const TAMANHO_MAXIMO = 2 * 1024 * 1024;

/**
 * Cada motivo de recusa tem a sua mensagem: "inválido" não ensina ninguém.
 *
 * `{marca}` NÃO é preenchido aqui — a chave precisa chegar inteira em
 * `traduzir()` para casar com o dicionário; quem cola o nome é o chamador, com
 * `.replace("{marca}", …)` depois de traduzir. Escrever o nome do produto
 * direto aqui batizaria a instalação do revendedor com a marca da casa.
 */
function mensagemDoMotivo(motivo: MotivoDeRecusa): string {
  switch (motivo) {
    case "formato":
      return "Este arquivo não é um blueprint do {marca}.";
    case "versao":
      return "Este blueprint é de outra versão do formato — esta instalação lê a versão 1.";
    case "tipo":
      return "Este blueprint não é de respostas rápidas.";
    case "itens":
      return "O arquivo tem itens inválidos: confira título (até 80), corpo (até 4096) e atalho (até 40).";
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "message_templates",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // Texto antes de JSON: com `req.json()` o corpo grande já foi materializado, e
  // o teto viraria decoração.
  const texto = await req.text().catch(() => null);
  if (texto === null) {
    return fail("invalid_request", t("Falha ao ler o arquivo enviado."), 400, { requestId });
  }
  if (texto.length > TAMANHO_MAXIMO) {
    return fail("payload_too_large", t("O arquivo passa de 2 MB."), 413, { requestId });
  }

  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return fail("invalid_request", t("O arquivo não é um JSON válido."), 400, { requestId });
  }

  const lido = lerBlueprintDeRespostasRapidas(bruto);
  if (!lido.ok) {
    // A marca é resolvida só quando a recusa a cita (formato): a pilha
    // organização → instalação → `.env` custa uma leitura, e versão/tipo/itens
    // não precisam dela. Ordem obrigatória: `traduzir()` na chave intacta e só
    // depois `.replace("{marca}", …)` — inverter faria a chave não casar com o
    // dicionário e a recusa sairia em português para quem lê em espanhol.
    const marca = lido.motivo === "formato" ? (await marcaDaSaida(authz.org.orgId)).nome : "";
    const recusa = t(mensagemDoMotivo(lido.motivo)).replace("{marca}", marca);
    return fail("validation_failed", recusa, 422, {
      requestId,
      details: lido.detalhes,
    });
  }

  const supabase = await createClient();

  // O guarda do recorte: organização que já tem resposta compartilhada não
  // recebe blueprint. `head: true` porque o número é tudo o que interessa.
  const { count, error: erroContagem } = await supabase
    .from("message_templates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .is("owner_user_id", null);

  if (erroContagem) {
    return fail("internal_error", t("Erro ao conferir as respostas rápidas da organização."), 500, {
      requestId,
    });
  }
  if ((count ?? 0) > 0) {
    return fail(
      "state_conflict",
      t(
        "Esta organização já tem respostas rápidas compartilhadas. O blueprint só é aplicado onde não há nenhuma — substituir ou mesclar ainda não é uma decisão tomada.",
      ),
      409,
      { requestId },
    );
  }

  const linhas = lido.itens.map((item, indice) => ({
    organization_id: authz.org.orgId,
    // Compartilhada: o arquivo não carrega dono, e não há usuário do destino
    // com quem as pessoais da origem se pareçam.
    owner_user_id: null,
    title: item.titulo,
    body: item.corpo,
    shortcut: item.atalho,
    mostrar_na_barra: item.mostrar_na_barra,
    // A ORDEM é a posição no arquivo (ver `lib/templates/blueprint.ts`): a
    // fração da origem não significa nada numa organização que não a tem.
    ordem: indice,
    midias: [],
  }));

  // Um insert só: instrução inteira ou nenhuma linha (ver o cabeçalho).
  const { error: erroDoInsert } = await supabase.from("message_templates").insert(linhas);
  if (erroDoInsert) {
    return fail("internal_error", t("Erro ao aplicar o blueprint."), 500, { requestId });
  }

  await audit({
    action: "template.imported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "message_templates",
    resourceId: null,
    requestId,
    metadata: {
      // Contagem, nunca conteúdo: o audit diz o que a organização recebeu.
      total: linhas.length,
      // Nada do arquivo trouxe mídia (o export não a leva), mas o número
      // registra que as respostas entraram como texto.
      midias_importadas: 0,
      teto: TETO_DE_ITENS_DO_BLUEPRINT,
    },
  });

  return ok(
    {
      importadas: linhas.length,
      // Explícito na resposta: quem importou precisa saber que a imagem não veio.
      midias_importadas: 0,
    },
    { status: 201, requestId },
  );
}
