import { CompanyDetailClient } from "./_client";

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CompanyDetailClient id={id} />;
}
