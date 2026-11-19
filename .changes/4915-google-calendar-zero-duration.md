---
impacto: nada_mudou
secao: corrigido
titulo: Evento de duração zero no Google Agenda não trava mais a leitura, e a tela diz qual evento foi recusado (#4915)
---

Um evento de terceiro com início igual ao fim no Google Agenda travava a sincronização daquela agenda para sempre: o banco recusava a página inteira (`calendar_external_events_periodo_valido` exige fim depois do início), e a rodada seguinte relia a mesma página. Agora o evento de duração zero é descartado na leitura — ele não ocupa horário — e os demais eventos da página entram normalmente. Ele não vira "cancelado": o mesmo leitor alimenta os agendamentos vinculados, e cancelar ali derrubaria no CRM um compromisso que alguém só editou no Google.

Quando algum evento realmente não pode ser lido, a tela da agenda deixa de mostrar só «A leitura não terminou» e passa a dizer o dia e a hora dele (só o dia, se for de dia inteiro), do jeito que aparecem no Google, para quem opera corrigir ou remover esse evento lá. Título e participantes ficam de fora, porque a mensagem é gravada e aparece na tela. O log técnico registra a classe, o código e o nome da restrição do banco, também sem o texto livre do erro.

Nada muda para quem não tem evento assim: a leitura segue igual.

Contribuição de @60507 (#4949), com a parte da tela de @webtecnica (#4920).
