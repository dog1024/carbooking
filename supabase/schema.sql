create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  driver_name text not null check (char_length(btrim(driver_name)) between 1 and 30),
  travel_date timestamptz not null,
  origin text check (origin is null or char_length(btrim(origin)) between 1 and 80),
  waypoints text check (waypoints is null or char_length(btrim(waypoints)) between 1 and 160),
  destination text check (destination is null or char_length(btrim(destination)) between 1 and 80),
  capacity smallint not null check (capacity between 1 and 99),
  remaining_seats smallint not null check (remaining_seats between 0 and capacity),
  contact text not null check (char_length(btrim(contact)) between 1 and 60),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint trips_retention_check check (
    expires_at = created_at + interval '7 days'
    and created_at >= now() - interval '7 days'
    and created_at <= now() + interval '5 minutes'
  )
);

alter table public.trips add column if not exists origin text;
alter table public.trips add column if not exists waypoints text;
alter table public.trips add column if not exists destination text;

do $$
begin
  alter table public.trips
    add constraint trips_origin_check
    check (origin is null or char_length(btrim(origin)) between 1 and 80);
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table public.trips
    add constraint trips_waypoints_check
    check (waypoints is null or char_length(btrim(waypoints)) between 1 and 160);
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table public.trips
    add constraint trips_destination_check
    check (destination is null or char_length(btrim(destination)) between 1 and 80);
exception
  when duplicate_object then null;
end
$$;

create index if not exists trips_travel_date_idx on public.trips (travel_date desc);
create index if not exists trips_expires_at_idx on public.trips (expires_at);

alter table public.trips enable row level security;

drop policy if exists "active trips are publicly readable" on public.trips;
create policy "active trips are publicly readable"
on public.trips for select
to authenticated
using (expires_at > now());

drop policy if exists "users can create their own trips" on public.trips;
create policy "users can create their own trips"
on public.trips for insert
to authenticated
with check (
  auth.uid() = owner_id
  and char_length(btrim(origin)) between 1 and 80
  and char_length(btrim(destination)) between 1 and 80
  and expires_at = created_at + interval '7 days'
  and created_at >= now() - interval '7 days'
  and created_at <= now() + interval '5 minutes'
);

drop policy if exists "owners can update active trips" on public.trips;
create policy "owners can update active trips"
on public.trips for update
to authenticated
using (auth.uid() = owner_id and expires_at > now())
with check (auth.uid() = owner_id and expires_at > now());

drop policy if exists "owners can delete their trips" on public.trips;
create policy "owners can delete their trips"
on public.trips for delete
to authenticated
using (auth.uid() = owner_id);

revoke all on table public.trips from anon, authenticated;
grant select on table public.trips to authenticated;
grant insert (
  driver_name,
  travel_date,
  origin,
  waypoints,
  destination,
  capacity,
  remaining_seats,
  contact,
  owner_id,
  created_at,
  expires_at
) on table public.trips to authenticated;
grant update (remaining_seats) on table public.trips to authenticated;
grant delete on table public.trips to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.trips;
exception
  when duplicate_object then null;
end
$$;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'delete-expired-carpool-trips'
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'delete-expired-carpool-trips',
    '0 * * * *',
    'delete from public.trips where expires_at <= now()'
  );
end
$$;
