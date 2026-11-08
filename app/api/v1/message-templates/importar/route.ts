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
 * ─── UMA operação, ou nada ──────────────────────────────────────────────────
 *
 * Conferir e gravar são UMA chamada só, à função
 * `fn_importar_blueprint_de_respostas_rapidas` (migration 9091): ela toma
 * `pg_advisory_xact_lock` por ORGANIZAÇÃO, conta as compartilhadas e grava o
 * lote inteiro na MESMA transação. Antes eram duas requisições ao PostgREST —
 * `count` e `insert` —, e dois POST simultâneos do mesmo arquivo passavam os
 * dois pela conferência antes de qualquer escrita aparecer: a organização
 * terminava com 2× as respostas. Não há índice único em `message_templates`
 * (título e corpo iguais são legítimos), então o remédio não é constraint.
 * O segundo POST, agora, espera a trava e recebe o mesmo 409 — declarado, não
 * um no-op silencioso.
 *
 * Um único `insert` continua valendo dentro da função: instrução inteira ou
 * nenhuma linha. Import pela metade é pior que import recusado — quem
 * reaplicasse depois cairia no 409 do guarda e não teria como terminar a
 * primeira metade.
 *
 * ─── O que NÃO é importado ──────────────────────────────────────────────────
 *
 * Mídia. `midias` nasce vazia em toda linha, porque o `storage_path` do arquivo
 * seria caminho de OUTRA organização no bucket privado (é o mesmo motivo pelo
 * qual o export não a leva). A resposta chega como texto; a imagem se recarrega
 * na tela de destino, com os bytes do destino.
 *
 * E por isso o item SEM TEXTO não entra. `body` vazio é legal de propósito na
 * criação (#2833): a resposta de áudio é uma linha sem texto, e o arquivo entra
 * por `POST /message-templates/:id/midias`. Mas o blueprint não carrega mídia
 * nenhuma — importar o item assim criaria uma resposta sem texto e sem arquivo,
 * que não serve para nada e ainda ocuparia lugar na barra do Inbox. O item fica
 * de fora e a perda é CONTADA em `sem_texto` (resposta e audit). Arquivo só com
 * itens de áudio é 422: não há o que aplicar, e um 201 que não aplicou nada
 * seria mentira.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
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
 * O que a função do banco devolve. `aplicado: false` é o desfecho PREVISTO de
 * "a organização já tem compartilhada" — a função não levanta exceção por isso,
 * e é a rota que escolhe o 409.
 */
interface ResultadoDaAplicacao {
  aplicado: boolean;
  importadas: number;
}

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
      // A quantidade entra na frase: o schema recusa lista vazia e lista acima
      // do teto pelo MESMO motivo `itens`, e quem tem 201 respostas precisa ler
      // o limite, não procurar um título longo que não existe.
      return "O arquivo tem itens inválidos: confira a quantidade (de 1 a 200), o título (até 80), o corpo (até 4096) e o atalho (até 40).";
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

  // O teto vale sobre os BYTES lidos, com ou sem `content-length`: um teto
  // conferido só depois da leitura inteira viraria decoração.
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

  // ─── O item sem texto (recurso de áudio) não viaja ─────────────────────────
  // `corpo` já vem trimado do schema. Filtrar ANTES da função mantém a conta da
  // perda no lado de quem lê o arquivo, e o `where` da função repete a regra
  // como cinto: nenhum caminho cria a linha vazia.
  const comTexto = lido.itens.filter((item) => item.corpo.length > 0);
  const semTexto = lido.itens.length - comTexto.length;

  if (comTexto.length === 0) {
    // Nada a aplicar. 201 aqui diria "importado" para uma organização que não
    // recebeu nada — e a tela mostraria a lista vazia como sucesso.
    return fail(
      "validation_failed",
      t(
        "Este arquivo só tem respostas de áudio, e o blueprint não leva o arquivo de mídia. Nada foi aplicado.",
      ),
      422,
      { requestId, details: { sem_texto: semTexto } },
    );
  }

  const supabase = await createClient();

  // Conferência e gravação numa chamada só (migration 9091): a função trava por
  // organização e só grava se ela continuar vazia — dois POST simultâneos não
  // duplicam. Chamada pelo cliente do USUÁRIO: a RLS `message_templates_write`
  // continua sendo a autoridade sobre quem grava onde.
  const { data, error: erroDaAplicacao } = await supabase.rpc(
    "fn_importar_blueprint_de_respostas_rapidas",
    {
      p_org: authz.org.orgId,
      // A ordem é a posição no array (ver `lib/templates/blueprint.ts`): a
      // fração da origem não significa nada numa organização que não a tem.
      p_itens: comTexto,
    },
  );

  if (erroDaAplicacao) {
    return fail("internal_error", t("Erro ao aplicar o blueprint."), 500, { requestId });
  }

  const resultado = data as Partial<ResultadoDaAplicacao> | null;
  if (!resultado?.aplicado) {
    return fail(
      "state_conflict",
      t(
        "Esta organização já tem respostas rápidas compartilhadas. O blueprint só é aplicado onde não há nenhuma — substituir ou mesclar ainda não é uma decisão tomada.",
      ),
      409,
      { requestId },
    );
  }

  const importadas = resultado.importadas ?? 0;

  await audit({
    action: "template.imported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "message_template",
    resourceId: null,
    requestId,
    metadata: {
      // Contagem, nunca conteúdo: o audit diz o que a organização recebeu.
      total: importadas,
      // Nada do arquivo trouxe mídia (o export não a leva), mas o número
      // registra que as respostas entraram como texto.
      midias_importadas: 0,
      // O que ficou de fora POR NÃO TER TEXTO: a perda tem de estar no rastro,
      // não só no corpo da resposta que a tela talvez não mostre.
      sem_texto: semTexto,
      teto: TETO_DE_ITENS_DO_BLUEPRINT,
    },
  });

  return ok(
    {
      importadas,
      // Explícito na resposta: quem importou precisa saber que a imagem não veio.
      midias_importadas: 0,
      // E que os itens só de áudio ficaram de fora — nada de esconder a perda.
      sem_texto: semTexto,
    },
    { status: 201, requestId },
  );
}
