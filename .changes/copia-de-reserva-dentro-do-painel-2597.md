---
impacto: nada_mudou
secao: corrigido
titulo: A cópia de reserva passa a ser feita dentro do painel aberto e devolve o foco ao botão de copiar
---

Quando o navegador não oferece a cópia direta (por exemplo, ao acessar a instalação por `http://` e o IP), os botões de copiar usam uma cópia de reserva. Ela era montada fora do painel aberto, como o de "Endereço da fonte" em Webhooks, e agora é montada dentro dele. Depois de copiar, o foco volta ao botão, com ou sem painel aberto, para quem navega pelo teclado ou usa leitor de tela não perder o lugar. Nada precisa ser feito ao atualizar. Contribuição de @webtecnica (#2597), a partir da issue #2580 de @brunno-soaress.
