import { describe, expect, it } from "vitest";
import {
  pipelinePresentationSchema,
  stageColorSchema,
  stageDecoration,
} from "./pipeline-presentation";
describe("apresentação do funil", () => {
  it("aceita somente decoração hexadecimal completa ou restauração", () => {
    expect(stageDecoration("#Ab10F0")).toBe("#Ab10F0");
    expect(stageColorSchema.parse(null)).toBeNull();
    for (const color of ["red", "#abc", "url(https://example.test)", "#000000;display:none"]) {
      expect(stageColorSchema.safeParse(color).success).toBe(false);
      expect(stageDecoration(color)).toBeUndefined();
    }
  });
  it("configuração de apresentação não recebe comandos ou papéis de etapa", () => {
    expect(pipelinePresentationSchema.safeParse({ editStageColor: true }).success).toBe(true);
    expect(pipelinePresentationSchema.safeParse({ is_won: true }).success).toBe(false);
  });
});
