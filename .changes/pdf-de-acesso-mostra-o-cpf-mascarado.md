---
impacto: nada_mudou
secao: corrigido
titulo: O relatório de acesso (LGPD) mostra o CPF informado na conversa mascarado, em vez de apontar para um arquivo que o titular não recebe
---

Quando o titular tinha informado o CPF numa conversa, o PDF de acesso dizia "Informado na conversa (valor no arquivo de dados)" e o mandava a um `data.json` que ele nunca recebe: o arquivo fica no servidor e o e-mail entrega só o PDF. Agora a linha mostra o próprio CPF com só os 4 últimos dígitos visíveis (`***.***.*47-25`). Quando o relatório não consegue saber com segurança qual valor é do titular (nenhum CPF guardado, ou dois campos de CPF com valores diferentes, como o do responsável e o do paciente), a linha diz "valor não disponível neste relatório", sem apontar para arquivo nenhum. O valor completo continua guardado só no arquivo de dados. Não há nada para quem opera a instalação fazer.

Crédito: @webtecnica.
