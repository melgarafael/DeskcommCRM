---
impacto: nada_mudou
secao: corrigido
titulo: O roteador de intenções volta a classificar a transcrição do áudio — a conversa não fica mais presa no agente anterior
---

Num roteador com `sticky` ligado, a primeira mensagem (texto) era classificada normalmente, mas qualquer áudio seguinte nunca chegava ao classificador: a decisão saía `sticky` sem confiança, sem consultar o classificador nem o Jev. Um cliente que pedisse por áudio, por exemplo, uma vaga de consulta seguia com o agente de atendimento geral, que não tinha as ferramentas de agenda, em vez de ir para o agente de agendamento. Agora o áudio já transcrito é classificado como qualquer texto — a transcrição entra também no contexto curto do classificador —, e o áudio ainda sem transcrição segue como antes (mantém o agente atual). Não é preciso fazer nada na instalação.

Contribuição de @webtecnica (#2082).
