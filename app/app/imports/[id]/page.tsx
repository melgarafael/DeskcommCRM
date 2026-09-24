import { ImportDetailClient } from "./_client";

export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ImportDetailClient id={id} />;
}
