---
impacto: nada_mudou
secao: corrigido
titulo: O worker para de consultar o banco a cada 10 segundos quando não há movimento
---

Com a instalação parada, o worker procurava acontecimentos novos a cada 10 segundos, para sempre. Numa instalação real isso deu cerca de 17 consultas por minuto, todas vazias: perto de 40% de todo o tráfego ocioso ao banco.

Agora, sem movimento, ele espaça as passadas: 10, 20 e depois 30 segundos. No primeiro acontecimento que encontra, volta a passar a cada 2 segundos. A procura por acontecimento travado no meio passa a rodar no máximo cerca de 1 vez por minuto, em vez de a cada passada. Quando chega um áudio e a resposta do agente está esperando a transcrição, o worker é acordado na hora, sem esperar o espaçamento.

Depois de um silêncio, o primeiro acontecimento pode esperar até 30 segundos para ser visto, em vez de até 10. O relógio de 1 minuto continua ligado como rede de segurança. Nenhum acontecimento se perde.

Você não precisa mudar nada. Há dois ajustes opcionais, com valor padrão: `EVENT_LOG_DRAIN_IDLE_MAX_INTERVAL_MS` (teto do espaçamento, 30000) e `EVENT_LOG_DRAIN_STALE_SWEEP_MS` (intervalo da procura por travados, 60000).

Contribuição de @webtecnica, a partir da medição de @DPalmercs (#3701, #3693).
