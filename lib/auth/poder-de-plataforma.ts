import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

/**
 * Dispositivo confiável não abre PODER DE PLATAFORMA: um cookie roubado valeria
 * todos os tenants. Quando quem pede é admin da plataforma e, na organização
 * ativa, NÃO é admin, o que o autoriza (`escreveComoPlatformAdmin`, o atalho de
 * `requireRole`) é o poder de plataforma — e aí só o código provado vale. O
 * dono da instalação, admin da própria empresa, segue usando a confiança nela.
 *
 * Fica em `mfaEmDivida`, e não em cada portão, porque são dezenas de call sites que
 * autorizam por esse poder e depois perguntam `mfaEmDivida`. A organização
 * ativa é sempre uma filiação real (`orgAtivaSemPortao`); sessão de suporte já
 * exige `aal2` no banco e não passa por aqui.
 *
 * Módulo próprio, e não função interna de `server.ts`: é a costura que os
 * testes de `requireRole` substituem (o ciclo com `server.ts` impede o mock de
 * alcançar uma função interna), e tem teste próprio ao lado.
 */
export async function agindoPeloPoderDePlataforma(): Promise<boolean> {
  const user = await loadAuthUser();
  if (!user?.is_platform_admin || user.support) return false;
  const org = await orgAtivaSemPortao(user);
  return !org || ROLE_RANK[org.role] < ROLE_RANK.admin;
}
