"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Readiness = {
  total_advomax: number;
  total_crm: number;
  prontos: number;
  sem_membership_crm: string[];
  ausente_na_gestao: string[];
  perfil_divergente: string[];
};

export function AdvomaxTeamReadiness() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["advomax", "team-readiness"],
    queryFn: () => apiClient.get<{ data: Readiness }>("/api/v1/advomax/equipe/prontidao"),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const readiness = data?.data;
  if (isLoading) return <p className="text-sm text-muted-foreground">Verificando integração da equipe…</p>;
  if (isError || !readiness) return null;
  const pendencias = readiness.sem_membership_crm.length + readiness.ausente_na_gestao.length + readiness.perfil_divergente.length;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Equipe conectada ao Advomax</CardTitle>
          <Badge variant={pendencias === 0 ? "default" : "outline"}>{pendencias === 0 ? "Pronta" : `${pendencias} pendência(s)`}</Badge>
        </div>
        <CardDescription>{readiness.prontos} de {readiness.total_advomax} usuários ativos do Gestão estão prontos no CRM.</CardDescription>
      </CardHeader>
      {pendencias > 0 ? (
        <CardContent className="space-y-3 text-sm">
          {readiness.sem_membership_crm.length > 0 ? <p><strong>Sem acesso ao CRM:</strong> {readiness.sem_membership_crm.join(", ")}</p> : null}
          {readiness.ausente_na_gestao.length > 0 ? <p><strong>Ausentes ou inativos no Gestão:</strong> {readiness.ausente_na_gestao.join(", ")}</p> : null}
          {readiness.perfil_divergente.length > 0 ? <p><strong>Administrador com papel divergente:</strong> {readiness.perfil_divergente.join(", ")}</p> : null}
          <p className="text-muted-foreground">As divergências são informativas. O CRM não cria contas nem eleva permissões automaticamente.</p>
        </CardContent>
      ) : null}
    </Card>
  );
}
