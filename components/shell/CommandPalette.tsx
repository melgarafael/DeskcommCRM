"use client";
import { useMemo } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useAgentsList } from "@/hooks/ai/useAgents";
import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";
import { usePipelinesDaPaleta } from "@/hooks/pipelines/usePipelinesDaPaleta";
import { roleAtLeast } from "@/lib/auth/types";
import { NAV_GROUPS, searchable } from "@/lib/navigation/registry";
import {
  GRUPOS_DE_ITENS_DA_BUSCA,
  itensDaBusca,
  type GrupoDeItensDaBusca,
} from "@/lib/navigation/itens-da-paleta";
import { FlowArrow, Funnel, Robot } from "@/lib/ui/icons";
import { PaletaDeDestinos, type DestinoDaPaleta } from "@/components/shell/PaletaDeDestinos";

/**
 * Paleta de busca do topo (⌘K) do APP DO TENANT.
 *
 * A UI, o filtro e o teclado moram em `PaletaDeDestinos` desde que o painel do
 * administrador passou a precisar da mesma busca. O que sobra aqui é a FONTE
 * deste lado:
 *
 *   - `searchable(...)`, que filtra o registro de `lib/navigation/registry.ts`
 *     pelo que este usuário/empresa pode ver;
 *   - os ITENS das três listas que a comunidade não achava (#4593): funis,
 *     fluxos de follow-up e agentes de IA, montados por
 *     `lib/navigation/itens-da-paleta.ts`.
 *
 * ─── Por que os itens passaram a entrar ────────────────────────────────────
 *
 * A v1 buscava só NAVEGAÇÃO, e o texto estava escrito aqui. Na prática, quem
 * tinha treze fluxos de retomada digitava o nome do fluxo, via «nenhum
 * resultado» e concluía que a busca do sistema não funcionava — o destino
 * existia, o item não.
 *
 * ─── Quem vê o quê ────────────────────────────────────────────────────────
 *
 * Cada fonte só é consultada quando a TELA dela está entre os destinos visíveis
 * (é o mesmo `searchable` que decide o menu) e quando a rota aceita o papel:
 *
 *   - fluxos e agentes: rota autenticada, recorte por RLS;
 *   - funis: `GET /api/v1/pipelines` exige `manager` — para `agent`/`viewer` a
 *     consulta nem sai, e o grupo não aparece. Ver a nota no hook.
 *
 * As leituras só acontecem com a paleta ABERTA (`enabled`): a casca monta esta
 * paleta em toda página, e três listas por navegação seria caro por nada.
 */
const ICONE_DO_GRUPO: Record<GrupoDeItensDaBusca, typeof Funnel> = {
  funis: Funnel,
  followups: FlowArrow,
  agentes: Robot,
};

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { user, activeOrg } = useAuth();

  const visiveis = useMemo(
    () =>
      searchable(
        user.is_platform_admin && !user.support,
        activeOrg?.role ?? null,
        activeOrg?.interface_settings,
        activeOrg?.modulos_ligados ?? [],
        activeOrg?.capacidades_ligadas ?? [],
      ),
    [
      user.is_platform_admin,
      user.support,
      activeOrg?.role,
      activeOrg?.interface_settings,
      activeOrg?.modulos_ligados,
      activeOrg?.capacidades_ligadas,
    ],
  );

  const { podeVerFunis, podeVerFluxos, podeVerAgentes } = useMemo(
    () => ({
      podeVerFunis: visiveis.some((d) => d.href === "/app/kanban"),
      podeVerFluxos: visiveis.some((d) => d.href === "/app/ai/followups"),
      podeVerAgentes: visiveis.some((d) => d.href === "/app/ai/agents"),
    }),
    [visiveis],
  );

  const funis = usePipelinesDaPaleta(
    open && podeVerFunis && roleAtLeast(activeOrg?.role ?? null, "manager"),
  );
  const fluxos = useFollowupFlows({ enabled: open && podeVerFluxos });
  const agentes = useAgentsList({ enabled: open && podeVerAgentes });

  const destinos = useMemo<DestinoDaPaleta[]>(() => {
    const itens = itensDaBusca({
      funis: funis.data ?? [],
      fluxos: fluxos.data ?? [],
      agentes: agentes.data ?? [],
    });
    return [...visiveis, ...itens.map((item) => ({ ...item, icon: ICONE_DO_GRUPO[item.group] }))];
  }, [visiveis, funis.data, fluxos.data, agentes.data]);

  return (
    <PaletaDeDestinos
      open={open}
      onOpenChange={onOpenChange}
      destinos={destinos}
      grupos={[...NAV_GROUPS, ...GRUPOS_DE_ITENS_DA_BUSCA]}
      titulo={t("Buscar no sistema")}
      rotuloLista={t("Resultados")}
      placeholder={t(
        "Buscar telas, funis, fluxos e agentes (ex: kanban, prospecção, retomada, whatsapp)…",
      )}
    />
  );
}
