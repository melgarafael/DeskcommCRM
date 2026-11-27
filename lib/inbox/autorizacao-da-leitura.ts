import { fail } from "@/lib/api/wrappers";
import { CODIGO_ORG_DIVERGENTE, HEADER_ORG_DA_ABA } from "@/lib/auth/org-da-aba";

export function conferirOrgNaLeitura(req: Request, orgId: string, requestId: string) {
  const orgDaAba = req.headers.get(HEADER_ORG_DA_ABA);
  if (!orgDaAba || orgDaAba === orgId) return null;
  return fail(CODIGO_ORG_DIVERGENTE, "A organização ativa mudou.", 409, { requestId });
}
