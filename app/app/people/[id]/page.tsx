import { PersonDetailClient } from "./_client";

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PersonDetailClient id={id} />;
}
