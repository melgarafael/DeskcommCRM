import type { EventHandler } from "@/lib/event-log/dispatcher";
import {
  MEDIA_PERSIST_CONSUMER_KEY,
  persistMessageMedia,
} from "@/workers/media-persist-worker";

export const mediaPersistHandler: EventHandler = {
  key: MEDIA_PERSIST_CONSUMER_KEY,
  events: ["media.persist_requested"],
  handle: persistMessageMedia,
};
