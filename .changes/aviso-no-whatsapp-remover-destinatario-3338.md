---
impacto: capacidade_nova
secao: adicionado
titulo: Dá para remover o destinatário dos avisos e devolver o número ao Inbox
---

Depois de cadastrar um número para receber os avisos dos casos, não havia como REMOVER esse destinatário. Apagar o campo desabilitava o botão Salvar, a API recusava um telefone vazio mesmo com os avisos desligados, e pausar os avisos não devolvia o número: as mensagens dele continuavam sendo cortadas na entrada, sem virar atendimento no Inbox. A saída era cadastrar um número inexistente no lugar, e o número antigo ficava preso.

A tela Aviso no WhatsApp passa a ter a ação Remover destinatário, com a consequência escrita antes do clique. Ela apaga a configuração de avisos e devolve o número à entrada normal: o que ele mandar volta a virar contato e atendimento, como qualquer outro número. O histórico de entregas da tela continua onde está, e a remoção fica registrada na auditoria com o número mascarado. Os avisos da Agenda configurados para usar o mesmo número dos casos e as automações com a ação Mensagem para a equipe também param até um número novo ser cadastrado.

Pausar segue sendo outra coisa, exatamente como era: com os avisos desligados e um número ainda cadastrado, o que chega dele continua sem virar atendimento. Quem quer o número de volta usa Remover destinatário.

Contribuição de @webtecnica (#3361).
