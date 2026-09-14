---
impacto: capacidade_nova
secao: adicionado
titulo: Você passa a controlar os limites de leitura do banco conectado (linhas, filtros e tamanho)
---

Antes, quanto o sistema podia ler do banco externo era um número cravado no código: no máximo 200 linhas por consulta, 20 filtros e uma resposta enxuta para a IA. Quem tinha um processo que precisa varrer mais linhas ou combinar mais condições batia no mesmo teto de quem lê vinte e nada.

Agora quem administra a conexão define esses limites **na tela da conexão**, em "Limites de leitura":

- **Linhas por consulta** — de 1 a 5.000. Vale para a grade e para o agente.
- **Filtros por consulta** — de 0 a 100. Vale para as consultas do agente.
- **Resposta para a IA (KB)** — de 4 KB a 1 MB: o tamanho do dado que entra no contexto do modelo.

Os valores padrão continuam os de antes (200 linhas, 20 filtros, 30 KB), então nada muda para quem não mexer. Os campos ficam na mesma tela de cadastro da conexão (Organização › Fontes de dados › Dados externos), visíveis a todos e editáveis por administradores.
