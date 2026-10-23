---
impacto: capacidade_nova
secao: corrigido
titulo: Servidor de e-mail aceita nome de relé com "_" e explica o formato sem erro cru do banco
---

A tela do servidor de e-mail (/admin/email) agora aceita endereço com "_" — o nome de um contêiner Docker, como um relé de e-mail na própria VPS (`meu_relay`, `supabase_inbucket_…`), que o arquivo de instalação já aceitava e só a tela recusava. Continua recusando o que não é nome de máquina (espaço, barra, `http://`), com a explicação em português no próprio aviso; nenhuma falha de gravação mostra mais o texto cru do Postgres — ele fica no log do servidor.

Contribuição de @Tong-bit-art (#2816), a partir da issue #2804.

Guarda de divergência entre a tela e o banco trazida do #3227, de @webtecnica.
