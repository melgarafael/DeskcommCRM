import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Desambiguação de calendar_service_professionals (#3219)", () => {
  it("a migration 0717 remove calendar_service_professionals_organization_id_fkey", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../supabase/migrations/20261021173000_0717_desambigua_calendar_service_professionals.sql"
    );
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("calendar_service_professionals_organization_id_fkey");
    expect(sql).toContain("-- manifest:");
  });

  it("o baseline.sql possui o apêndice idempotente da migration 0717", () => {
    const baselinePath = path.resolve(__dirname, "../../supabase/baseline.sql");
    const baseline = fs.readFileSync(baselinePath, "utf-8");
    expect(baseline).toContain("0717: Desambiguação de calendar_service_professionals (#3219)");
    expect(baseline).toContain("calendar_service_professionals_organization_id_fkey");
  });
});
