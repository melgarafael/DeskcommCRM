import type { EventHandler } from "@/lib/event-log/dispatcher";
import { MEDIA_DERIVE_CONSUMER_KEY, deriveMessageMedia } from "@/workers/media-derive-worker";

export const mediaDeriveHandler: EventHandler = {
  key: MEDIA_DERIVE_CONSUMER_KEY,
  naOrgParada: "pula",
  events: ["media.derive_requested"],
  handle: deriveMessageMedia,
};
