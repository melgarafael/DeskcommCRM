"use client";
import { useMemo } from "react";

import { PaletaDeDestinos } from "@/components/shell/PaletaDeDestinos";
import { useT } from "@/hooks/i18n/useT";
import { ADMIN_GROUPS, destinosDoAdmin } from "@/lib/admin/navegacao";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

/**
 * Paleta de navegação (⌘K) do PAINEL DO ADMINISTRADOR.
 *
 * Irmã de `components/shell/CommandPalette.tsx`: mesma UI, mesma tecla, outra
 * fonte. Aqui não existe `useAuth()` — o admin roda numa árvore sem
 * `AuthProvider` (`app/admin/(protected)/layout.tsx`) e a lista vem do
 * servidor/estado local da instalação, não da empresa ativa.
 *
 * Sem esta busca, as 20 telas do painel só se alcançam pela sidebar, por
 * reconhecimento visual — e onze delas são configuração de instalação que a
 * pessoa abre de mês em mês (Marca, Credenciais, SMTP, Módulos…).
 */
export function AdminCommandPalette({
  open,
  onOpenChange,
  modulosLigados = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Entradas com `modulo` só aparecem com ele ligado. Padrão: nenhum. */
  modulosLigados?: readonly ModuloOpcional[];
}) {
  const t = useT();
  const destinos = useMemo(() => destinosDoAdmin(modulosLigados), [modulosLigados]);

  return (
    <PaletaDeDestinos
      open={open}
      onOpenChange={onOpenChange}
      destinos={destinos}
      grupos={ADMIN_GROUPS}
      titulo={t("Buscar telas da instalação")}
      rotuloLista={t("Telas da instalação")}
      placeholder={t(
        "Buscar telas da instalação (ex: credenciais, smtp, módulos, lgpd)...",
      )}
    />
  );
}
