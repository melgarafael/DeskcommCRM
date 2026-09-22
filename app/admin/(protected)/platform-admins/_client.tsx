"use client";
import { DBAOnlyNotice } from "@/components/admin/platform-admins/DBAOnlyNotice";
import {
  PlatformAdminsTable,
  PlatformAdminsTableSkeleton,
} from "@/components/admin/platform-admins/PlatformAdminsTable";
import { useAdminPlatformAdmins } from "@/hooks/useAdminPlatformAdmins";
import { useT } from "@/hooks/i18n/useT";

export function PlatformAdminsClient() {
  const t = useT();
  const { data, isLoading, isError } = useAdminPlatformAdmins();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-medium text-text tracking-tight">{t("Platform Admins")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Administradores com acesso privilegiado à plataforma")}
        </p>
      </div>

      {/* T-04 Notice — proeminente, antes da tabela */}
      <DBAOnlyNotice />

      {/* Table */}
      {isLoading ? (
        <PlatformAdminsTableSkeleton />
      ) : isError ? (
        <div className="flex items-center justify-center rounded-lg border py-12 text-sm text-muted-foreground">
          {t("Erro ao carregar platform admins. Tente recarregar.")}
        </div>
      ) : (
        <PlatformAdminsTable data={data ?? []} />
      )}
    </div>
  );
}
