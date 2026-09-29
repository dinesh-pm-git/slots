-- ---------------------------------------------------------------------------
-- Panel slot booking - schema
-- Target: PostgreSQL 13+ (Supabase, Neon, or self-hosted)
-- Safe to run repeatedly.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- Needed by the range-overlap guards on bookings: an exclusion constraint that
-- mixes equality on plain columns with && on a range needs GiST operator
-- classes for the plain types.
create extension if not exists btree_gist;

-- Interview panels, e.g. CELL1 / CELL2 / CELL3 -------------------------------
create table if not exists panels (
  id          text primary key,
  label       text        not null,
  sort_order  integer     not null default 0,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- Controllers sign in with a username and their own password ----------------
create table if not exists controllers (
  id            uuid        primary key default gen_random_uuid(),
  username      text        not null unique,
  name          text        not null,
  password_hash text        not null,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Candidates. A candidate signs in with their token. No panel is stored here:
-- a candidate can be allocated to a different panel for every booking, so the
-- panel lives on the booking row instead.
-- Tokens are four uppercase alphanumeric characters.
create table if not exists candidates (
  id          uuid        primary key default gen_random_uuid(),
  token       text        not null unique check (token ~ '^[A-Z0-9]{4}$'),
  name        text        not null,
  email       text,
  -- Required and unique in practice: see "One candidate per phone number"
  -- at the end of this file.
  phone       text,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- A booked session on a panel -----------------------------------------------
-- slot_index 0 == 07:00 and each step is 30 minutes, so a session runs from
-- slot_index for slot_count blocks: 1 = 30 min, 2 = 1 hour, 3 = 90 min,
-- 4 = 2 hours. slot_index + slot_count may not run past 20:00 (slot 26).
create table if not exists bookings (
  id            uuid        primary key default gen_random_uuid(),
  panel_id      text        not null references panels (id) on update cascade,
  candidate_id  uuid        not null references candidates (id) on delete cascade,
  slot_date     date        not null,
  slot_index    smallint    not null check (slot_index between 0 and 25),
  slot_count    smallint    not null default 1
                constraint bookings_slot_count_range check (slot_count between 1 and 4),
  company_name  text        not null check (length(btrim(company_name)) > 0),
  session_type  text        not null check (session_type in ('Interview', 'Assessment')),
  -- Who to call about this session. Optional: often not known at booking time.
  recruiter_phone text,
  recruiter_email text,
  status        text        not null default 'booked' check (status in ('booked', 'cancelled')),
  booked_by     text        not null default 'candidate' check (booked_by in ('candidate', 'controller')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  constraint bookings_within_day check (slot_index + slot_count <= 26)
);

-- Migrations for databases created before sessions had a length. These run
-- before the constraints below, which reference slot_count.
alter table bookings add column if not exists slot_count smallint not null default 1;
alter table bookings add column if not exists recruiter_phone text;
alter table bookings add column if not exists recruiter_email text;

do $length_checks$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_slot_count_range'
  ) then
    alter table bookings add constraint bookings_slot_count_range
      check (slot_count between 1 and 4);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bookings_within_day'
  ) then
    alter table bookings add constraint bookings_within_day
      check (slot_index + slot_count <= 26);
  end if;
end
$length_checks$;

-- The old single-slot unique indexes cannot express range overlap, so they are
-- replaced rather than kept alongside.
drop index if exists bookings_one_per_slot;
drop index if exists bookings_one_per_candidate_slot;

-- These two exclusion constraints are what actually prevent double-booking.
--
-- A unique index cannot do this job once sessions have a length: a 2-hour
-- booking at 09:00 and a 30-minute one at 10:00 have different slot_index
-- values, so a unique index on slot_index would wave both through. The
-- half-open range [slot_index, slot_index + slot_count) with && catches the
-- overlap, and abutting sessions (one ending where the next starts) are fine.
--
-- Concurrency is handled by the database, not by a check-then-insert in the
-- API, which loses the race when two requests both read "no clash" before
-- either inserts. The loser gets a 23P01 and the API turns that into a 409.
do $panel_overlap$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_no_panel_overlap'
  ) then
    alter table bookings add constraint bookings_no_panel_overlap
      exclude using gist (
        panel_id  with =,
        slot_date with =,
        int4range(slot_index, slot_index + slot_count) with &&
      ) where (status = 'booked');
  end if;
end
$panel_overlap$;

-- A candidate may hold several sessions in a day - panels are allocated per
-- booking - but never two that overlap in time.
do $candidate_overlap$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_no_candidate_overlap'
  ) then
    alter table bookings add constraint bookings_no_candidate_overlap
      exclude using gist (
        candidate_id with =,
        slot_date    with =,
        int4range(slot_index, slot_index + slot_count) with &&
      ) where (status = 'booked');
  end if;
end
$candidate_overlap$;

create index if not exists bookings_day_idx
  on bookings (slot_date, panel_id)
  where status = 'booked';

create index if not exists bookings_candidate_idx
  on bookings (candidate_id, slot_date)
  where status = 'booked';

-- Audit trail for controller moves ------------------------------------------
create table if not exists booking_moves (
  id              bigserial   primary key,
  booking_id      uuid        not null references bookings (id) on delete cascade,
  moved_by        uuid        references controllers (id),
  from_panel_id   text        not null,
  from_slot_date  date        not null,
  from_slot_index smallint    not null,
  to_panel_id     text        not null,
  to_slot_date    date        not null,
  to_slot_index   smallint    not null,
  moved_at        timestamptz not null default now()
);

create index if not exists booking_moves_booking_idx on booking_moves (booking_id);

-- Migrations for databases created before named controllers existed ---------
alter table booking_moves add column if not exists moved_by uuid references controllers (id);

do $migrate$
declare
  bad_tokens integer;
begin
  if not exists (
    select 1 from pg_constraint where conname = 'candidates_token_check'
  ) then
    select count(*) into bad_tokens
      from candidates where token !~ '^[A-Z0-9]{4}$';

    if bad_tokens > 0 then
      raise notice
        'Skipping the 4-character token constraint: % existing token(s) do not match. Reissue them, then re-run this script.',
        bad_tokens;
    else
      alter table candidates
        add constraint candidates_token_check check (token ~ '^[A-Z0-9]{4}$');
    end if;
  end if;
end
$migrate$;

alter table candidates add column if not exists phone text;

-- Candidates used to be pinned to one panel. They are allocated per booking
-- now, so the column and its index go.
drop index if exists candidates_panel_idx;
alter table candidates drop column if exists panel_id;

-- Controller audit trail -----------------------------------------------------
-- One row per action worth answering "who changed this, and when" about.
--
-- `summary` is the finished English sentence, written at the time of the
-- action. Storing it rather than rebuilding it on read means the log still
-- reads correctly after the code that produced it changes, and keeps the
-- Audit Logs page a plain list.
create table if not exists audit_logs (
  id            bigserial   primary key,
  occurred_at   timestamptz not null default now(),
  actor_role    text        not null check (actor_role in ('controller', 'candidate', 'system')),
  actor_id      uuid,
  actor_name    text        not null,
  action        text        not null,
  summary       text        not null,
  subject_label text,
  details       jsonb       not null default '{}'::jsonb
);

create index if not exists audit_logs_recent_idx on audit_logs (occurred_at desc);
create index if not exists audit_logs_action_idx on audit_logs (action);
create index if not exists audit_logs_actor_idx on audit_logs (actor_name);

-- Panel closures -------------------------------------------------------------
-- A controller can take a whole panel out of service for one day, even when it
-- already has bookings. Those bookings are re-seated or pushed to the waiting
-- list at the moment of closure; this table only records that the panel is shut.
create table if not exists panel_closures (
  id         uuid        primary key default gen_random_uuid(),
  panel_id   text        not null references panels (id) on update cascade,
  closed_on  date        not null,
  reason     text,
  closed_by  uuid        references controllers (id),
  created_at timestamptz not null default now(),
  constraint panel_closures_once unique (panel_id, closed_on)
);

create index if not exists panel_closures_day_idx on panel_closures (closed_on);

-- Waiting list ---------------------------------------------------------------
-- Somewhere for a request to live when every panel at that time is taken, or
-- when a closure pushed a booking out. Order is strictly by created_at: that is
-- what makes it first in, first out, so position is derived rather than stored
-- (a stored position would have to be renumbered on every removal).
create table if not exists waiting_list (
  id             uuid        primary key default gen_random_uuid(),
  candidate_id   uuid        not null references candidates (id) on delete cascade,
  slot_date      date        not null,
  slot_index     smallint    not null check (slot_index between 0 and 25),
  slot_count     smallint    not null default 1 check (slot_count between 1 and 4),
  company_name   text        not null check (length(btrim(company_name)) > 0),
  session_type   text        not null check (session_type in ('Interview', 'Assessment')),
  -- Carried through so being seated later keeps the contact the candidate gave.
  recruiter_phone text,
  recruiter_email text,
  status         text        not null default 'waiting'
                 check (status in ('waiting', 'placed', 'cancelled')),
  -- Why they are waiting, so the candidate can be told the right thing.
  reason         text        not null default 'slot_full'
                 check (reason in ('slot_full', 'panel_closed')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  placed_booking_id uuid     references bookings (id) on delete set null
);

alter table waiting_list add column if not exists recruiter_phone text;
alter table waiting_list add column if not exists recruiter_email text;

create index if not exists waiting_list_queue_idx
  on waiting_list (slot_date, slot_index, created_at)
  where status = 'waiting';

create index if not exists waiting_list_candidate_idx
  on waiting_list (candidate_id, slot_date)
  where status = 'waiting';

-- One live waiting entry per candidate per time, for the same reason bookings
-- cannot overlap: a person cannot be in two queues for one moment.
create unique index if not exists waiting_list_one_per_candidate_slot
  on waiting_list (candidate_id, slot_date, slot_index)
  where status = 'waiting';

-- Closing a panel reshuffles the day in FIFO order, which means a session may
-- move onto a panel that another session is about to vacate. With an immediate
-- constraint that intermediate state is rejected, so the panel-overlap guard is
-- made DEFERRABLE: still checked immediately for ordinary inserts, but the
-- closure transaction defers it to commit, when the arrangement is valid again.
do $deferrable_overlap$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'bookings_no_panel_overlap' and not condeferrable
  ) then
    alter table bookings drop constraint bookings_no_panel_overlap;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bookings_no_panel_overlap'
  ) then
    alter table bookings add constraint bookings_no_panel_overlap
      exclude using gist (
        panel_id  with =,
        slot_date with =,
        int4range(slot_index, slot_index + slot_count) with &&
      ) where (status = 'booked')
      deferrable initially immediate;
  end if;
end
$deferrable_overlap$;

-- Mock register ---------------------------------------------------------------
-- A candidate sits one mock per day. Once it is done they are cleared for every
-- interview they hold on that date, so "completed" belongs to the pair
-- (candidate, date) and not to a single booking - hence the unique constraint
-- rather than a column on bookings. The same candidate booked across three days
-- has three rows here, one per date, each ticked off on its own.
create table if not exists mock_completions (
  id           uuid        primary key default gen_random_uuid(),
  candidate_id uuid        not null references candidates (id) on delete cascade,
  mock_date    date        not null,
  completed_by uuid        references controllers (id),
  completed_at timestamptz not null default now(),
  constraint mock_completions_once unique (candidate_id, mock_date)
);

create index if not exists mock_completions_day_idx on mock_completions (mock_date);

-- Where a candidate came from, and the company they are attached to --------
-- `source` distinguishes a walk-in from one of ours; `company` is optional
-- because it is often not known when the token is issued. Note this is the
-- candidate's own company, which is not the same as bookings.company_name -
-- that records who they are interviewing with for one session.
alter table candidates add column if not exists source text not null default 'Uniq';
alter table candidates add column if not exists company text;

do $candidate_source$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'candidates_source_check'
  ) then
    alter table candidates
      add constraint candidates_source_check check (source in ('Direct', 'Uniq'));
  end if;
end
$candidate_source$;

-- One candidate per phone number ---------------------------------------------
-- The phone number is who a candidate is. It is kept as typed, for display;
-- `phone_key` is what makes two spellings of it the same number. Only the
-- digits count, and a leading 91 or 0 in front of a ten-digit Indian number is
-- dropped, so "+91 98400 10001", "098400 10001" and "9840010001" are all
-- 9840010001. src/lib/phone.ts makes the same reduction so the API can name
-- who already holds a number; the index below is what enforces it, so two
-- controllers registering one number at once cannot both succeed.
alter table candidates add column if not exists phone_key text
  generated always as (
    nullif(
      regexp_replace(
        regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'),
        '^(0091|91|0)([0-9]{10})$', '\2'),
      '')
  ) stored;

-- Both guards are added only once the data already satisfies them, so this
-- script still runs against a database holding duplicates. It names them
-- instead, and nothing is merged or deleted automatically: which record
-- survives, and whose bookings move to it, is a person's decision. Until the
-- index exists the API still refuses a number that is already registered.
do $candidate_phone$
declare
  clashes  text;
  unusable text;
begin
  if not exists (
    select 1 from pg_indexes where indexname = 'candidates_phone_unique'
  ) then
    select string_agg(format('%s held by %s', phone_key, holders), '; ')
      into clashes
      from (
        select phone_key,
               string_agg(format('%s %s', token, name), ', ' order by created_at) as holders
          from candidates
         where phone_key is not null
         group by phone_key
        having count(*) > 1
      ) repeated;

    if clashes is not null then
      raise notice
        'Skipping the unique phone index: these numbers belong to more than one candidate. Merge or correct them, then re-run this script. %',
        clashes;
    else
      create unique index candidates_phone_unique on candidates (phone_key);
    end if;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'candidates_phone_required'
  ) then
    select string_agg(format('%s %s (%s)', token, name, coalesce(phone, 'no phone')), ', ')
      into unusable
      from candidates
     where phone_key is null or phone_key !~ '^[0-9]{10,15}$';

    if unusable is not null then
      raise notice
        'Skipping the phone-required check: these candidates have no usable phone number. Correct them, then re-run this script. %',
        unusable;
    else
      alter table candidates add constraint candidates_phone_required
        check (phone_key is not null and phone_key ~ '^[0-9]{10,15}$');
    end if;
  end if;
end
$candidate_phone$;
