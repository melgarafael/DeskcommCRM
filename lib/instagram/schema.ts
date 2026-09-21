import { z } from "zod";

export const formats = {
  feed: { label: "Post vertical", size: "1024x1280", ratio: "4 / 5" },
  square: { label: "Post quadrado", size: "1024x1024", ratio: "1 / 1" },
  story: { label: "Story", size: "1152x2048", ratio: "9 / 16" },
} as const;
export const referenceSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/^@/, ""))
  .pipe(z.string().regex(/^[a-zA-Z0-9._]{1,30}$/, "Informe o @ do perfil, sem links ou espaços."));
export const createSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.uuid(),
      kind: z.literal("post"),
      brief: z.string().trim().min(10).max(3000),
      niche: z.string().trim().min(2).max(150),
      format: z.enum(["feed", "square", "story"]),
      caption: z.string().max(2200).default(""),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      kind: z.literal("research"),
      niche: z.string().trim().min(2).max(150),
      brief: z.string().trim().min(3).max(1000),
      references: z.array(referenceSchema).max(10).default([]),
    })
    .strict(),
  z.object({ id: z.uuid(), kind: z.literal("reference"), username: referenceSchema }).strict(),
]);
export const editSchema = z.object({ caption: z.string().max(2200) }).strict();
export type StudioInput = z.infer<typeof createSchema>;
export interface StudioItem {
  id: string;
  kind: "post" | "research" | "reference";
  status: "generating" | "ready" | "failed";
  input: StudioInput;
  caption: string;
  answer: string;
  sources: { title: string; url: string }[];
  asset_path: string | null;
  image_url?: string | null;
  can_edit?: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export function safeSource(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
