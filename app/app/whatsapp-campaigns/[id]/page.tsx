import { WhatsappCampaignDetailClient } from "./_client";

export default async function WhatsappCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WhatsappCampaignDetailClient id={id} />;
}
