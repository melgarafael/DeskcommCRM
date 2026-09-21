import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.fn();
const download = vi.fn();
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ download }) } }),
}));
import { companyContext, companyLogo } from "@/lib/instagram/brand";
const org = "10000000-0000-4000-8000-000000000001";
const file = "10000000-0000-4000-8000-000000000002.png";
beforeEach(() => vi.clearAllMocks());
describe("company context", () => {
  it("uses company identity and remembered context with a tenant-filtered query", async () => {
    query.mockResolvedValue({
      rows: [
        {
          display_name: "Aurora",
          settings: { branding: { app_name: "Portal", logo_path: `${org}/${file}` } },
          previous_description: "Café artesanal",
          agent_description: "Atendimento",
        },
      ],
    });
    const result = await companyContext(org);
    expect(result.name).toBe("Aurora");
    expect(result.description).toBe("Café artesanal");
    expect(result.logoPath).toBe(`${org}/${file}`);
    expect(query.mock.calls[0]?.[1]).toEqual([org]);
    expect(query.mock.calls[0]?.[0]).toContain("a.organization_id=o.id");
  });
  it("does not borrow platform logos or accept another company's logo path", async () => {
    query.mockResolvedValue({
      rows: [{ display_name: "Aurora", settings: { branding: { logo_path: `platform/${file}` } } }],
    });
    const result = await companyContext(org);
    expect(result.logoPath).toBeNull();
    expect(result.logoUrl).toBeNull();
    expect(result.description).toBe("");
  });
  it("does not silently discard a selected logo when storage fails", async () => {
    download.mockResolvedValue({ error: { message: "missing" }, data: null });
    await expect(
      companyLogo(org, {
        name: "A",
        description: "",
        descriptionSource: null,
        logoPath: `${org}/${file}`,
        logoUrl: null,
        accent: null,
      }),
    ).rejects.toThrow("Não foi possível carregar o logo");
  });
});
