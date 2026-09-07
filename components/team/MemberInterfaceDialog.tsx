"use client";
import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InterfaceEditor } from "./InterfaceEditor";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  interfaceSettingsSchema,
  interfaceTemDestino,
  lerInterface,
} from "@/lib/navigation/interface";
import type { Role } from "@/lib/auth/types";
import type { TeamMember } from "@/hooks/team/useTeamMembers";
export function MemberInterfaceDialog({
  member,
  onClose,
}: {
  member: TeamMember;
  onClose: () => void;
}) {
  const t = useT();
  const [settings, setSettings] = useState(lerInterface(member.interface_settings).settings);
  const qc = useQueryClient();
  const router = useRouter();
  const save = useMutation({
    mutationFn: () =>
      apiClient.patch(`/api/v1/team/${member.user_id}/interface`, { interface_settings: settings }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["team"] });
      router.refresh();
      toast.success(t("Interface atualizada."));
      onClose();
    },
    onError: showApiError,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Interface de")} {member.full_name ?? member.email ?? t("membro")}</DialogTitle>
          <DialogDescription>{t("A alteração vale apenas nesta organização e aparece para o membro sem sair da conta.")}</DialogDescription>
        </DialogHeader>
        {lerInterface(member.interface_settings).needsAdjustment && (
          <p role="status">{t("A seleção anterior contém áreas que não existem mais. Confira e salve novamente.")}</p>
        )}
        <InterfaceEditor
          value={settings}
          onChange={setSettings}
          role={member.role as Role}
          disabled={save.isPending}
        />
        <Button
          disabled={
            save.isPending ||
            !interfaceSettingsSchema.safeParse(settings).success ||
            !interfaceTemDestino(settings, member.role as Role)
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? t("Salvando…") : t("Salvar interface")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
