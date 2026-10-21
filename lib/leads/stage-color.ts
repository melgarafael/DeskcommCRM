import { z } from "zod";

/** Decoration only: never accepts executable CSS or changes the stage's role. */
export const stageColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();
export function stageDecoration(color: string | null | undefined): string | undefined {
  const parsed = stageColorSchema.safeParse(color);
  return parsed.success && parsed.data ? parsed.data : undefined;
}
