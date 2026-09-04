"use client";
import { Skeleton } from "@/components/ui/skeleton";
import { useTenantDetail } from "@/hooks/useTenantDetail";
import { TenantOverview } from "@/components/admin/tenants/TenantOverview";
import { TenantActions } from "@/components/admin/tenants/TenantActions";
import { SuspendedBanner } from "@/components/admin/tenants/SuspendedBanner";

interface TenantOverviewClientProps {
  id: string;
}

export function TenantOverviewClient({ id }: TenantOverviewClientProps) {
  const { data, isLoading, isError } = useTenantDetail(id);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full rounded-lg" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">
        Não foi possível carregar os dados do tenant. Tente recarregar a página.
      </div>
    );
  }

  const { organization, counts } = data.data;

  return (
    <div className="space-y-6">
      {organization.status === "suspended" && organization.suspended_at && (
        <SuspendedBanner suspendedAt={organization.suspended_at} />
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <TenantOverview organization={organization} counts={counts} />
        <TenantActions
          organizationId={organization.id}
          status={organization.status}
          displayName={organization.display_name}
        />
      </div>
    </div>
  );
}
