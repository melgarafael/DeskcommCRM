import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DA_CARGA, type Carga } from "@/lib/schemas/expedicao";
import { COLUNAS_DO_PEDIDO, type PedidoComercial } from "@/lib/schemas/pedidos";
import { createClient } from "@/lib/supabase/server";

import { ExpedicaoClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * A EXPEDIÇÃO — cargas do transporte próprio (ATT.txt Fase 3).
 *
 * A lista de cargas + os pedidos embarcáveis (aprovado/faturado) para montar
 * a próxima. Criar carga é `agent` para cima.
 */
export default async function ExpedicaoPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeCriar = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;

  const supabase = await createClient();
  const [{ data: cargas }, { data: embarcaveis }] = await Promise.all([
    supabase
      .from("shipments")
      .select(COLUNAS_DA_CARGA)
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("commercial_orders")
      .select(COLUNAS_DO_PEDIDO)
      .eq("organization_id", activeOrg.orgId)
      // Só aprovado/faturado: quem embarcou virou `expedido` e saiu da fila
      // sozinho (a rota avança no POST da carga).
      .in("status", ["aprovado", "faturado"])
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  return (
    <ExpedicaoClient
      inicial={(cargas ?? []) as unknown as Carga[]}
      embarcaveis={(embarcaveis ?? []) as unknown as PedidoComercial[]}
      podeCriar={podeCriar}
      textos={{
        titulo: t("Expedição"),
        subtitulo: t("Cargas do transporte próprio e pedidos aguardando embarque."),
        nova: t("Nova carga"),
        cargas: t("Cargas"),
        vazias: t("Nenhuma carga ainda"),
        embarcaveis: t("Aguardando embarque"),
        nenhumEmbarcavel: t("Nenhum pedido aprovado aguardando embarque."),
        placa: t("Placa"),
        veiculo: t("Veículo"),
        motorista: t("Motorista"),
        criar: t("Criar carga"),
        verRomaneio: t("Romaneio + fechamento"),
      }}
    />
  );
}
