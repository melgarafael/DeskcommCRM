---
impacto: capacidade_nova
secao: adicionado
titulo: O teto de CPU de cada contêiner se ajusta pelo .env, e os serviços pequenos ganham teto de memória
---
Quem roda o CRM ao lado de outras aplicações no mesmo servidor pode limitar quantos núcleos cada contêiner usa, sem editar o `docker-compose.prod.yml`: basta pôr, por exemplo, `APP_CPUS=2` e `WORKER_CPUS=1` no `.env` e recriar os contêineres. Há uma variável por serviço (`APP_CPUS`, `WORKER_CPUS`, `WAHA_CPUS`, `REDIS_CPUS`, `SRH_CPUS`, `SCHEDULER_CPUS`, `CADDY_CPUS`, `WACALLS_CPUS`, `ASTERISK_CPUS`, `VOICE_AGENT_CPUS`), todas documentadas no `.env.hostgator.example`. Sem essas linhas não há limite de CPU, como sempre. O redis, o srh, o scheduler e o Caddy, que eram os únicos sem teto de memória, passam a ter um com folga larga sobre o pico medido (redis 256m, srh 256m, scheduler 128m, Caddy 512m), ajustável por `REDIS_MEM_LIMIT`, `SRH_MEM_LIMIT`, `SCHEDULER_MEM_LIMIT` e `CADDY_MEM_LIMIT`. Não há nada a fazer na VPS.
