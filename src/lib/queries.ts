import { sql } from "@/lib/db";
import { ALL_SLOT_INDEXES, coveredSlots } from "@/lib/time";
import type {
  Booking,
  CandidateSource,
  CandidateSummary,
  Panel,
  SessionType,
  Slot,
  SlotStatus,
} from "@/lib/types";

type PanelRow = { id: string; label: string };

type BookingRow = {
  id: string;
  panel_id: string;
  candidate_id: string;
  candidate_name: string;
  company_name: string;
  session_type: SessionType;
  slot_date: string;
  slot_index: number;
  slot_count: number;
  recruiter_phone: string | null;
  recruiter_email: string | null;
  needs_mock: boolean;
};

function toBooking(row: BookingRow, viewerCandidateId: string | null): Booking {
  return {
    id: row.id,
    panelId: row.panel_id,
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
    companyName: row.company_name,
    sessionType: row.session_type,
    slotDate: row.slot_date,
    slotIndex: Number(row.slot_index),
    slotCount: Number(row.slot_count),
    recruiterPhone: row.recruiter_phone,
    recruiterEmail: row.recruiter_email,
    needsMock: Boolean(row.needs_mock),
    isOwn: viewerCandidateId !== null && row.candidate_id === viewerCandidateId,
  };
}

/**
 * Candidates see that a block is taken, but not who took it or why - only
 * their own bookings come back with details attached.
 */
function redactForCandidate(booking: Booking): Booking {
  if (booking.isOwn) return booking;
  return {
    ...booking,
    candidateId: "",
    candidateName: "",
    companyName: "",
    recruiterPhone: null,
    recruiterEmail: null,
    needsMock: false,
    sessionType: booking.sessionType,
  };
}

export async function listPanels(): Promise<Panel[]> {
  const rows = await sql<PanelRow[]>`
    select id, label
      from panels
     where active
     order by sort_order, id
  `;
  return rows.map((row) => ({ id: row.id, label: row.label }));
}

export async function findPanel(panelId: string): Promise<Panel | null> {
  const rows = await sql<PanelRow[]>`
    select id, label from panels where id = ${panelId} and active limit 1
  `;
  return rows[0] ? { id: rows[0].id, label: rows[0].label } : null;
}

/**
 * Panels with nothing booked at this exact time, in display order.
 *
 * Availability is a consolidated figure across panels - a candidate only picks
 * a time, and one of these panels is allocated to them.
 */
/**
 * Panels with nothing overlapping [slotIndex, slotIndex + slotCount), in
 * allocation order - lowest sort_order first.
 *
 * The overlap test has to be a range comparison: a 2-hour session starting at
 * 09:00 blocks 10:00 even though its slot_index is different.
 */
export async function listFreePanels(
  date: string,
  slotIndex: number,
  slotCount: number,
): Promise<Panel[]> {
  const rows = await sql<PanelRow[]>`
    select p.id, p.label
      from panels p
     where p.active
       and not exists (
             select 1
               from panel_closures pc
              where pc.panel_id  = p.id
                and pc.closed_on = ${date}::date
           )
       and not exists (
             select 1
               from bookings b
              where b.panel_id  = p.id
                and b.slot_date = ${date}::date
                and b.status    = 'booked'
                and int4range(b.slot_index, b.slot_index + b.slot_count)
                 && int4range(${slotIndex}::int, ${slotIndex}::int + ${slotCount}::int)
           )
     order by p.sort_order, p.id
  `;
  return rows.map((row) => ({ id: row.id, label: row.label }));
}


export async function listCandidates(): Promise<CandidateSummary[]> {
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name
      from candidates
     where active
     order by name
  `;
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export async function findCandidateByToken(
  token: string,
): Promise<CandidateSummary | null> {
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name
      from candidates
     where token = ${token}
       and active
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name };
}

async function bookingsFor(
  date: string,
  panelId: string | null,
): Promise<BookingRow[]> {
  return sql<BookingRow[]>`
    select b.id,
           b.panel_id,
           b.candidate_id,
           c.name as candidate_name,
           b.company_name,
           b.session_type,
           to_char(b.slot_date, 'YYYY-MM-DD') as slot_date,
           b.slot_index,
           b.slot_count,
           b.recruiter_phone,
           b.recruiter_email,
           (mc.candidate_id is null) as needs_mock
      from bookings b
      join candidates c on c.id = b.candidate_id
      -- One mock clears a candidate for the whole day, so the tick is matched
      -- on (candidate, date) rather than on the booking.
      left join mock_completions mc
        on mc.candidate_id = b.candidate_id
       and mc.mock_date    = b.slot_date
     where b.status = 'booked'
       and b.slot_date = ${date}::date
       ${panelId ? sql`and b.panel_id = ${panelId}` : sql``}
     order by b.slot_index
  `;
}

/**
 * The booking day as the timetable renders it: every panel folded into one
 * column of half-hour blocks, with the panels still free at each time.
 */
export async function getDayView(
  date: string,
  panels: Panel[],
  viewerCandidateId: string | null,
  closedPanelIds: string[] = [],
): Promise<Slot[]> {
  const closed = new Set(closedPanelIds);
  const openPanels = panels.filter((panel) => !closed.has(panel.id));
  const rows = await bookingsFor(date, null);
  const bySlot = new Map<number, Booking[]>();

  for (const row of rows) {
    const booking = toBooking(row, viewerCandidateId);
    const visible =
      viewerCandidateId === null ? booking : redactForCandidate(booking);

    // A 2-hour session blocks all four of its half-hour blocks, so it is
    // listed against each one. Callers that want it once can filter on
    // booking.slotIndex === slot.index.
    for (const index of coveredSlots(booking.slotIndex, booking.slotCount)) {
      const list = bySlot.get(index) ?? [];
      list.push(visible);
      bySlot.set(index, list);
    }
  }

  return ALL_SLOT_INDEXES.map<Slot>((index) => {
    const bookings = bySlot.get(index) ?? [];
    const taken = new Set(bookings.map((booking) => booking.panelId));
    const freePanelIds = openPanels
      .filter((panel) => !taken.has(panel.id))
      .map((panel) => panel.id);

    // "unavailable" is a different answer from "booked": nothing is running
    // here at all, so the candidate is told the panels are shut rather than
    // that someone else got in first.
    const status: SlotStatus =
      openPanels.length === 0
        ? "unavailable"
        : freePanelIds.length > 0
          ? "available"
          : "booked";

    return {
      index,
      status,
      freePanelIds,
      bookings,
    };
  });
}

/** Every panel's bookings for a date, for the controller grid. */
export async function getScheduleView(date: string): Promise<Booking[]> {
  const rows = await bookingsFor(date, null);
  return rows.map((row) => toBooking(row, null));
}

// --- controllers ------------------------------------------------------------

export type ControllerRecord = {
  id: string;
  username: string;
  name: string;
  passwordHash: string;
};

export async function findControllerByUsername(
  username: string,
): Promise<ControllerRecord | null> {
  const rows = await sql<
    { id: string; username: string; name: string; password_hash: string }[]
  >`
    select id, username, name, password_hash
      from controllers
     where username = ${username}
       and active
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    passwordHash: row.password_hash,
  };
}

export async function findControllerById(
  id: string,
): Promise<ControllerRecord | null> {
  const rows = await sql<
    { id: string; username: string; name: string; password_hash: string }[]
  >`
    select id, username, name, password_hash
      from controllers
     where id = ${id}
       and active
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    passwordHash: row.password_hash,
  };
}

export async function updateControllerPassword(
  id: string,
  passwordHash: string,
): Promise<void> {
  await sql`
    update controllers
       set password_hash = ${passwordHash},
           updated_at    = now()
     where id = ${id}
  `;
}

// --- candidate administration ----------------------------------------------

export type CandidateRecord = {
  id: string;
  token: string;
  name: string;
  phone: string | null;
  source: CandidateSource;
  /** The candidate's own company, not the one they interview with. */
  company: string | null;
  active: boolean;
  bookingCount: number;
  /** When the token was issued; the roster is newest-first. */
  createdAt: string;
};

/** Full roster for the controller's Candidates page, disabled ones included. */
export async function listCandidateRecords(): Promise<CandidateRecord[]> {
  const rows = await sql<
    {
      id: string;
      token: string;
      name: string;
      phone: string | null;
      source: CandidateSource;
      company: string | null;
      active: boolean;
      booking_count: number;
      created_at: string;
    }[]
  >`
    select c.id,
           c.token,
           c.name,
           c.phone,
           c.source,
           c.company,
           c.active,
           c.created_at,
           count(b.id) filter (where b.status = 'booked')::int as booking_count
      from candidates c
      left join bookings b on b.candidate_id = c.id
     group by c.id
     order by c.created_at desc, c.token
  `;

  return rows.map((row) => ({
    id: row.id,
    token: row.token,
    name: row.name,
    phone: row.phone,
    source: row.source,
    company: row.company,
    active: row.active,
    bookingCount: Number(row.booking_count),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/**
 * Enables or disables several tokens at once. Reversible, unlike deletion, so
 * it leaves bookings alone: a disabled candidate simply cannot sign in.
 */
/** Names for a set of candidates, for audit sentences. */
export async function describeCandidates(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];

  const rows = await sql<{ name: string; token: string }[]>`
    select name, token from candidates where id = any(${ids}::uuid[]) order by name
  `;
  return rows.map((row) => `${row.name} (${row.token})`);
}

export async function setCandidatesActive(
  ids: string[],
  active: boolean,
): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = await sql<{ id: string }[]>`
    update candidates
       set active = ${active}
     where id = any(${ids}::uuid[])
     returning id
  `;
  return rows.length;
}

/**
 * Permanently removes candidates and, by cascade, every booking they hold.
 * Returns what was removed so the caller can say so plainly.
 */
export async function deleteCandidates(
  ids: string[],
): Promise<{ deleted: number; bookingsRemoved: number }> {
  if (ids.length === 0) return { deleted: 0, bookingsRemoved: 0 };

  const [counted] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from bookings
     where candidate_id = any(${ids}::uuid[])
       and status = 'booked'
  `;

  const removed = await sql<{ id: string }[]>`
    delete from candidates where id = any(${ids}::uuid[]) returning id
  `;

  return { deleted: removed.length, bookingsRemoved: Number(counted.n) };
}

export async function insertCandidate(input: {
  token: string;
  name: string;
  phone: string | null;
  source: CandidateSource;
  company: string | null;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into candidates (token, name, phone, source, company)
    values (${input.token}, ${input.name}, ${input.phone},
            ${input.source}, ${input.company})
    returning id
  `;
  return rows[0].id;
}

/** Enough about an existing candidate to point a controller at them. */
export type PhoneHolder = {
  id: string;
  token: string;
  name: string;
  active: boolean;
};

/**
 * Who already holds a phone number, disabled tokens included: a disabled
 * candidate is still that person, and gets re-enabled rather than duplicated.
 * `key` is phoneKey() of the number, matched against candidates.phone_key.
 */
export async function findCandidateByPhoneKey(
  key: string,
): Promise<PhoneHolder | null> {
  const rows = await sql<PhoneHolder[]>`
    select id, token, name, active
      from candidates
     where phone_key = ${key}
     order by created_at
     limit 1
  `;
  return rows[0] ?? null;
}

export async function setCandidateActive(
  id: string,
  active: boolean,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update candidates set active = ${active} where id = ${id} returning id
  `;
  return rows.length > 0;
}

// --- candidate history ------------------------------------------------------

export type CandidateSession = {
  id: string;
  slotDate: string;
  slotIndex: number;
  slotCount: number;
  panelId: string;
  companyName: string;
  sessionType: SessionType;
  recruiterPhone: string | null;
  recruiterEmail: string | null;
  status: "booked" | "cancelled";
  bookedBy: "candidate" | "controller";
  createdAt: string;
};

export type CandidateHistory = {
  candidate: CandidateRecord;
  sessions: CandidateSession[];
  /** Dates on which this candidate's mock was ticked off. */
  mockDates: string[];
};

/**
 * Everything on file for one candidate.
 *
 * Cancelled sessions are kept rather than filtered out: the point of a history
 * is to answer "what happened", and a session that was booked and then dropped
 * is part of that answer.
 */
export async function getCandidateHistory(
  id: string,
): Promise<CandidateHistory | null> {
  const rows = await sql<
    {
      id: string;
      token: string;
      name: string;
      phone: string | null;
      source: CandidateSource;
      company: string | null;
      active: boolean;
      created_at: string;
    }[]
  >`
    select id, token, name, phone, source, company, active, created_at
      from candidates
     where id = ${id}
     limit 1
  `;

  const row = rows[0];
  if (!row) return null;

  const sessions = await sql<
    {
      id: string;
      slot_date: string;
      slot_index: number;
      slot_count: number;
      panel_id: string;
      company_name: string;
      session_type: SessionType;
      recruiter_phone: string | null;
      recruiter_email: string | null;
      status: "booked" | "cancelled";
      booked_by: "candidate" | "controller";
      created_at: string;
    }[]
  >`
    select id,
           to_char(slot_date, 'YYYY-MM-DD') as slot_date,
           slot_index,
           slot_count,
           panel_id,
           company_name,
           session_type,
           recruiter_phone,
           recruiter_email,
           status,
           booked_by,
           created_at
      from bookings
     where candidate_id = ${id}
     order by slot_date desc, slot_index desc
  `;

  const mocks = await sql<{ mock_date: string }[]>`
    select to_char(mock_date, 'YYYY-MM-DD') as mock_date
      from mock_completions
     where candidate_id = ${id}
     order by mock_date desc
  `;

  const booked = sessions.filter((s) => s.status === 'booked').length;

  return {
    candidate: {
      id: row.id,
      token: row.token,
      name: row.name,
      phone: row.phone,
      source: row.source,
      company: row.company,
      active: row.active,
      bookingCount: booked,
      createdAt: new Date(row.created_at).toISOString(),
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      slotDate: s.slot_date,
      slotIndex: Number(s.slot_index),
      slotCount: Number(s.slot_count),
      panelId: s.panel_id,
      companyName: s.company_name,
      sessionType: s.session_type,
      recruiterPhone: s.recruiter_phone,
      recruiterEmail: s.recruiter_email,
      status: s.status,
      bookedBy: s.booked_by,
      createdAt: new Date(s.created_at).toISOString(),
    })),
    mockDates: mocks.map((m) => m.mock_date),
  };
}
