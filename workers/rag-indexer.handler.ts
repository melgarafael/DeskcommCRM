/**
 * Adapter that exposes `rag-indexer` to the event_log dispatcher.
 *
 * Kept separate from the worker pipeline file so unit tests can import
 * `processRagIndexer` directly without pulling in the dispatcher registry.
 */

import type { EventHandler } from "@/lib/event-log/dispatcher";
import { processRagIndexer } from "@/workers/rag-indexer";

export const RAG_INDEXER_HANDLER_KEY = "rag-indexer.v1";

export const ragIndexerHandler: EventHandler = {
  key: RAG_INDEXER_HANDLER_KEY,
  naOrgParada: "pula",
  events: ["nuvemshop.product_synced", "knowledge_source.updated"],
  handle: processRagIndexer,
};
