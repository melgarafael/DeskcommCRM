---
impacto: nada_mudou
secao: corrigido
titulo: A tela de atualização para de consultar o servidor a cada 5 segundos quando não há atualização em curso
---

A tela **Configurações › Atualização** consultava a versão do sistema a cada 5 segundos, o tempo todo, enquanto estava aberta. No Supabase grátis isso gasta cota de tráfego (egress) e de Auth sem trazer informação nova. Agora ela só consulta a cada 5 segundos enquanto uma atualização está rodando; parada, a cada 5 minutos, que é o ritmo em que o agente do servidor informa o estado (#2235).

O comentário do `hostgator-setup-kit/backup.sh` e o runbook de custo do Supabase passam a explicar que o backup também conta no egress e ensinam a conferir quanto ele custa no painel (Settings › Usage › Egress, linha Shared Pooler). O backup continua diário por padrão.

Crédito: @jlom2024 (#2235).
