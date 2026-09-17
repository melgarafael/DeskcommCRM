---
impacto: nada_mudou
secao: corrigido
titulo: Ensaio do agente espera a IA em vez de abortar aos 10s
---

O botão Executar teste abortava aos 10s (timeout padrão da API) enquanto
a primeira compilação da rota ainda rodava. Só o POST de ensaio espera
120s; o restante das chamadas continua em 10s. Se ainda estourar, o
aviso pede para conferir a aba Execuções — sem repetir o POST sozinho.
