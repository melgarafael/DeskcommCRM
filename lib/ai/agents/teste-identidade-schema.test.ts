import { expect, it } from "vitest";
import { testRunSchema } from "./validation";
const contact_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
it.each([
  { sample_contact: { phone: "5511999990000" }, contact_id },
  { required_source_tool: "consultar_dados_cliente" },
  { contact_id: "telefone" },
  { contact_id, required_source_tool: "https://outro.example" },
])("recusa identidade ou fonte externa inválida: %j", (extra) => {
  expect(testRunSchema.safeParse({ sample_message: "Qual o prazo?", ...extra }).success).toBe(
    false,
  );
});
it("aceita escolha explícita do contato e fonte para o teste", () => {
  expect(
    testRunSchema.safeParse({
      sample_message: "Qual o prazo?",
      contact_id,
      required_source_tool: "consultar_dados_cliente",
    }).success,
  ).toBe(true);
});
