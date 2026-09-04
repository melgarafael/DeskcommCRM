"use client";

import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import type { AdminConversationDetailResponse } from "@/hooks/useAdminConversation";
import { Buildings, Phone, ArrowRight } from "@/lib/ui/icons";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  data: AdminConversationDetailResponse;
}

function maskEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const [local, domain] = email.split("@");
  if (!local || !domain) return "—";
  const visible = local.length > 3 ? `${local.slice(0, 3)}***` : "***";
  return `${visible}@${domain}`;
}

export function AdminSidePanel({ data }: Props) {
  const t = useT();
  const { contact, organization } = data;

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-muted/20 px-4 py-4">
      {/* ── Contact info ── */}
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Contato
        </h3>
        {contact ? (
          <div className="flex flex-col gap-1.5 text-sm">
            <div className="font-medium">
              {contact.is_anonymized ? (
                <span className="italic text-muted-foreground">Contato anonimizado</span>
              ) : (
                contact.name ?? t("Sem nome")
              )}
            </div>
            {contact.phone_number && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Phone size={12} weight="duotone" aria-hidden />
                {phoneForDisplay(contact.phone_number)}
              </div>
            )}
            {contact.email && (
              <div className="text-xs text-muted-foreground">{maskEmail(contact.email)}</div>
            )}
            {contact.is_blocked && (
              <span className="inline-block rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                Bloqueado
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("Sem contato vinculado.")}</p>
        )}
      </section>

      {/* ── Tenant info ── */}
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tenant
        </h3>
        {organization ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
              <Buildings size={14} weight="duotone" className="shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-medium">{organization.display_name}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Slug: <span className="font-mono">{organization.slug}</span>
            </div>
            <div className="text-xs capitalize text-muted-foreground">
              Status: {organization.status}
            </div>
            <Link
              href={`/admin/tenants/${organization.id}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Abrir tenant <ArrowRight size={12} aria-hidden />
            </Link>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("Sem organização vinculada.")}</p>
        )}
      </section>
    </aside>
  );
}
