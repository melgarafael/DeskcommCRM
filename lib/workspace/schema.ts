import { z } from "zod";
export const workspaceQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    scope: z.enum(["all", "conversations", "leads", "knowledge"]),
    history: z
      .array(
        z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }).strict(),
      )
      .max(8),
  })
  .strict()
  .refine((v) => v.history.reduce((n, m) => n + m.content.length, 0) <= 16000);
export type WorkspaceScope = z.infer<typeof workspaceQuestionSchema>["scope"];
export type WorkspaceSource = {
  id: string;
  title: string;
  text: string;
  href: string;
  kind: string;
};
export const workspaceReplySchema = z
  .object({ answer: z.string().trim().min(1).max(4000), sourceIds: z.array(z.string()).max(20) })
  .strict();
export type WorkspaceReply =
  | { ok: true; answer: string; sources: WorkspaceSource[]; notice: string }
  | { ok: false; message: string };
