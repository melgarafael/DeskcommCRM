---
impacto: capacidade_nova
secao: corrigido
titulo: Automação "contato ganhou telefone" passa a rodar também na ingestão de canal e no cron de telefones
---
A automação que dispara quando um contato passa a ter telefone só rodava quando o número era preenchido na tela ou na captura de anúncio. Outros quatro caminhos tiravam a ficha do vazio sem avisar: a ingestão de mensagens do canal (em dois pontos), o cron que descobre o número por trás da identidade opaca e o cadastro de contato do WhatsApp. Agora os quatro emitem, cada um uma única vez e só quando o contato estava mesmo sem número. Quem já tinha número não gera evento nenhum, e a promoção da grafia de 12 para 13 dígitos do mesmo número também não é tratada como número novo. A junção de dois cadastros continua sem gerar o evento, de propósito: as duas fichas já existiam e o número já estava no CRM, então disparar a automação de novo repetiria o mesmo aviso para a mesma pessoa e o mesmo número.
