export const PILOT_ASSISTANT_ID = "internal-assistant";

export type PilotChannel = "crm" | "desktop" | "telegram";
export type PilotOperation =
  | "review_conversations"
  | "reply_message"
  | "check_availability"
  | "schedule_meeting"
  | "bulk_transfer";

export type PilotIdentity = {
  userId: string;
  tenantId: string;
  assistantId: string;
};

export type PilotMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  channel: PilotChannel;
  createdAt: string;
};

export type PilotReceipt = {
  id: string;
  turnId: string;
  operation: PilotOperation | "conversation";
  status: "completed" | "denied" | "failed";
  targetIds: string[];
  channel: PilotChannel;
  createdAt: string;
  error?: string;
  runtimeSessionId?: string;
};

export type PilotSession = {
  id: string;
  identity: PilotIdentity;
  version: number;
  messages: PilotMessage[];
  receipts: PilotReceipt[];
  updatedAt: string;
};

export type PilotStore = { sessions: Record<string, PilotSession> };

export type PilotRuntime = {
  kind: "fake-fixture" | "internal";
  invoke(input: {
    sessionId: string;
    text: string;
  }): Promise<{ text: string; runtimeSessionId?: string }>;
};
