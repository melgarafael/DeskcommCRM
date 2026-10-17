---
impacto: capacidade_nova
secao: adicionado
titulo: O painel do admin avisa, em todas as telas, quando a falta de SMTP impede e-mail de sair
---

Numa instalação sem servidor de e-mail configurado, quem administra só descobria isso lendo o log do update — e o log é a última tela que alguém abre. Agora o painel do admin mostra, no topo de todas as telas, a tarja "Sem SMTP configurado": ela diz que convites, recuperação de senha e avisos por e-mail não saem por SMTP e leva direto à tela onde se configura, /admin/email. O aviso fica visível na rolagem, e quem já configurou o SMTP (host e remetente, na tela ou no .env) não vê nada. Sem SMTP, a tarja aparece quando falta SMTP no servidor único (ali nem a Resend supre a recuperação de senha) e, em qualquer instalação, quando não há nem SMTP nem Resend; some fora do servidor único quando a Resend entrega. A leitura acontece no layout de /admin, ao lado da leitura dos módulos ligados que já existia; nenhuma tabela, coluna ou migração foi criada. Um banco que não respondeu não vira "sem SMTP": um soluço dele não acende o aviso.

Contribuição de @webtecnica (refs #2755).
