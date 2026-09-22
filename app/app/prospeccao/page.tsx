import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { CATEGORIAS_COMERCIAIS } from "@/lib/prospeccao/categorias";
import { METADADOS_PROVIDERS } from "@/lib/prospeccao/providers/registro";
import { createClient } from "@/lib/supabase/server";

import { ProspeccaoClient, type BuscaResumo } from "./_client";

export const dynamic = "force-dynamic";

/**
 * A PROSPECÇÃO B2B — descobrir empresas por região/categoria e levar ao CRM.
 *
 * Uma tela com abas (Buscar, Pesquisas, e nas próximas entregas: Empresas,
 * Mapa, Mercado, Campanhas, Config). A biblioteca de categorias e os
 * metadados de providers vêm do servidor (sem segredo no cliente).
 */
export default async function ProspeccaoPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeBuscar =
    user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const podeGerenciar =
    user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const { data: buscas } = await supabase
    .from("prospecting_searches")
    .select(
      "id, categorias, cidade, estado, raio_km, max_empresas, provider, status, " +
        "total_celulas, celulas_processadas, encontradas, novas, duplicadas, erros, " +
        "requisicoes, custo_estimado_cents, ultimo_erro, created_at, finished_at",
    )
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <ProspeccaoClient
      buscasIniciais={(Array.isArray(buscas) ? buscas : []) as unknown as BuscaResumo[]}
      categorias={CATEGORIAS_COMERCIAIS}
      providers={METADADOS_PROVIDERS}
      podeBuscar={podeBuscar}
      podeGerenciar={podeGerenciar}
      textos={{
        titulo: t("Prospecção"),
        subtitulo: t("Encontre empresas por região e categoria e leve ao CRM."),
        abaBuscar: t("Nova busca"),
        abaPesquisas: t("Pesquisas"),
        abaEmpresas: t("Empresas"),
        abaMercado: t("Mercado"),
        abaCampanhas: t("Campanhas"),
        abaConfig: t("Configuração"),
        categorias: t("Categorias"),
        cidade: t("Cidade"),
        estado: t("UF"),
        raio: t("Raio (km)"),
        maximo: t("Máximo de empresas"),
        provedor: t("Provider"),
        buscar: t("Buscar empresas"),
        buscando: t("Criando busca…"),
        progresso: t("Progresso"),
        celulas: t("Células"),
        encontradas: t("Encontradas"),
        novas: t("Novas"),
        duplicadas: t("Duplicadas"),
        erros: t("Erros"),
        custo: t("Custo estimado"),
        verEmpresas: t("Ver empresas"),
        pausar: t("Pausar"),
        continuar: t("Continuar"),
        cancelar: t("Cancelar"),
        vazias: t("Nenhuma busca ainda — crie a primeira acima."),
        buscaCriada: t("Busca criada — o coletor começa em até 1 minuto"),
        reutilizada: t("Busca recente reutilizada (dentro do TTL)"),
        exemploCidade: t("Ex.: Canoinhas"),
      }}
    />
  );
}
