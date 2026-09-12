"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { decideJoinRegistration, decideOrganizationRegistration } from "@/app/actions/registration/decide";

type Request = { id: string; user_id: string; email: string | null; requested_organization_name?: string | null; created_at: string };

export function RegistrationRequestsClient({ title, empty, requests, mode }: { title: string; empty: string; requests: Request[]; mode: "organization" | "join" }) {
  const [pending, startTransition] = useTransition();
  const decide = (requestId: string, decision: "approve" | "reject") => startTransition(async () => {
    const result = mode === "organization" ? await decideOrganizationRegistration({ requestId, decision }) : await decideJoinRegistration({ requestId, decision });
    if (result.ok) toast.success(decision === "approve" ? "Solicitação aprovada." : "Solicitação recusada.");
    else toast.error(result.error);
  });
  return <section className="space-y-4"><header><h2 className="text-lg font-semibold">{title}</h2><p className="text-sm text-muted-foreground">A aprovação concede acesso somente após a decisão explícita.</p></header>{requests.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="space-y-2">{requests.map((request) => <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><p className="font-medium">{request.email ?? request.user_id.slice(0, 8)}</p>{request.requested_organization_name ? <p className="text-sm text-muted-foreground">Empresa: {request.requested_organization_name}</p> : null}</div><div className="flex gap-2"><Button size="sm" disabled={pending} onClick={() => decide(request.id, "approve")}>Aprovar</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => decide(request.id, "reject")}>Recusar</Button></div></li>)}</ul>}</section>;
}
