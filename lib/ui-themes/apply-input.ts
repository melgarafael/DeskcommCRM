import { z } from "zod";

/** Visual selection only. Identity and authority always come from the server session. */
export const uiThemeApplyInputSchema = z
  .object({
    themeId: z.string().min(2).max(64),
    installationId: z.string().min(4).max(100),
    catalogHash: z.string().regex(/^[0-9a-f]{64}$/),
    revision: z.number().int().min(0).max(2147483646),
    requestId: z.string().uuid(),
    options: z.record(z.string(), z.union([z.string().max(128), z.boolean(), z.number().finite()])),
  })
  .strict();

export type UiThemeApplyInput = z.infer<typeof uiThemeApplyInputSchema>;
