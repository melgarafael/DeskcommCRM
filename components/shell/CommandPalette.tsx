"use client";
import { useMemo } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { GRUPO_DOS_MODULOS, NAV_GROUPS, searchable } from "@/lib/navigation/registry";
import { PaletaDeDestinos } from "@/components/shell/PaletaDeDestinos";

/**
 * Paleta de navegação (⌘K) do APP DO TENANT.
 *
 * A UI, o filtro e o teclado moram em `PaletaDeDestinos` desde que o painel do
 * administrador passou a precisar da mesma busca. O que sobra aqui é só a
 * FONTE deste lado: `searchable(...)`, que filtra o registro de
 * `lib/navigation/registry.ts` pelo que este usuário/empresa pode ver.
 *
 * v1 busca só NAVEGAÇÃO — os destinos do registro. Contato, conversa e lead têm
 * outra fonte de dados e são outra feature.
 */
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
        activeOrg?.modulos_conectados ?? [],
      ),
    [
      user.is_platform_admin,
      user.support,
      activeOrg?.role,
      activeOrg?.interface_settings,
      activeOrg?.modulos_ligados,
      activeOrg?.capacidades_ligadas,
      activeOrg?.modulos_conectados,
    ],
  );

  // O grupo "Módulos" é gerado: entra no fim da lista de categorias e só aparece com destino nele.
  const grupos = useMemo(() => [...NAV_GROUPS, GRUPO_DOS_MODULOS], []);

  return (
    <PaletaDeDestinos
      open={open}
      onOpenChange={onOpenChange}
      destinos={visiveis}
      grupos={grupos}
      titulo={t("Buscar telas")}
      rotuloLista={t("Telas")}
      placeholder={t(
        "Buscar por nome, objetivo ou função (ex: leads, agenda, prompt, whatsapp)...",
      )}
    />
  );
}
