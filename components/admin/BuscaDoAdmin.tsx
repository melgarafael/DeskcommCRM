"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { AdminCommandPalette } from "./AdminCommandPalette";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

/**
 * O gatilho da busca no painel do administrador — botão + ⌘K/Ctrl+K.
 *
 * Espelha `components/shell/SearchTrigger.tsx` (do tenant) de propósito: a
 * MESMA pessoa usa os dois modos, e atalho diferente em cada um é atrito sem
 * motivo. O `kbd` é o mesmo par `⌘K`.
 *
 * `enableOnFormTags`: o atalho tem de funcionar com o cursor dentro de um campo
 * — as telas de configuração do painel são quase todas formulário (SMTP,
 * credenciais, marca), e é exatamente ali que a pessoa quer pular para outra
 * tela sem largar o teclado.
 */
export function BuscaDoAdmin({
  modulosLigados = [],
}: {
  modulosLigados?: readonly ModuloOpcional[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
        // O rótulo visível some no celular (só o ícone cabe na barra), então o
        // nome acessível precisa existir fora do texto escondido.
        aria-label={t("Buscar telas da instalação")}
      >
        <MagnifyingGlass size={14} aria-hidden />
        <span className="max-lg:sr-only">{t("Buscar...")}</span>
        <kbd className="ml-2 hidden rounded-md border bg-muted px-1.5 py-0.5 text-[10px] lg:inline">
          ⌘K
        </kbd>
      </Button>
      <AdminCommandPalette open={open} onOpenChange={setOpen} modulosLigados={modulosLigados} />
    </>
  );
}
