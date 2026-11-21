---
impacto: capacidade_nova
secao: adicionado
titulo: Negócio pode ser classificado como não comercial, sem virar perda e sem sair do histórico
---

O negócio tinha dois desfechos e nenhum jeito de dizer "isto nunca foi uma
oportunidade". A saída que a operação usava era pior nos dois sentidos: marcar
como perdido inventava uma perda comercial (um golpe entrava na conta de "perdemos
por preço") e excluir o card apagava contato, conversa, mensagens, anexos e
atividades.

Agora a ficha do negócio tem a classificação **não comercial**, com motivo
declarado pela equipe, autor e data. Ela não mexe em status, etapa, valor nem
`closed_at`: o negócio não vira ganho nem perda, e as métricas de desfecho não
se movem. O que muda é a elegibilidade comercial — o negócio sai do Radar de
risco (inclusive da lista de demandas sem próximo passo) e sai da conta do funil
(conversão, matriz de origem e dias até fechar), num predicado só, usado pelos
dois.

Errar a classificação é reversível: reverter devolve o negócio ao comercial, sem
replay de mensagens nem de cadências vencidas. Cada classificação e cada
reversão deixam uma linha na timeline do negócio e um registro no audit.
Repetir a operação não escreve de novo; classificar com motivo diferente do já
gravado é recusado em vez de sobrescrever a decisão de outra pessoa.
