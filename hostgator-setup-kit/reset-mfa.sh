#!/usr/bin/env bash
# Emergência: remove o MFA (TOTP) de um usuário que perdeu o autenticador.
# No próximo login ele será obrigado a cadastrar um novo (MFA é forçado p/ admin).
#
#   bash hostgator-setup-kit/reset-mfa.sh dono@empresa.com
source "$(dirname "$0")/_common.sh"
enter_project

EMAIL="${1:-}"
[ -n "$EMAIL" ] || die "Uso: reset-mfa.sh <email>"

c_ylw "Isto remove TODOS os fatores MFA de $EMAIL."
read -r -p "Confirmar? (s/N) " a; [ "${a:-N}" = "s" ] || die "Cancelado."

step "Removendo fatores MFA"
psql_run <<SQL
delete from auth.mfa_factors
where user_id = (select id from auth.users where email = '${EMAIL}');
SQL
c_grn "✓ MFA removido. No próximo login, $EMAIL cadastra um novo autenticador."
