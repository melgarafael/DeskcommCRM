/**
 * POST /api/v1/contacts/bulk — a camada de lote da tela de Contatos (#2484, fatia F3).
 *
 * UMA rota para as três ações em lote que têm caminho por CONTATO único
 * (`tag`, `carteira`, `custom-field`), discriminada por `action`. É o MESMO
 * desenho da camada de lote da Inbox (fatia F1, #2484): um id de outra
 * organização é recusado NO ITEM e não derruba os demais.
 *
 * ── O desenho, e por que ele NÃO é o do `leads/bulk` ─────────────────────
 *
 * A rota de lote dos leads resolve a visibilidade do LOTE com uma consulta só
 * (`fn_mover_leads_em_lote` — transação única: move todos ou move nenhum) e
 * recusa a chamada INTEIRA quando algum id não aparece. Faz sentido lá, e não
 * aqui: um lote de contatos é N contatos independentes, e o relatório da
 * #2484 pede o resultado DE CADA ITEM (feito / recusado e por quê). Uma
 * consulta de visibilidade no nível do lote esconderia QUAL id foi recusado.
 *
 * Então cada id é encaminhado, UM A UM, ao MESMO handler da ação individual.
 * Quem decide tudo continua sendo ele:
 *
 *  - PERMISSÃO: `tag` e `custom-field` passam pelo PATCH de `/contacts/[id]`
 *    (`requireRole("agent")`), `carteira` pelo PATCH de `/contacts/[id]/carteira`
 *    (`requireRole("manager")` — a única porta que grava
 *    `contacts.carteira_user_id`, via `fn_definir_carteira_do_cliente`). A
 *    régua não é copiada para cá; é a mesma função, com o mesmo piso;
 *  - ORGANIZAÇÃO: cada subchamada lê a org da SESSÃO (cookie validado) e
 *    filtra por ela. Esta rota não consulta organização nenhuma — não existe
 *    campo de org no corpo, e a sessão é a única fonte;
 *  - AUDITORIA: cada caminho individual escreve a sua própria entrada por
 *    CONTATO (`contact.updated` no PATCH, `contact.carteira_changed` na
 *    carteira). Não há auditoria do lote: uma entrada agregada apagaria qual
 *    contato sofreu qual ação.
 *
 * ── O que esta rota acrescenta ───────────────────────────────────────────
 *
 * 1. O portão da CHAMADA: `requireRole("agent")` uma vez, antes de qualquer
 *    item — um `viewer` recebe 403 pela chamada, não N itens recusados. (Os
 *    handlers por item revalidam: a fonte da permissão continua sendo eles.)
 * 2. O TETO por chamada (`TETO_DO_LOTE`), recusado com 422 `bulk_too_large` e
 *    o número na mensagem.
 * 3. O RELATÓRIO por item, com o `request_id` de cada subchamada para quem
 *    precisar correlacionar com a auditoria do item.
 *
 * ── A resposta é 200 mesmo com itens recusados ───────────────────────────
 *
 * A chamada foi bem-sucedida: ela fez o que pôz e recusou o que não pôde, com
 * o motivo de cada recusa. Código de erro HTTP reserva-se para a CHAMADA
 * (401/403/422/500) — um lote pela metade não é erro de quem chamou, é o
 * resultado. Só assim a tela pode dizer "90 feitos, 10 recusados" em vez de
 * mostrar um erro vermelho por um contato que já era de outra organização.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { normalizarTag, normalizarTags } from "@/lib/contacts/tag-normalizada";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { bulkContactActionSchema, validateRequest } from "@/lib/schemas";
import type { BulkContactActionInput } from "@/lib/schemas";

import { GET as lerUmContato, PATCH as atualizarUmContato } from "../[id]/route";
import { PATCH as definirCarteira } from "../[id]/carteira/route";

export const dynamic = "force-dynamic";

/**
 * Quantos contatos uma chamada aceita. A issue #2484 pede "teto por chamada
 * (ex.: 100)"; 100 é o tamanho máximo de página da lista de contatos. Com
 * "carregar mais", a tela pode ter mais de 100 linhas e o "selecionar todas"
 * passa do teto: a chamada volta 422 `bulk_too_large`, a tela mostra o erro e
 * nada é gravado.
 */
export const TETO_DO_LOTE = 100;

/** Uma linha do relatório: o que aconteceu com UM contato. */
interface ResultadoDoItem {
  id: string;
  feito: boolean;
  /** Código da recusa (`not_found`, `contact_not_found`, …) — só quando recusado. */
  codigo?: string;
  /** O porquê, na língua de quem chamou. */
  motivo?: string;
  /** `X-Request-Id` da subchamada: correlação com a auditoria do item. */
  request_id?: string;
}

/**
 * Traduz a resposta do handler por item em uma linha do relatório.
 *
 * Lê o corpo de erro dos wrappers canônicos (`{ error: { code, message } }`) —
 * a mensagem JÁ vem traduzida pelo handler, na língua do usuário, e não é
 * reescrita aqui.
 */
async function classificar(res: Response, id: string): Promise<ResultadoDoItem> {
  const requestId = res.headers.get("X-Request-Id") ?? undefined;
  if (res.ok) return { id, feito: true, request_id: requestId };
  let codigo = "internal_error";
  let motivo = "Não foi possível concluir a ação neste contato.";
  try {
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };
    if (corpo.error?.code) codigo = corpo.error.code;
    if (corpo.error?.message) motivo = corpo.error.message;
  } catch {
    // Resposta sem corpo JSON: o código e a mensagem padrão já bastam.
  }
  return { id, feito: false, codigo, motivo, request_id: requestId };
}

/**
 * Monta o request sintético para a subchamada.
 *
 * O `ctx.params` é preenchido com o id do item — é assim que a rota por
 * contato sabe de quem é a ação, e é a ÚNICA via por que o id entra nela. O
 * corpo carrega só o que a ação pede (a lista nova de etiquetas, o dono da
 * carteira); jamais organização, que vem da sessão.
 */
function requestDoItem(
  id: string,
  metodo: "GET" | "POST" | "PATCH",
  caminho: string,
  corpo?: Record<string, unknown>,
  cabecalhos?: Record<string, string>,
): NextRequest {
  const headers: Record<string, string> = { ...cabecalhos };
  if (corpo !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost/api/v1/contacts/${id}${caminho}`, {
    method: metodo,
    headers,
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
}

const ctxDoItem = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Lê o contato pelo MESMO GET da rota individual, para o merge de `tags` e de
 * `custom_fields` que as duas ações de escrita exigem.
 *
 * Por que o GET rota e não uma consulta direta: o GET já filtra pela org da
 * SESSÃO e devolve 404 para contato de outra organização — exatamente a
 * recusa por item que o relatório precisa mostrar. Consultar direto daqui
 * seria uma SEGUNDA fonte de visibilidade, com risco de divergir da rota.
 */
async function lerContatoDoItem(
  id: string,
  cabecalhos?: Record<string, string>,
): Promise<{ ok: true; tags: string[]; custom_fields: Record<string, unknown> } | { ok: false; res: Response }> {
  const res = await lerUmContato(requestDoItem(id, "GET", "", undefined, cabecalhos), ctxDoItem(id));
  if (!res.ok) return { ok: false, res };
  const corpo = (await res.json().catch(() => ({}))) as {
    data?: { tags?: string[] | null; custom_fields?: Record<string, unknown> | null };
  };
  return {
    ok: true,
    tags: corpo.data?.tags ?? [],
    custom_fields: corpo.data?.custom_fields ?? {},
  };
}

/**
 * Roda a ação escolhida no handler do CONTATO individual.
 *
 * A estreita é proposital: `lerUmContato`, `atualizarUmContato` e
 * `definirCarteira` são os `GET`/`PATCH` exportados pelas rotas irmãs, com a
 * assinatura `(req, ctx)` que elas mesmas declaram. Nenhuma regra é
 * reimplementada aqui — se a rota individual muda, o lote muda com ela no
 * mesmo commit.
 */
async function executarNoItem(
  input: BulkContactActionInput,
  id: string,
  cabecalhos?: Record<string, string>,
): Promise<Response> {
  switch (input.action) {
    case "tag": {
      const lido = await lerContatoDoItem(id, cabecalhos);
      if (!lido.ok) return lido.res;
      const marcador = normalizarTag(input.tag);
      const novos =
        input.op === "add"
          ? normalizarTags([...lido.tags, marcador])
          : normalizarTags(lido.tags.filter((t) => t !== marcador));
      // O MESMO PATCH da edição da ficha: ele audita `contact.updated` por
      // contato, emite `contact.tag_added` quando a etiqueta é nova, e a
      // policy da tabela continua sendo quem isola a escrita.
      return atualizarUmContato(requestDoItem(id, "PATCH", "", { tags: novos }, cabecalhos), ctxDoItem(id));
    }
    case "custom-field": {
      const lido = await lerContatoDoItem(id, cabecalhos);
      if (!lido.ok) return lido.res;
      // MERGE da UMA chave pedida. O PATCH substitui `custom_fields` por
      // inteiro (é assim que a tela apaga campo), então mandar só a chave nova
      // apagaria os demais campos de TODO contato do lote.
      const novos =
        input.valor === null
          ? Object.fromEntries(
              Object.entries(lido.custom_fields).filter(([chave]) => chave !== input.chave),
            )
          : { ...lido.custom_fields, [input.chave]: input.valor };
      return atualizarUmContato(
        requestDoItem(id, "PATCH", "", { custom_fields: novos }, cabecalhos),
        ctxDoItem(id),
      );
    }
    case "carteira":
      // A porta única de `contacts.carteira_user_id`: ela revalida o ator e a
      // função `fn_definir_carteira_do_cliente` valida o dono DEPOIS — gravar a
      // coluna direto seria o defeito que aquela rota existe para evitar.
      return definirCarteira(
        requestDoItem(id, "PATCH", "/carteira", {
          dono_user_id: input.dono_user_id,
          ...(input.origem ? { origem: input.origem } : {}),
        }, cabecalhos),
        ctxDoItem(id),
      );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // O portão da CHAMADA. Os handlers por item revalidam role e org — este
  // cheque existe para o `viewer` não receber N itens recusados no lugar de um
  // 403, e para nenhuma subchamada ser feita antes de saber quem está chamando.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  // Repassa o cabeçalho de autorização (Bearer ou cookie) para que as
  // subchamadas às rotas irmãs (`[id]/route`, `carteira/route`) resolvam a
  // mesma identidade em vez de reautenticar do zero.
  const cabecalhos: Record<string, string> = {};
  const authHeader = req.headers.get("authorization");
  if (authHeader) cabecalhos["authorization"] = authHeader;

  let input: BulkContactActionInput;
  try {
    input = await validateRequest(bulkContactActionSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (input.ids.length > TETO_DO_LOTE) {
    return fail(
      "bulk_too_large",
      `${t("Máximo")} ${TETO_DO_LOTE} ${t("contatos por chamada.")}`,
      422,
      { requestId },
    );
  }

  // Um item por vez, na ordem pedida: a auditoria de cada contato carrega o
  // request_id da própria subchamada, e a ordem do relatório é a ordem dos ids.
  // Nada de lote transacional: cada item acontece ou recusa sozinho.
  const resultados: ResultadoDoItem[] = [];
  // A carteira é SÓ DE SESSÃO (o PATCH de carteira usa `requireRole`, que recusa
  // o Bearer). Com token, cada item volta recusado com o motivo, em vez de cair no
  // 401 genérico da subchamada.
  const carteiraDoToken = input.action === "carteira" && authz.via === "token";
  for (const id of input.ids) {
    try {
      const res = carteiraDoToken
        ? fail(
            "carteira_so_pela_sessao",
            t("A carteira do cliente só muda pela sessão de um gerente, não por token."),
            403,
            { requestId },
          )
        : await executarNoItem(input, id, cabecalhos);
      resultados.push(await classificar(res, id));
    } catch (err) {
      // Defesa em último nível: um handler que ESTOURO em vez de responder
      // recusa o item, nunca a chamada. O lote continua para os outros ids.
      resultados.push({
        id,
        feito: false,
        codigo: "internal_error",
        motivo: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const feitos = resultados.filter((r) => r.feito).length;

  return ok(
    {
      acao: input.action,
      teto: TETO_DO_LOTE,
      total: resultados.length,
      feitos,
      recusados: resultados.length - feitos,
      resultados,
    },
    { requestId },
  );
}
