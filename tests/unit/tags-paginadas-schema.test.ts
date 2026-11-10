import { describe, expect, it } from "vitest";
import { tagsPageQuerySchema } from "@/lib/schemas/tags";
describe("consulta de etiquetas por página",()=>{
 it("valida página e não aceita buscas enormes",()=>{
   expect(tagsPageQuerySchema.parse({page:"8",busca:" Belchior "})).toEqual({page:8,busca:"Belchior"});
   expect(tagsPageQuerySchema.safeParse({page:"-1"}).success).toBe(false);
   expect(tagsPageQuerySchema.safeParse({busca:"x".repeat(61)}).success).toBe(false);
 });
});
