"use client";
/**
 * O TELEFONE DE EXEMPLO dos campos de telefone — o do país da organização.
 *
 * Onze campos escreviam um celular brasileiro em duro no exemplo (« +55 32 98479-3302 »,
 * « +5511999998888 », « 5511999990000 »…), em toda organização. O exemplo é do país, e o perfil
 * já o declara (`PerfilDoPais.telefoneExemplo`, o que o cadastro de contato e o campo
 * personalizado de telefone usam).
 *
 * O leitor de país é o tolerante (`usePaisDaOrgAtiva`): fora do `AuthProvider` — testes, e o
 * onboarding, que não o tem — vale o Brasil. Onde não há o provider, a página lê o país e
 * entrega o exemplo pronto (o pareamento por código do onboarding).
 */
import { usePaisDaOrgAtiva } from "@/hooks/auth/AuthProvider";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";

export function useTelefoneExemplo(): string {
  return perfilDoPais(usePaisDaOrgAtiva()).telefoneExemplo;
}
