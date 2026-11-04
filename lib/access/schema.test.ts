import { describe, expect, it } from "vitest";
import { memberAccessPatchSchema } from "./schema";
const id = "a1600000-0000-4000-8000-000000000001";
describe("Contrato administrativo de acessos", () => {
  it("distingue lista vazia (nega) de null (todos)", () => {
    const empty = memberAccessPatchSchema.parse({
      user_id: id,
      pipeline_ids: [],
      channel_ids: [],
      restrict_contacts: true,
    });
    const all = memberAccessPatchSchema.parse({ ...empty, pipeline_ids: null, channel_ids: null });
    expect(empty.pipeline_ids).toEqual([]);
    expect(all.pipeline_ids).toBeNull();
  });
  it("PATCH incompleto não remove restrição por acidente", () => {
    expect(memberAccessPatchSchema.safeParse({ user_id: id }).success).toBe(false);
  });
  it("recusa usuário, recurso e campos inventados", () => {
    const valid = { user_id: id, pipeline_ids: [], channel_ids: [], restrict_contacts: true };
    expect(memberAccessPatchSchema.safeParse({ ...valid, organization_id: id }).success).toBe(
      false,
    );
    expect(memberAccessPatchSchema.safeParse({ ...valid, channel_ids: ["wrong"] }).success).toBe(
      false,
    );
  });
});
