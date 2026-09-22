import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { CargaClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * O DETALHE DA CARGA — rota de entrega, desfechos e romaneio.
 */
export default async function CargaPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeOperar =
    user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const podeExcluir =
    user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const { id } = await params;
  const supabase = await createClient();
  const { data: carga } = await supabase
    .from("shipments")
    .select("id, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!carga) notFound();

  return (
    <CargaClient
      cargaId={id}
      podeOperar={podeOperar}
      podeExcluir={podeExcluir}
      textos={{
        voltar: t("Voltar para expedição"),
        rota: t("Ordem de entrega"),
        romaneio: t("Romaneio e fechamento (PDF)"),
        totalMercadorias: t("Total em mercadorias"),
        aCobrar: t("A cobrar na entrega"),
        paradasConcluidas: t("Paradas concluídas"),
        sairRota: t("Sair para rota"),
        concluir: t("Concluir carga"),
        entregue: t("Entregue"),
        devolvido: t("Devolvido"),
        semEndereco: t("Endereço não informado"),
        verComprovante: t("Ver comprovante"),
        escolherFoto: t("Escolher foto da entrega"),
        excluirCarga: t("Excluir romaneio"),
        confirmarExcluir: t("Excluir este romaneio? Os pedidos voltam para a fila de embarque."),
        tirarDaCarga: t("Tirar da carga"),
        mapaRota: t("Mapa da rota"),
        modoOperador: t("Operador"),
        modoMotorista: t("Motorista"),
        cheguei: t("Cheguei"),
        motivo: t("Motivo da devolução"),
        confirmar: t("Confirmar"),
        cancelar: t("Cancelar"),
      }}
    />
  );
}
