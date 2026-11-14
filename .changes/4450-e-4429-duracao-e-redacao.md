---
impacto: nada_mudou
secao: corrigido
titulo: Remarcar um compromisso não apaga mais a duração, e a redação do follow-up passa a respeitar a trava de repetição
---

**Duração ao remarcar.** Marcar um compromisso já aceitava duração; alterar o horário, não — o PATCH não levava o número e a tela desligava o campo. Resultado: remarcar um atendimento de 90 minutos devolvia o compromisso ao tamanho padrão do serviço, e a única saída era apagar e recriar (perdendo o histórico do bloco). Agora a alteração aceita e preserva a duração, e a tela deixa de esconder o campo. Cliente antigo, que não manda a duração, mantém exatamente o comprimento que o bloco já tem — nada muda para ele.

**Redação do follow-up x trava de repetição.** O passo de mensagem com mais de uma redação escolhia o texto sem olhar o que já foi enviado, e a trava de repetição barrava o envio: o contato ficava sem mensagem e o passo encerrava como pulado. Agora a escolha olha a janela de envios recentes e prefere a redação que menos colide; se nenhuma passar, o passo é adiado (como já acontecia do lado de fora da janela de envio), com teto de três adiamentos antes de encerrar.

Crédito: @webtecnica.
