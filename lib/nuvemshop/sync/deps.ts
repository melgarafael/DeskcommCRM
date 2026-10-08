/**
 * O que os handlers e o início precisam do mundo. Interface para os testes
 * trocarem banco e rede por dublês; `depsReais()` liga ao Supabase e à API.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { NuvemshopApiClient } from "@/lib/nuvemshop/api-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENTO_SYNC_PAGE, type OrigemDoRun, type PassoDoSync } from "./constantes";
import { marcarIntegracaoDesautorizada } from "./desautorizada";
import { fecharRun, lerEstado, liberarRun, registrarPagina, reservarRun, type EstadoDoSync } from "./estado";
import { gravarPedido, type ResultadoDaGravacao } from "./gravar-pedido";
import { carregarIntegracao, type IntegracaoCarregada } from "./integracao";

export interface ApiDePedidos {
  listOrders: NuvemshopApiClient["listOrders"];
  getOrder: NuvemshopApiClient["getOrder"];
}

export interface DepsDoSync {
  lerEstado(orgId: string): Promise<EstadoDoSync | null>;
  carregarIntegracao(orgId: string): Promise<IntegracaoCarregada | null>;
  api(integ: IntegracaoCarregada): ApiDePedidos;
  gravarPedido(orgId: string, storeId: string, bruto: unknown): Promise<ResultadoDaGravacao>;
  reservarRun(orgId: string, args: { passo: PassoDoSync; origem: OrigemDoRun; agora: Date; forcar: boolean }): Promise<boolean>;
  registrarPagina(estado: EstadoDoSync, args: { gravados: number; comErro: number; ultimoErro: string | null; passo: PassoDoSync; agora: Date }): Promise<void>;
  fecharRun(estado: EstadoDoSync, agora: Date): Promise<EstadoDoSync | null>;
  liberarRun(orgId: string, runId: string | null): Promise<void>;
  emitirPasso(orgId: string, integracaoId: string, passo: PassoDoSync): Promise<void>;
  desautorizar(integ: IntegracaoCarregada): Promise<void>;
  auditar(entry: Parameters<typeof audit>[0]): Promise<void>;
  novoRunId(): string;
  agora(): Date;
}

export function depsReais(admin: SupabaseClient = createAdminClient()): DepsDoSync {
  return {
    lerEstado: (orgId) => lerEstado(admin, orgId),
    carregarIntegracao: (orgId) => carregarIntegracao(admin, orgId),
    api: (integ) => new NuvemshopApiClient({ storeId: integ.storeId, accessToken: integ.accessToken }),
    gravarPedido: (orgId, storeId, bruto) => gravarPedido(admin, { orgId, storeId }, bruto),
    reservarRun: (orgId, args) => reservarRun(admin, orgId, args),
    registrarPagina: (estado, args) => registrarPagina(admin, estado, args),
    fecharRun: (estado, agora) => fecharRun(admin, estado, agora),
    liberarRun: (orgId, runId) => liberarRun(admin, orgId, runId),
    emitirPasso: async (orgId, integracaoId, passo) => {
      const { error } = await admin.rpc("emit_event", {
        p_event_type: "nuvemshop.sync_page",
        p_entity_kind: "tenant_integration",
        p_entity_id: integracaoId,
        p_payload: passo as unknown as Record<string, unknown>,
        p_metadata: { run_id: passo.run_id, pagina: passo.pagina },
        p_organization_id: orgId,
      });
      if (error) throw new Error(`emit_${EVENTO_SYNC_PAGE}:${error.message}`);
    },
    desautorizar: (integ) => marcarIntegracaoDesautorizada(admin, integ),
    auditar: (entry) => audit(entry),
    novoRunId: () => randomUUID(),
    agora: () => new Date(),
  };
}
