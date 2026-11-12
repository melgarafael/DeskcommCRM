---
impacto: nada_mudou
secao: corrigido
titulo: O dreno de eventos do kit deixa de rodar duas vezes por minuto
---

No self-host do kit, o `event-log-drain` era chamado pelo contêiner `scheduler` (de minuto em minuto) e também pela linha do crontab do host que o `install.sh`/`update.sh` grava: a mesma chamada, no mesmo minuto, duas vezes. Na issue #2235 isso era cerca de 62% das chamadas `service_role` ao PostgREST, com o sistema parado. A linha do host agora é vigia: roda de 15 em 15 minutos e só dispara o dreno quando o contêiner `scheduler` desta instalação não está rodando (`hostgator-setup-kit/drain-watchdog.sh`). Instalação saudável sai de cerca de 60 para cerca de 4 chamadas por hora; com o scheduler fora do ar o dreno continua, com atraso de até 15 minutos. A regra de falha é aberta: se o `docker` não responde, o vigia dispara o dreno em vez de calar. O `update.sh` regrava a linha sozinho; não é preciso mexer em nada na VPS.

Crédito: @webtecnica (#2235).
