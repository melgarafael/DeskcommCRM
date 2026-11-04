---
impacto: capacidade_nova
secao: adicionado
titulo: Pausa entre uma resposta da IA e a próxima
---
Na tela de cada agente, em "Limites do atendimento", o campo "Pausa entre uma resposta e a próxima (segundos)" define quanto tempo a IA espera antes de responder de novo à mesma conversa, de 1 a 600 segundos. O que o cliente escrever nesse meio-tempo é respondido junto, numa resposta só. Vazio ou 0 mantém o comportamento de sempre: nada muda para quem não preencher.

A atualização acrescenta a coluna `reply_min_interval_ms` em `ai_agent_versions`, aplicada pelo `update.sh` sem edição manual.
