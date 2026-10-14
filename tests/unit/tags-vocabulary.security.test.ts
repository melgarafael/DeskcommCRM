import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useMutation: vi.fn(), useQueryClient: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
type Options = { queryKey: unknown[]; enabled: boolean; queryFn: (ctx: { signal: AbortSignal }) => Promise<string[]> };
const options = () => vi.mocked(useQuery).mock.calls.at(-1)![0] as unknown as Options;
beforeEach(() => vi.clearAllMocks());
describe.each([
  ["contact", useContactTagVocabulary, "/api/v1/contact-tags"],
  ["conversation", useConversationTagVocabulary, "/api/v1/conversation-tags"],
] as const)("security: %s vocabulary hook", (_, hook, path) => {
  it("partitions cache by organization and search; disables without an organization", () => {
    hook("tenant-a", "alpha"); const first = options().queryKey;
    hook("tenant-b", "alpha"); expect(options().queryKey).not.toEqual(first);
    hook("tenant-a", "beta"); expect(options().queryKey).not.toEqual(first);
    hook(null, "alpha"); expect(options().enabled).toBe(false);
  });
  it("encodes search as one parameter; does not let it inject organization_id", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: ["approved"] });
    const search = "a&organization_id=tenant-b#fragment";
    hook("tenant-a", search);
    const signal = new AbortController().signal;
    expect(await options().queryFn({ signal })).toEqual(["approved"]);
    expect(apiClient.get).toHaveBeenCalledWith(path + "?busca=" + encodeURIComponent(search), { signal });
  });
  it("propagates denial instead of hiding it as an empty vocabulary", async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error("forbidden"));
    hook("tenant-a", "alpha");
    await expect(options().queryFn({ signal: new AbortController().signal })).rejects.toThrow("forbidden");
  });
});
