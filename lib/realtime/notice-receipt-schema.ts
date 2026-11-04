import { z } from "zod";
export const noticeReceiptSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            revision: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
