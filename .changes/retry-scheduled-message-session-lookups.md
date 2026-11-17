---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem agendada continua pendente quando a leitura da conexão falha
---
Uma mensagem agendada não é mais cancelada como se o número estivesse desconectado quando o banco não consegue informar o estado da conexão. Ela continua agendada e é tentada de novo numa rodada seguinte do agendador, depois da trava de cinco minutos que já existia. A desconexão confirmada continua seguindo a escolha de esperar ou cancelar. Crédito: @samirhvbr (#4771).
