import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

describe("RBAC com contexto avaliado uma vez", () => {
  it("preserva os níveis, isolamento e modos de suporte em 37 asserções", () => {
    const fixture = readFileSync(new URL("./rbac-avaliacao-unica.fixture.sql", import.meta.url), "utf8");
    expect(sql(fixture)).toContain('"passed" : 37, "all_passed" : true');
  });
  for (const target of ["role", "context"]) {
    it(`avalia ${target} uma vez por chamada, sem depender do tempo da CPU`, () => {
      const fixture = readFileSync(new URL(`./rbac-avaliacao-unica-count-${target}.sql`, import.meta.url), "utf8");
      expect(sql(fixture)).toContain("evaluations=1");
    });
  }
});
