"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  /** Currently visible conversation ids in the list (for j/k nav). */
  visibleIds: string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFocusReply: () => void;
  onClaim: () => void;
  onClose: () => void;
  onToggleHelp: () => void;
  enabled?: boolean;
}

export function InboxKeyboardShortcuts({
  visibleIds,
  selectedId,
  onSelect,
  onFocusReply,
  onClaim,
  onClose,
  onToggleHelp,
  enabled = true,
}: Props) {
  const t = useT();
  const [confirmFecharOpen, setConfirmFecharOpen] = useState(false);
  // Com a confirmação aberta, os atalhos param: o `window.confirm()` travava a
  // página e ninguém trocava de conversa por trás dele. Sem isto, "e" e depois
  // "j" deixariam o "Fechar" de dentro encerrar a conversa SEGUINTE, não a que
  // estava na tela quando a pergunta foi feita.
  const ativo = enabled && !confirmFecharOpen;
  function step(delta: number) {
    if (visibleIds.length === 0) return;
    const idx = selectedId ? visibleIds.indexOf(selectedId) : -1;
    let next = idx + delta;
    if (idx < 0) next = delta > 0 ? 0 : visibleIds.length - 1;
    if (next < 0) next = 0;
    if (next >= visibleIds.length) next = visibleIds.length - 1;
    const id = visibleIds[next];
    if (id) onSelect(id);
  }

  useHotkeys("j", () => step(1), { enabled: ativo, preventDefault: true }, [
    visibleIds,
    selectedId,
  ]);
  useHotkeys("k", () => step(-1), { enabled: ativo, preventDefault: true }, [
    visibleIds,
    selectedId,
  ]);
  useHotkeys("r", () => onFocusReply(), { enabled: ativo, preventDefault: true });
  useHotkeys("a", () => onClaim(), { enabled: ativo, preventDefault: true });
  useHotkeys(
    "e",
    () => setConfirmFecharOpen(true),
    { enabled: ativo, preventDefault: true },
  );
  useHotkeys("shift+/", () => onToggleHelp(), { enabled: ativo, preventDefault: true });

  return (
    <AlertDialog open={confirmFecharOpen} onOpenChange={setConfirmFecharOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Fechar conversa?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("O atendimento é encerrado. Se o cliente escrever de novo, você pode reabrir.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction onClick={onClose}>{t("Fechar")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
