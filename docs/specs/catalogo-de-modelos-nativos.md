# Descoberta automática de modelos nativos

Destino: núcleo. O catálogo serve o atendimento comum, sem ativação de extensão.

O cron existente `/api/v1/cron/sync-model-catalog` continua conciliando a
OpenRouter e passa a descobrir modelos da OpenAI e Anthropic. A cadência está
em `docker/scheduler/entrypoint.sh` (`rg -n sync-model-catalog`); o instalador já
chama essa mesma rota no primeiro deploy. Não há variável, chave ou schema novo.

A fonte nativa é a API pública [Models.dev](https://github.com/anomalyco/models.dev#api),
nos registros dos provedores `openai` e `anthropic`, com os IDs que seus SDKs
recebem. Não se convertem aliases da OpenRouter/Vercel em IDs de fabricante.
A descoberta depende de a fonte publicar o lançamento; não verifica acesso da
conta, nem substitui atualização de SDK para mudanças de protocolo.

## Contrato

- Validação Zod antes de qualquer escrita; fonte incompleta, IDs divergentes,
  preço inválido ou fabricante sem modelo utilizável recusam a rodada nativa.
- Só conversa com entrada/saída de texto e ferramentas, sem `status=deprecated`.
  Imagem, áudio, embedding e modelos sem ferramentas não entram por esta origem.
- Preço em USD por milhão vira centavos por milhão; ausente continua `null`.
  É a tarifa base publicada, sem representar todas as faixas de contexto/cache.
- INSERT com conflito ignorado em `(provider, model_id)` preserva entradas
  manuais, preços existentes, depreciações e escolhas da organização. Repetir
  a rodada não duplica nem substitui linhas. O cron nativo descobre adições;
  não atualiza preços de modelos já presentes nem decide sua aposentadoria.
- `source=models.dev` e `synced_at` identificam a origem e a descoberta.
  Sumir do agregador não remove modelo do fabricante.
- As duas fontes executam independentemente. Erro nativo devolve 500 ao
  scheduler mesmo se a OpenRouter concluir; o resultado da fonte que concluiu
  permanece. A próxima rodada tenta novamente, mantendo a lista anterior.
- Novidades emitem `ai_models.synced`; falhas nativas, `ai_models.sync_failed`.
  São eventos globais em `api_audit_log`, visíveis em `/admin/audit`. Rodada
  nativa sem adições não emite auditoria. Contagens também saem no logger.

## Living System Checklist

1. Entrada: Models.dev → `traduzirCatalogoNativo`, chamado pelo cron autenticado.
2. Saída: `ai_models` → GET de provedores e seletor `ModelPicker` do agente.
3. Registro: logger e os eventos de auditoria descritos acima.
4. Tela: `/app/ai/providers`, editor do agente e `/admin/audit`.
5. Porta: hub `/app/ai` e navegação administrativa já existentes.
6. Anti-morte: rodada diária; erro mantém o catálogo anterior e tenta de novo.
7. Configuração: escolhas continuam em Provedores de IA; descoberta é automática.
8. Continuidade: não envia mensagens nem muda agentes; decisão fica com o operador.
9. Retorno: validação/erro impedem escrita inválida e a próxima rodada repete a
   leitura. Sem aprendizado de preferência: o cron só descobre metadados.
10. Mapa: `docs/architecture/catalogo-de-modelos.architecture.json`.
