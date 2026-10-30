---
impacto: nada_mudou
secao: corrigido
titulo: Agente não confirma horário sem agendar, remarcação não duplica e turno mudo se corrige
---

O agente deixava de confirmar horário "de cabeça": uma frase abrindo com
"Confirmado: …" sem a ferramenta de agenda ter sido chamada agora é vetada
pela cerca before-send e ele usa a agenda de verdade antes de prometer.
A remarcação pedida por descrição não cria mais um segundo agendamento — o
movimento sai com a ferramenta certa, com a receita de ferramenta alinhada ao
prompt publicado. Quando o turno termina sem nenhuma mensagem chegar ao
cliente (resposta cortada ou texto escrito fora do envio), o sistema pede uma
única correção, também quando um envio foi recusado por uma regra de texto,
e ela agora tem passos suficientes para entregar a mensagem. Quando o envio é
recusado porque o contato pediu para sair, é interno, está com a equipe ou
está anonimizado, nada é pedido de novo: o silêncio ali é a decisão certa.
Nada muda na VPS — a correção chega pela atualização normal.
