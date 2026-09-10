import { describe, expect, it } from "vitest";
import { catalogSchema } from "@/lib/academia/catalogs";
describe("contrato dos cadastros", () => {
 it("idade desconhecida não vira zero e começa provisória", () => {
  expect(catalogSchema("audiences").parse({ name: " Adulto " })).toMatchObject({ name: "Adulto", min_age: null, max_age: null, age_pending: true });
 });
 it("faixas editáveis aceitam limites inclusivos e rejeitam inversão", () => {
  const schema = catalogSchema("audiences");
  expect(schema.safeParse({name:"Teen",min_age:11,max_age:15}).success).toBe(true);
  expect(schema.safeParse({name:"Teen",min_age:15,max_age:11}).success).toBe(false);
  expect(schema.safeParse({name:"Kids",min_age:-1}).success).toBe(false);
  expect(schema.safeParse({name:"Kids",max_age:10.5}).success).toBe(false);
 });
 it("alias repetido não cria equivalência ambígua dentro da modalidade", () => {
  const schema=catalogSchema("modalities");
  expect(schema.safeParse({name:"Ciclismo",aliases:["Spinning"]}).success).toBe(true);
  expect(schema.safeParse({name:"Ciclismo",aliases:[" spinning ","SPINNING"]}).success).toBe(false);
  expect(schema.safeParse({name:"Ciclismo",aliases:["ciclismo"]}).success).toBe(false);
 });
 it("não aceita tenant nem campos de outro cadastro", () => {
  expect(catalogSchema("teachers").safeParse({name:"Professor",organization_id:"outro"}).success).toBe(false);
  expect(catalogSchema("spaces").safeParse({name:"Sala",min_age:10}).success).toBe(false);
  expect(catalogSchema("teachers").safeParse({name:"  "}).success).toBe(false);
 });
});
