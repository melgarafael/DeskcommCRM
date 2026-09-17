-- Evolução aditiva exclusivamente da fixture. Clientes v1 ignoram label.
alter table bench_state.records add column if not exists label text;
update bench_state.inventory set personal_columns=array['legacy_note','label'] where relation_name='records';
update bench_state.installation set schema_version=2 where id=1;
