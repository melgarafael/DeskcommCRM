-- manifest: Exige a mesma organização/funil/etapa em todo caminho SQL, sem reparar legado automaticamente.
-- Operator controls statement/lock timeout; applying/validating takes locks and needs a reviewed target window.
do $integridade_funil_etapa$
declare actual record;expected smallint[];ref_expected smallint[];legado_invalido boolean;
begin
 lock table public.crm_pipelines,public.crm_stages,public.crm_leads in share row exclusive mode;
legado_invalido:=exists(select 1 from public.crm_stages s left join public.crm_pipelines p on p.id=s.pipeline_id where p.id is null or p.organization_id is distinct from s.organization_id)
 or exists(select 1 from public.crm_leads l left join public.crm_pipelines p on p.id=l.pipeline_id left join public.crm_stages s on s.id=l.stage_id where p.id is null or s.id is null or p.organization_id is distinct from l.organization_id or s.organization_id is distinct from l.organization_id or s.pipeline_id is distinct from l.pipeline_id);
-- Legado inconsistente não é reparado nem derruba a atualização. As chaves antigas de uma
-- coluna FICAM: a composta não casaria com as linhas legadas, e trocá-las deixaria apagar a
-- etapa/funil a que elas apontam. Lado a lado também não: duas chaves entre as mesmas tabelas
-- tornam ambíguo o join embutido do PostgREST (PGRST201). A troca, validada, acontece no
-- update.sh seguinte ao legado revisto.
if legado_invalido then raise warning 'crm_integrity_legacy_invalid_no_automatic_repair: chaves antigas mantidas; a troca pelas chaves compostas espera o legado ser revisto';end if;
expected:=array[(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='organization_id'and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='id'and not attisdropped)]::smallint[];
 if to_regclass('public.crm_integridade_pipelines_org_id_uq')is null then
  create unique index crm_integridade_pipelines_org_id_uq on public.crm_pipelines(organization_id,id);
  comment on index public.crm_integridade_pipelines_org_id_uq is 'crm-integridade-funil-etapa-v1';
 else
  select i.*,obj_description(i.indexrelid,'pg_class')marker into actual from pg_index i where i.indexrelid=to_regclass('public.crm_integridade_pipelines_org_id_uq');
  if not found or actual.indrelid<>'public.crm_pipelines'::regclass or not actual.indisunique or not actual.indisvalid or not actual.indisready or actual.indpred is not null or actual.indexprs is not null or actual.indnatts<>cardinality(expected)or actual.indnkeyatts<>cardinality(expected)or actual.indkey::text<>array_to_string(expected,' ')or actual.marker is distinct from 'crm-integridade-funil-etapa-v1'then
   raise exception 'crm_integrity_index_name_conflict'using errcode='23514';end if;
 end if;
expected:=array[(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='organization_id'and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='pipeline_id'and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='id'and not attisdropped)]::smallint[];
 if to_regclass('public.crm_integridade_stages_org_pipeline_id_uq')is null then
  create unique index crm_integridade_stages_org_pipeline_id_uq on public.crm_stages(organization_id,pipeline_id,id);
  comment on index public.crm_integridade_stages_org_pipeline_id_uq is 'crm-integridade-funil-etapa-v1';
 else
  select i.*,obj_description(i.indexrelid,'pg_class')marker into actual from pg_index i where i.indexrelid=to_regclass('public.crm_integridade_stages_org_pipeline_id_uq');
  if not found or actual.indrelid<>'public.crm_stages'::regclass or not actual.indisunique or not actual.indisvalid or not actual.indisready or actual.indpred is not null or actual.indexprs is not null or actual.indnatts<>cardinality(expected)or actual.indnkeyatts<>cardinality(expected)or actual.indkey::text<>array_to_string(expected,' ')or actual.marker is distinct from 'crm-integridade-funil-etapa-v1'then
   raise exception 'crm_integrity_index_name_conflict'using errcode='23514';end if;
 end if;
select c.*,obj_description(c.oid,'pg_constraint') marker into actual from pg_constraint c where c.conrelid='public.crm_stages'::regclass and c.conname='crm_stages_pipeline_id_fkey';
 if not found then raise exception 'crm_integrity_required_base_fk_missing' using errcode='23514';end if;
 if actual.contype<>'f' or actual.confrelid<>'public.crm_pipelines'::regclass or actual.confdeltype<>'c' or actual.confupdtype<>'a' or actual.confmatchtype<>'s' or actual.condeferrable or actual.condeferred then raise exception 'crm_integrity_base_fk_conflict' using errcode='23514';end if;
 expected:=array[(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='organization_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='pipeline_id' and not attisdropped)]::smallint[];ref_expected:=array[(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='organization_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='id' and not attisdropped)]::smallint[];
 if actual.conkey=expected and actual.confkey=ref_expected and actual.marker='crm-integridade-funil-etapa-v1' then
  null;
 elsif actual.conkey=array[(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='pipeline_id' and not attisdropped)]::smallint[] and actual.confkey=array[(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='id' and not attisdropped)]::smallint[] and actual.marker is null and actual.convalidated then
  if not legado_invalido then
   alter table public.crm_stages drop constraint crm_stages_pipeline_id_fkey;
   alter table public.crm_stages add constraint crm_stages_pipeline_id_fkey foreign key(organization_id,pipeline_id) references public.crm_pipelines(organization_id,id) on delete cascade not valid;
   comment on constraint crm_stages_pipeline_id_fkey on public.crm_stages is 'crm-integridade-funil-etapa-v1';
  end if;
 else raise exception 'crm_integrity_base_fk_conflict' using errcode='23514';end if;
 if not legado_invalido then alter table public.crm_stages validate constraint crm_stages_pipeline_id_fkey;end if;
select c.*,obj_description(c.oid,'pg_constraint') marker into actual from pg_constraint c where c.conrelid='public.crm_leads'::regclass and c.conname='crm_leads_pipeline_id_fkey';
 if not found then raise exception 'crm_integrity_required_base_fk_missing' using errcode='23514';end if;
 if actual.contype<>'f' or actual.confrelid<>'public.crm_pipelines'::regclass or actual.confdeltype<>'r' or actual.confupdtype<>'a' or actual.confmatchtype<>'s' or actual.condeferrable or actual.condeferred then raise exception 'crm_integrity_base_fk_conflict' using errcode='23514';end if;
 expected:=array[(select attnum from pg_attribute where attrelid='public.crm_leads'::regclass and attname='organization_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_leads'::regclass and attname='pipeline_id' and not attisdropped)]::smallint[];ref_expected:=array[(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='organization_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='id' and not attisdropped)]::smallint[];
 if actual.conkey=expected and actual.confkey=ref_expected and actual.marker='crm-integridade-funil-etapa-v1' then
  null;
 elsif actual.conkey=array[(select attnum from pg_attribute where attrelid='public.crm_leads'::regclass and attname='pipeline_id' and not attisdropped)]::smallint[] and actual.confkey=array[(select attnum from pg_attribute where attrelid='public.crm_pipelines'::regclass and attname='id' and not attisdropped)]::smallint[] and actual.marker is null and actual.convalidated then
  if not legado_invalido then
   alter table public.crm_leads drop constraint crm_leads_pipeline_id_fkey;
   alter table public.crm_leads add constraint crm_leads_pipeline_id_fkey foreign key(organization_id,pipeline_id) references public.crm_pipelines(organization_id,id) on delete restrict not valid;
   comment on constraint crm_leads_pipeline_id_fkey on public.crm_leads is 'crm-integridade-funil-etapa-v1';
  end if;
 else raise exception 'crm_integrity_base_fk_conflict' using errcode='23514';end if;
 if not legado_invalido then alter table public.crm_leads validate constraint crm_leads_pipeline_id_fkey;end if;
select c.*,obj_description(c.oid,'pg_constraint') marker into actual from pg_constraint c where c.conrelid='public.crm_leads'::regclass and c.conname='crm_leads_stage_id_fkey';
 if not found then raise exception 'crm_integrity_required_base_fk_missing' using errcode='23514';end if;
 if actual.contype<>'f' or actual.confrelid<>'public.crm_stages'::regclass or actual.confdeltype<>'r' or actual.confupdtype<>'a' or actual.confmatchtype<>'s' or actual.condeferrable or actual.condeferred then raise exception 'crm_integrity_base_fk_conflict' using errcode='23514';end if;
 expected:=array[(select attnum from pg_attribute where attrelid='public.crm_leads'::regclass and attname='organization_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_leads'::regclass and attname='pipeline_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_leads'::regclass and attname='stage_id' and not attisdropped)]::smallint[];ref_expected:=array[(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='organization_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='pipeline_id' and not attisdropped),(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='id' and not attisdropped)]::smallint[];
 if actual.conkey=expected and actual.confkey=ref_expected and actual.marker='crm-integridade-funil-etapa-v1' then
  null;
 elsif actual.conkey=array[(select attnum from pg_attribute where attrelid='public.crm_leads'::regclass and attname='stage_id' and not attisdropped)]::smallint[] and actual.confkey=array[(select attnum from pg_attribute where attrelid='public.crm_stages'::regclass and attname='id' and not attisdropped)]::smallint[] and actual.marker is null and actual.convalidated then
  if not legado_invalido then
   alter table public.crm_leads drop constraint crm_leads_stage_id_fkey;
   alter table public.crm_leads add constraint crm_leads_stage_id_fkey foreign key(organization_id,pipeline_id,stage_id) references public.crm_stages(organization_id,pipeline_id,id) on delete restrict not valid;
   comment on constraint crm_leads_stage_id_fkey on public.crm_leads is 'crm-integridade-funil-etapa-v1';
  end if;
 else raise exception 'crm_integrity_base_fk_conflict' using errcode='23514';end if;
 if not legado_invalido then alter table public.crm_leads validate constraint crm_leads_stage_id_fkey;end if;
end;
$integridade_funil_etapa$;
