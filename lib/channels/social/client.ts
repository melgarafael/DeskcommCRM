import { z } from "zod";
import { zernioBaseUrl } from "../zernio/credentials";
export class SocialError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}
/** Fixed provider origin. Credentials never follow a redirect to another host. */
export async function socialRequest(key: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${zernioBaseUrl()}/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new SocialError(
      response.status === 401 || response.status === 403
        ? "Acesso recusado. Confira a chave e as permissões no provedor."
        : `O provedor não concluiu a operação (HTTP ${response.status}).`,
      response.status === 429 ? 429 : 502,
    );
  return response.json();
}
const accountSchema = z.object({
  _id: z.string(),
  platform: z.string(),
  username: z.string().nullish(),
  displayName: z.string().nullish(),
  isActive: z.boolean(),
  profileId: z.union([z.string(), z.object({ _id: z.string(), name: z.string().optional() })]),
});
export type SocialAccount = z.infer<typeof accountSchema>;
export async function listSocialAccounts(key: string, profileId: string): Promise<SocialAccount[]> {
  const parsed = z
    .object({ accounts: z.array(accountSchema) })
    .safeParse(await socialRequest(key, `accounts?profileId=${encodeURIComponent(profileId)}`));
  if (!parsed.success) throw new SocialError("O provedor retornou uma lista de contas inválida.");
  return parsed.data.accounts.filter(
    (a) => (typeof a.profileId === "string" ? a.profileId : a.profileId._id) === profileId,
  );
}
