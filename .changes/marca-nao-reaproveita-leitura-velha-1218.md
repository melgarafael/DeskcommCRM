---
impacto: nada_mudou
secao: corrigido
titulo: Depois de gravar a marca, uma leitura feita no meio da troca não traz mais de volta a marca anterior
---

Depois de gravar a marca (logo, nome, ícone), uma leitura feita no meio da troca não traz mais de volta a marca anterior; antes, ela podia voltar a aparecer por até 30 segundos. Acontecia quando uma tela estava sendo montada no instante da gravação: o servidor reaproveitava, dentro dessa tela, a resposta que o banco tinha dado antes da gravação, e a guardava como se fosse a nova. A mesma leitura reaproveitada foi fechada nas outras configurações da instalação que a tela grava e o servidor guarda pelos mesmos 30 segundos: o CSS personalizado, o modo de cadastro, o comportamento da instalação em /admin/sistema e as credenciais do Google Agenda e do app da Meta. A memória curta de cada uma continua existindo como antes. Nenhuma mudança de banco nem de configuração.

Refs #1218.
