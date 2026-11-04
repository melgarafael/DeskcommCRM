import { expect, it } from "vitest";
import { fotosProgressivasConfig, mesclarFotosProgressivas } from "./fotos-progressivas-config";
it("apenas true explícito habilita o recurso", () => {
  for (const value of [null, {}, [], {catalogo: {fotos_progressivas: "true"}}, {catalogo: {fotos_progressivas: false}}]) expect(fotosProgressivasConfig(value)).toBe(false);
  expect(fotosProgressivasConfig({catalogo: {fotos_progressivas: true}})).toBe(true);
});
it("salvar a opção preserva outras configurações", () => {
  expect(mesclarFotosProgressivas({routing:{mode:"manual"},catalogo:{outra:1}},true)).toEqual({routing:{mode:"manual"},catalogo:{outra:1,fotos_progressivas:true}});
});
