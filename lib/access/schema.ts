import { z } from "zod";
/** null = todos no eixo; [] = nenhum. Ausência não remove restrições por acidente. */
export const memberAccessPatchSchema = z
  .object({
    user_id: z.string().uuid(),
    pipeline_ids: z.array(z.string().uuid()).max(1000).nullable(),
    channel_ids: z.array(z.string().uuid()).max(1000).nullable(),
    restrict_contacts: z.boolean(),
    reset: z.boolean().default(false),
  })
  .strict();
