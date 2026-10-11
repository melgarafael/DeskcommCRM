---
impacto: nada_mudou
secao: corrigido
titulo: Inbox, contadores e fila param de resolver o contato por linha
---

O filtro "quem manda na conversa" — a lista do inbox, os números das abas e a fila de atendimento — lia as travas do contato (força de atendimento humano e descadastro) com duas consultas a `contacts` por conversa, dentro de uma função avaliada linha a linha: com N conversas, cada tela pagava N avaliações e 2N leituras. Agora essas travas ficam guardadas na própria conversa, atualizadas quando o contato muda e quando a conversa troca de contato, e o prazo do silêncio continua sendo avaliado na hora da consulta — nada de resultado congelado. Medido com 3.000 conversas (pg15): as leituras caíram de 18.101 buffers para 77 por consulta, com o mesmo resultado de antes nas três telas.

Contribuição de @Tong-bit-art (#2748), a partir da issue #2739.
