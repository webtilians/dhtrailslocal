-- DH Trails Local - Supabase / PostgreSQL schema v0.3
-- Run once in the Supabase SQL Editor as a project administrator.
-- Auth is handled by Supabase Auth. NEVER put a service_role/secret key in browser code.
create extension if not exists pgcrypto;

create table if not exists public.pilot_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

create table if not exists public.circuits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  reference_points jsonb not null check (
    jsonb_typeof(reference_points) = 'array'
    and jsonb_array_length(reference_points) between 16 and 12000
  ),
  gate_radius_m integer not null default 18 check (gate_radius_m between 3 and 80),
  visibility text not null default 'private' check (visibility in ('private','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists circuits_owner_idx on public.circuits(owner_id, updated_at desc);

create table if not exists public.circuit_sectors (
  id uuid primary key default gen_random_uuid(),
  circuit_id uuid not null references public.circuits(id) on delete cascade,
  sort_order integer not null check (sort_order between 0 and 100),
  gate_index integer not null check (gate_index >= 1),
  name text not null check (char_length(btrim(name)) between 1 and 70),
  unique (circuit_id,sort_order),
  unique (circuit_id,gate_index)
);
create index if not exists circuit_sectors_circuit_idx on public.circuit_sectors(circuit_id,sort_order);

create table if not exists public.circuit_weak_zones (
  id uuid primary key default gen_random_uuid(),
  circuit_id uuid not null references public.circuits(id) on delete cascade,
  from_index integer not null check (from_index >= 0),
  to_index integer not null check (to_index > from_index),
  name text not null check (char_length(btrim(name)) between 1 and 70)
);
create index if not exists circuit_weak_zones_circuit_idx on public.circuit_weak_zones(circuit_id);

-- Private, unverified GPS summaries. They are NOT official competition results.
create table if not exists public.training_attempts (
  id uuid primary key default gen_random_uuid(),
  circuit_id uuid not null references public.circuits(id) on delete cascade,
  pilot_id uuid not null references auth.users(id) on delete cascade,
  source_filename text check (char_length(source_filename) <= 200),
  started_at timestamptz,
  elapsed_ms integer check (elapsed_ms is null or elapsed_ms >= 0),
  sector_splits_ms jsonb not null default '[]'::jsonb check (jsonb_typeof(sector_splits_ms) = 'array'),
  confidence numeric(5,4) check (confidence between 0 and 1),
  gps_status text not null default 'review' check (gps_status in ('review','compatible')),
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists attempts_pilot_idx on public.training_attempts(pilot_id,created_at desc);
create index if not exists attempts_circuit_idx on public.training_attempts(circuit_id,created_at desc);

create or replace function public.touch_circuit_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at=now();return new;end $$;
drop trigger if exists circuits_updated_at on public.circuits;
create trigger circuits_updated_at before update on public.circuits
for each row execute function public.touch_circuit_updated_at();

-- RLS: no direct access to other riders' private data.
alter table public.pilot_profiles enable row level security;
alter table public.circuits enable row level security;
alter table public.circuit_sectors enable row level security;
alter table public.circuit_weak_zones enable row level security;
alter table public.training_attempts enable row level security;

drop policy if exists pilot_profile_self on public.pilot_profiles;
create policy pilot_profile_self on public.pilot_profiles for all to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists circuits_owner_all on public.circuits;
create policy circuits_owner_all on public.circuits for all to authenticated
using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Public reading is intentionally not enabled yet. "visibility" is reserved
-- for moderated public circuit publishing in a future version.

drop policy if exists sectors_owner_all on public.circuit_sectors;
create policy sectors_owner_all on public.circuit_sectors for all to authenticated
using (exists (select 1 from public.circuits c where c.id = circuit_id and c.owner_id = (select auth.uid())))
with check (exists (select 1 from public.circuits c where c.id = circuit_id and c.owner_id = (select auth.uid())));

drop policy if exists zones_owner_all on public.circuit_weak_zones;
create policy zones_owner_all on public.circuit_weak_zones for all to authenticated
using (exists (select 1 from public.circuits c where c.id = circuit_id and c.owner_id = (select auth.uid())))
with check (exists (select 1 from public.circuits c where c.id = circuit_id and c.owner_id = (select auth.uid())));

drop policy if exists attempts_owner_select on public.training_attempts;
create policy attempts_owner_select on public.training_attempts for select to authenticated
using (pilot_id = (select auth.uid()));

drop policy if exists attempts_owner_insert on public.training_attempts;
create policy attempts_owner_insert on public.training_attempts for insert to authenticated
with check (
  pilot_id = (select auth.uid()) and
  exists (select 1 from public.circuits c where c.id = circuit_id and c.owner_id = (select auth.uid()))
);

drop policy if exists attempts_owner_delete on public.training_attempts;
create policy attempts_owner_delete on public.training_attempts for delete to authenticated
using (pilot_id = (select auth.uid()));

-- IMPORTANT: no authenticated UPDATE policy for attempts, so clients cannot
-- retrospectively change times. This remains personal training data.

-- Store a circuit and its sector / bad coverage boundaries atomically.
-- SECURITY INVOKER + RLS prevents writing into another user's circuits.
create or replace function public.save_circuit(
  p_name text,
  p_points jsonb,
  p_sectors jsonb default '[]'::jsonb,
  p_weak_zones jsonb default '[]'::jsonb,
  p_gate_radius integer default 18,
  p_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_length integer;
  v_gate jsonb;
  v_zone jsonb;
  v_order integer := 0;
  v_index integer;
  v_previous integer := 0;
  v_from integer;
  v_to integer;
begin
  if v_uid is null then raise exception 'Debes iniciar sesión'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    raise exception 'Nombre de circuito inválido';
  end if;
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    raise exception 'Puntos GPS inválidos';
  end if;
  v_length := jsonb_array_length(p_points);
  if v_length < 16 or v_length > 12000 then raise exception 'Longitud de circuito no admitida'; end if;
  if p_sectors is null or jsonb_typeof(p_sectors) <> 'array' or jsonb_array_length(p_sectors) > 100 then
    raise exception 'Sectores inválidos';
  end if;
  if p_weak_zones is null or jsonb_typeof(p_weak_zones) <> 'array' or jsonb_array_length(p_weak_zones) > 100 then
    raise exception 'Zonas GPS inválidas';
  end if;
  if p_gate_radius not between 3 and 80 then raise exception 'Radio de puerta inválido'; end if;

  if p_id is null then
    insert into public.circuits(owner_id,name,reference_points,gate_radius_m)
    values (v_uid,btrim(p_name),p_points,p_gate_radius) returning id into v_id;
  else
    update public.circuits
      set name=btrim(p_name),reference_points=p_points,gate_radius_m=p_gate_radius
    where id=p_id and owner_id=v_uid returning id into v_id;
    if v_id is null then raise exception 'Circuito no encontrado o sin permiso'; end if;
    delete from public.circuit_sectors where circuit_id=v_id;
    delete from public.circuit_weak_zones where circuit_id=v_id;
  end if;

  for v_gate in select value from jsonb_array_elements(p_sectors)
    order by (value->>'index')::integer
  loop
    v_index := (v_gate->>'index')::integer;
    if v_index <= v_previous or v_index >= v_length-1 then
      raise exception 'Puertas de sector fuera de orden o de recorrido';
    end if;
    insert into public.circuit_sectors(circuit_id,sort_order,gate_index,name)
    values (v_id,v_order,v_index,left(coalesce(nullif(btrim(v_gate->>'name'),''),'Sector '||(v_order+1)),70));
    v_order := v_order+1;
    v_previous := v_index;
  end loop;

  for v_zone in select value from jsonb_array_elements(p_weak_zones)
  loop
    v_from := (v_zone->>'from')::integer;
    v_to := (v_zone->>'to')::integer;
    if v_from < 0 or v_to >= v_length or v_to <= v_from then
      raise exception 'Zona GPS débil fuera del recorrido';
    end if;
    insert into public.circuit_weak_zones(circuit_id,from_index,to_index,name)
    values (v_id,v_from,v_to,left(coalesce(nullif(btrim(v_zone->>'name'),''),'GPS débil'),70));
  end loop;
  return v_id;
end;
$$;

revoke all on function public.save_circuit(text,jsonb,jsonb,jsonb,integer,uuid) from public, anon;
grant execute on function public.save_circuit(text,jsonb,jsonb,jsonb,integer,uuid) to authenticated;
grant select, insert, update, delete on public.pilot_profiles, public.circuits, public.circuit_sectors, public.circuit_weak_zones to authenticated;
grant select, insert, delete on public.training_attempts to authenticated;
revoke update on public.training_attempts from authenticated;
