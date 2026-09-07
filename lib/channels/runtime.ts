import type pg from "pg";
import type { ChannelAdapter } from "../agent-engine/channel-adapter";
import type { CrmEdgeConfig } from "../agent-engine/edge/crm/mcp-client";
import { WahaChannelAdapter } from "../agent-engine/edge/channel/waha-adapter";

export type RuntimeSendChannel = Pick<ChannelAdapter, "send">;

/**
 * Ponte de envio pelo ledger e handler existentes. O handler resolve o provider
 * da conversa; capacidades e saúde do adapter legado não fazem parte desta porta.
 */
export function createRuntimeSendChannel(
  pool: pg.Pool,
  config: CrmEdgeConfig,
): RuntimeSendChannel {
  const adapter = new WahaChannelAdapter(pool, config);
  return { send: (input) => adapter.send(input) };
}
