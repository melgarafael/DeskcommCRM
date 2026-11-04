import { assertPilotIdentity } from "./domain";
import type { PilotIdentity } from "./types";
export function pilotEnabled(identity: PilotIdentity): boolean {
  if (process.env.ASSISTANT_PILOT_ENABLED !== "true") return false;
  try {
    assertPilotIdentity(identity);
    return true;
  } catch {
    return false;
  }
}
