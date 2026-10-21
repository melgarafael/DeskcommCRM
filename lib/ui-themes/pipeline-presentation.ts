import { z } from "zod";

export const pipelinePresentationSchema = z
  .object({
    editStageColor: z.boolean().optional(),
  })
  .strict();

export { stageColorSchema, stageDecoration } from "@/lib/leads/stage-color";
