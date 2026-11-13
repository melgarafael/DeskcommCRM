---
impacto: capacidade_nova
secao: adicionado
titulo: A tela de IA diz em que país o texto do cliente é processado, com a fonte e a data
---

Cada provedor de IA declara o país em CÓDIGO do vocabulário fechado da cláusula 9
(`US`/`CN`/`UE`/`operador`/`desconhecido` — o mesmo que o documento do operador imprime desde o
#4520) mais a procedência em `fonteDoPais` (URL do documento e data da consulta, ou `null` quando a
declaração é a do catálogo), e a tela traduz o código no nome do país ao lado da escolha e da chave
já salva. Onde o provedor não declara a região, a tela diz isso em vez de deixar a linha em branco:
silêncio ali leria como garantia de que nada sai do país. Endpoint do próprio operador e endereço
configurado no ponto têm frases próprias, porque nenhum dos dois é um país.

A cláusula de transferência internacional do documento do operador, que lista esses países em vez da
frase genérica, vem do #4520 — este entrega o dado, a procedência e a tela que leem o mesmo campo.
