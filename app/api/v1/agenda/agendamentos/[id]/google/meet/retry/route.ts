import { requireSupportWrite } from "@/lib/impersonate/support";
import { meetingAction } from "../_action";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return meetingAction(req, context, "retry");
}
