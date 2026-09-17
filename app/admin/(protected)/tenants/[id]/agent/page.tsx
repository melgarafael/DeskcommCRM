import { TenantAgentClient } from "./_client";

interface TenantAgentPageProps {
  params: Promise<{ id: string }>;
}

export default async function TenantAgentPage({ params }: TenantAgentPageProps) {
  const { id } = await params;
  return <TenantAgentClient id={id} />;
}
