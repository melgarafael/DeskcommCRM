/** Reaproveita a recusa de marketing canônica; e-mail não exige telefone. */
import { recusouMarketing } from "@/lib/campanhas/elegibilidade";
export function contatoRestringido(c: { is_anonymized?: boolean; is_blocked?: boolean; is_personal?: boolean; consent?: unknown }): boolean {
  return c.is_anonymized === true || c.is_blocked === true || c.is_personal === true || recusouMarketing(c.consent);
}
