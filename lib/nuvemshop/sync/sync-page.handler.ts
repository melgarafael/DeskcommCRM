/**
 * `nuvemshop-sync.v1` — UMA página da API por evento (spec §4.1).
 *
 * Um handler que percorresse todas as páginas cairia na detecção de evento
 * preso do dreno e recomeçaria do zero. Aqui cada página é um evento: o dreno
 * dá retry, backoff, `retry` sem contar tentativa (429) e aviso de evento morto.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { EVENTO_SYNC_PAGE, PAGINA_TAMANHO, passoDoSyncSchema } from "./constantes";
import { depsReais, type DepsDoSync } from "./deps";
import { tratarErroDaApi } from "./erro-da-api";
import { proximoPasso } from "./janelas";

const KEY = "nuvemshop-sync.v1";
const r = (status: HandlerResult["status"], detail: string): HandlerResult => ({ consumer_key: KEY, status, detail });

export async function processarPaginaDoSync(row: EventRow, deps: DepsDoSync): Promise<HandlerResult> {
  const parsed = passoDoSyncSchema.safeParse(row.payload);
  if (!parsed.success) return r("skipped", "payload_invalido");
  const passo = parsed.data;
  const orgId = row.organization_id;

  const estado = await deps.lerEstado(orgId);
  if (!estado || estado.status !== "running" || estado.run_id !== passo.run_id) return r("skipped", "run_obsoleto");

  const integ = await deps.carregarIntegracao(orgId);
  if (!integ || integ.status !== "healthy") {
    await deps.liberarRun(orgId, passo.run_id);
    return r("skipped", "integracao_inativa");
  }

  let itens: unknown[];
  try {
    itens = await deps.api(integ).listOrders({
      updatedAtMin: passo.janela_ini,
      updatedAtMax: passo.janela_fim,
      page: passo.pagina,
      perPage: PAGINA_TAMANHO,
    });
  } catch (err) {
    return tratarErroDaApi(err, integ, deps, KEY);
  }

  let gravados = 0;
  let comErro = 0;
  let ultimoErro: string | null = null;
  for (const bruto of itens) {
    const g = await deps.gravarPedido(orgId, integ.storeId, bruto);
    if (g.ok) gravados++;
    else {
      comErro++;
      ultimoErro = g.motivo;
    }
  }

  const prox = proximoPasso(passo, itens.length);
  if (prox.perda) {
    comErro++;
    ultimoErro = "janela_indivisivel";
  }
  await deps.registrarPagina(estado, { gravados, comErro, ultimoErro, passo, agora: deps.agora() });

  if (prox.tipo === "pagina") {
    await deps.emitirPasso(orgId, integ.id, prox.passo);
    return r("ok", `pagina_${passo.pagina}:${gravados}`);
  }

  const fechado = await deps.fecharRun({ ...estado, alvo_fim: passo.alvo_fim }, deps.agora());
  if (fechado && fechado.pedidos_gravados > 0) {
    await deps.auditar({
      action: "nuvemshop.sync_completed",
      organizationId: orgId,
      resourceType: "tenant_integration",
      resourceId: integ.id,
      metadata: { run_id: passo.run_id, pedidos_gravados: fechado.pedidos_gravados, pedidos_com_erro: fechado.pedidos_com_erro },
    });
  }
  return r("ok", "run_concluido");
}

export const nuvemshopSyncHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: [EVENTO_SYNC_PAGE],
  handle: (row) => processarPaginaDoSync(row, depsReais()),
};
