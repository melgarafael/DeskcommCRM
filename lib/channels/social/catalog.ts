/** Networks offered by the partner. Inbox support is deliberately narrower than OAuth. */
export const SOCIAL_NETWORKS = [
  { id: "instagram", label: "Instagram", inbox: true },
  { id: "facebook", label: "Facebook", inbox: true },
  { id: "linkedin", label: "LinkedIn", inbox: false },
  { id: "twitter", label: "X", inbox: false },
  { id: "tiktok", label: "TikTok", inbox: false },
  { id: "youtube", label: "YouTube", inbox: false },
  { id: "threads", label: "Threads", inbox: false },
  { id: "reddit", label: "Reddit", inbox: false },
  { id: "pinterest", label: "Pinterest", inbox: false },
  { id: "bluesky", label: "Bluesky", inbox: false },
  { id: "googlebusiness", label: "Google Business", inbox: false },
  { id: "telegram", label: "Telegram", inbox: false },
  { id: "snapchat", label: "Snapchat", inbox: false },
  { id: "discord", label: "Discord", inbox: false },
  { id: "slack", label: "Slack", inbox: false },
] as const;
export type SocialPlatform = (typeof SOCIAL_NETWORKS)[number]["id"];
export const SOCIAL_PROVIDER_LABEL = "Zernio";
export const SOCIAL_PROVIDER = "zernio_social" as const;
export const inboxSupported = (platform: string): boolean =>
  SOCIAL_NETWORKS.some((network) => network.id === platform && network.inbox);
export function socialMessageId(account: string, id: string): string {
  return `social:${account}:${id}`;
}
