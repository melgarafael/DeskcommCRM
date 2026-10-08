"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TenantForm } from "@/app/app/settings/tenant/_form";
import { useUpdateTenantData } from "@/hooks/useUpdateTenantData";
import type { TenantOrganization } from "@/hooks/useTenantDetail";
import { useT } from "@/hooks/i18n/useT";
import type { TenantInput } from "@/lib/schemas/settings";

interface EditTenantDialogProps {
  open: boolean;
  onClose: () => void;
  organization: TenantOrganization;
}

/** Os valores atuais do tenant no formato do `TenantForm` (mesmo schema de Configurações › Empresa). */
function valoresIniciais(o: TenantOrganization): TenantInput {
  return {
    display_name: o.display_name,
    // Vazia fica vazia: o formulário exige a razão social e o admin a preenche.
    legal_name: o.legal_name ?? "",
    cnpj: o.cnpj,
    country: o.country ?? "BR",
    timezone: o.timezone ?? "America/Sao_Paulo",
    locale: (o.locale ?? "pt-BR") as TenantInput["locale"],
    currency: (o.currency ?? "BRL") as TenantInput["currency"],
    media_retention_days: o.media_retention_days ?? 180,
    // `true` é o padrão do banco (0557): ligado salvo quem desligou.
    media_retention_enforced: o.media_retention_enforced ?? true,
    dpo_email: o.dpo_email,
    privacy_policy_url: o.privacy_policy_url,
  };
}

/**
 * Edição dos dados cadastrais pelo admin da plataforma: o MESMO formulário que
 * o admin do tenant usa em Configurações › Empresa, gravando pela rota do admin.
 * O e-mail de login das pessoas não é dado da empresa — ele se troca na lista
 * de membros, ao lado.
 */
export function EditTenantDialog({ open, onClose, organization }: EditTenantDialogProps) {
  const t = useT();
  const salvar = useUpdateTenantData(organization.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(aberto) => {
        if (!aberto) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Editar dados do tenant")}</DialogTitle>
          <DialogDescription>
            {t("Os mesmos dados que o administrador da empresa vê em Configurações › Empresa.")}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <TenantForm initial={valoresIniciais(organization)} onSave={salvar} onSaved={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}
