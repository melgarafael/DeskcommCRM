import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
it("forward-fix da revogação está no baseline antes da varredura final", () => {
  const baseline=fs.readFileSync(path.resolve("supabase/baseline.sql"),"utf8");
  const migration=fs.readFileSync(path.resolve("supabase/migrations/20261008235500_0615_revogacao_autonoma_canonica.sql"),"utf8");
  expect(baseline).toContain(migration);
  expect(baseline.indexOf(migration)).toBeLessThan(baseline.indexOf("-- ---- VARREDURA anon:"));
});
