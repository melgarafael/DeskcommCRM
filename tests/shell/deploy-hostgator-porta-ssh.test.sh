#!/usr/bin/env bash
# Prova que o guia de instalação na HostGator ensina a entrar no servidor pela porta
# em que o SSH dela escuta de verdade.
#
#   bash tests/shell/deploy-hostgator-porta-ssh.test.sh
#
# O defeito que ele guarda: a VPS da HostGator escuta SSH na 22022, não na 22. O guia
# (docs/deploy-hostgator/README.md) mandava `ssh root@SEU-IP-AQUI`, que vai à 22 e
# recebe porta fechada — o leigo trava no Passo 2, antes de instalar qualquer coisa.
# E o firewall do mesmo passo liberava só a 22: quem ativasse o `ufw` como o guia
# mostra se trancava fora do servidor.
#
# Mede o texto dos blocos de código, porque é o que a pessoa copia e cola.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUIA="$RAIZ/docs/deploy-hostgator/README.md"

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

# Só as linhas DENTRO de bloco ```...``` — é o que vai para o terminal.
codigo() { awk '/^```/{dentro=!dentro; next} dentro' "$GUIA"; }

# Controle positivo: sem nenhum comando ssh no guia, as checagens abaixo passariam
# por vacuidade.
tem_ssh() { codigo | grep -qE '^[[:space:]]*ssh '; }
check "o guia tem ao menos um comando ssh (senão o resto passaria vazio)" tem_ssh

ssh_sem_porta() { codigo | grep -E '^[[:space:]]*ssh ' | grep -vE '(^|[[:space:]])-p[[:space:]]*22022([[:space:]]|$)'; }
todo_ssh_na_22022() { [ -z "$(ssh_sem_porta)" ]; }
check "todo comando ssh do guia leva -p 22022" todo_ssh_na_22022

scp_sem_porta() { codigo | grep -E '^[[:space:]]*scp ' | grep -vE '(^|[[:space:]])-P[[:space:]]*22022([[:space:]]|$)'; }
todo_scp_na_22022() { [ -z "$(scp_sem_porta)" ]; }
check "todo comando scp do guia leva -P 22022 (maiúsculo: no scp, -p é outra coisa)" todo_scp_na_22022

# O firewall do mesmo passo: liberar a 22 e não a 22022 tranca a pessoa fora.
ufw_libera_22022() { codigo | grep -E '^[[:space:]]*ufw allow ' | grep -qE '(^|[ ,])22022([,/ ]|$)'; }
check "o ufw do guia libera a 22022 antes de ser ativado" ufw_libera_22022

# Todo `ufw allow` do guia, não só os dos blocos: a tabela de problemas manda rodar um
# entre crases, e quem o segue com o ufw desligado e depois o ativa se tranca fora igual.
ufw_sem_22022() { grep -oE 'ufw allow [^`|]*' "$GUIA" | grep -vE '(^|[ ,])22022([,/ ]|$)'; }
todo_ufw_com_22022() { [ -z "$(ufw_sem_22022)" ]; }
check "todo ufw allow do guia (em bloco ou entre crases) libera a 22022" todo_ufw_com_22022

if [ "$FAILS" -gt 0 ]; then
  ssh_sem_porta | sed 's/^/    sem porta: /'
  scp_sem_porta | sed 's/^/    sem porta: /'
  ufw_sem_22022 | sed 's/^/    ufw sem a 22022: /'
  printf '\n%d falha(s)\n' "$FAILS"; exit 1
fi
printf '\ntudo verde\n'
