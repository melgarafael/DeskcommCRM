#!/usr/bin/env bash
# Emergência: remove o MFA (TOTP) de um usuário que perdeu o autenticador.
# A verificação em duas etapas é OPCIONAL: no próximo login a pessoa entra só
# com a senha e cadastra um autenticador novo em Configurações › Segurança se quiser.
#
#   bash hostgator-setup-kit/reset-mfa.sh dono@empresa.com
source "$(dirname "$0")/_common.sh"
enter_project

EMAIL="${1:-}"
[ -n "$EMAIL" ] || die "Uso: reset-mfa.sh <email>"

c_ylw "Isto remove TODOS os fatores MFA de $EMAIL."
read -r -p "Confirmar? (s/N) " a; resposta_sim "$a" || die "Cancelado."

step "Removendo fatores MFA"
psql_run <<SQL
delete from auth.mfa_factors
where user_id = (select id from auth.users where email = '${EMAIL}');
SQL
c_grn "✓ MFA removido. $EMAIL entra só com a senha; cadastra um autenticador novo em Configurações › Segurança se quiser."
