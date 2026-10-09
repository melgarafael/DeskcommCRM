import { z } from "zod";

export const CASE_TASK_KINDS = ["payment_details", "payment_review"] as const;
export const caseTaskKindSchema = z.enum(CASE_TASK_KINDS);
export type CaseTaskKind = z.infer<typeof caseTaskKindSchema>;
export type CaseTaskState =
  "awaiting_human" | "awaiting_send" | "send_failed" | "awaiting_lead" | "completed";
export interface CaseTaskFields {
  lead_id: string | null;
  task_kind: CaseTaskKind | null;
  task_state: CaseTaskState | null;
  revision: number;
  wait_generation: number;
  wait_started_at: string | null;
  assignee_user_id: string | null;
  assignee_name?: string | null;
  lead_title?: string | null;
  assigned_to_me?: boolean;
  can_reassign?: boolean;
  purchase_candidates?: Array<{ id: string; title: string }>;
  post_delivery_options?: Array<{ id: string; name: string }>;
  task_payload: Record<string, unknown>;
  decision_event_id: string | null;
  delivery_job_id: string | null;
}

export const caseTaskActionSchema = z
  .strictObject({
    action: z.enum([
      "assume",
      "takeover",
      "release",
      "link_purchase",
      "details_release",
      "payment_confirmed",
      "payment_not_found",
      "need_information",
      "retry_send",
    ]),
    expected_revision: z.number().int().nonnegative(),
    approved_text: z.string().trim().min(1).max(4000).optional(),
    payment_method: z.enum(["pix", "card"]).optional(),
    note: z.string().trim().min(1).max(4000).optional(),
    lead_id: z.uuid().optional(),
    post_delivery_pointer_id: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      ["details_release", "payment_confirmed", "payment_not_found", "need_information"].includes(
        value.action,
      ) &&
      !value.approved_text
    )
      ctx.addIssue({
        code: "custom",
        path: ["approved_text"],
        message: "Revise o texto que será enviado ao cliente.",
      });
    if (value.action === "details_release" && !value.payment_method)
      ctx.addIssue({
        code: "custom",
        path: ["payment_method"],
        message: "Informe a forma de pagamento.",
      });
    if (["payment_not_found", "need_information"].includes(value.action) && !value.note)
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Informe o próximo passo ou a informação necessária.",
      });
    if (value.action === "link_purchase" && !value.lead_id)
      ctx.addIssue({ code: "custom", path: ["lead_id"], message: "Escolha a compra atual." });
  });
export type CaseTaskAction = z.infer<typeof caseTaskActionSchema>;

export class CaseTaskConflict extends Error {
  constructor(
    public readonly code: "not_found" | "invalid_state" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}
