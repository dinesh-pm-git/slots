import { sql } from "@/lib/db";
import { listPanels } from "@/lib/queries";
import {
  SCHEDULE_TIMEZONE,
  SLOT_COUNT,
  SLOT_MINUTES,
  fromDateKey,
  isSlotInPast,
  isValidDateKey,
  shiftDateKey,
  slotStartMinutes,
  toDateKey,
  todayKey,
} from "@/lib/time";
import type { CandidateSource, SessionType } from "@/lib/types";

/**
 * The controller's Reports page: what happened over a range of dates.
 *
 * Everything is worked out here from four plain queries - the sessions in the
 * range, the panels, the closures and the controllers' audit entries - so the
 * page and the Excel download are built from the same numbers and cannot
 * disagree. A range is at most a few thousand sessions, which is cheaper to
 * fold in one pass than to spread over a dozen GROUP BY queries.
 */

/** A range longer than this is almost certainly a typo in a date field. */
export const MAX_REPORT_DAYS = 800;

/** Past this many days the timeline is drawn a week to a bar, not a day. */
const DAILY_LIMIT = 62;

const BOOKABLE_HOURS_PER_PANEL_DAY = (SLOT_COUNT * SLOT_MINUTES) / 60; // 13

export type ReportSession = {
  id: string;
  date: string;
  slotIndex: number;
  slotCount: number;
  panelId: string;
  panelLabel: string;
  candidateId: string;
  candidateName: string;
  token: string;
  source: CandidateSource;
  candidatePhone: string | null;
  candidateActive: boolean;
  companyName: string;
  sessionType: SessionType;
  status: "booked" | "cancelled";
  bookedBy: "candidate" | "controller";
  recruiterPhone: string | null;
  recruiterEmail: string | null;
  mockDone: boolean;
  /**
   * Its first half-hour is over - the same rule that fades a chip on the
   * Schedule, so "held" here means what the grid shows as done.
   */
  held: boolean;
};

export type TimelineBucket = {
  /** The day, or the Monday that starts the week. */
  start: string;
  held: number;
  scheduled: number;
  interviews: number;
  assessments: number;
  cancelled: number;
  noMock: number;
};

export type CompanyLine = {
  name: string;
  sessions: number;
  interviews: number;
  assessments: number;
  candidates: number;
  noMock: number;
  cancelled: number;
};

export type PanelLine = {
  id: string;
  label: string;
  sessions: number;
  hours: number;
  /** Bookable hours on the days sessions ran, less the days it was closed. */
  bookableHours: number;
  closedDays: number;
};

export type ControllerLine = {
  name: string;
  tokensIssued: number;
  sessionsBooked: number;
  sessionsMoved: number;
  sessionsCancelled: number;
  mocksTicked: number;
  panelsClosed: number;
  signIns: number;
};

export type NoMockLine = Pick<
  ReportSession,
  | "id"
  | "date"
  | "slotIndex"
  | "slotCount"
  | "panelLabel"
  | "candidateId"
  | "candidateName"
  | "token"
  | "companyName"
  | "sessionType"
>;

/** One candidate's range, for the candidate analysis. */
export type CandidateLine = {
  id: string;
  name: string;
  token: string;
  source: CandidateSource;
  phone: string | null;
  active: boolean;
  /** Booked, not cancelled. */
  sessions: number;
  held: number;
  scheduled: number;
  interviews: number;
  assessments: number;
  /** Who they met, one name per company, in the order they first met them. */
  companies: string[];
  /** Days with a held session, and how many of those had the mock done. */
  heldDays: number;
  mockDays: number;
  /** Held sessions that went ahead without the mock. */
  noMock: number;
  cancelled: number;
  /** First and last booked (not cancelled) session in the range. */
  firstDate: string | null;
  lastDate: string | null;
};

/** A token issued in the range that has never had a session booked. */
export type NotBookedLine = {
  id: string;
  name: string;
  token: string;
  phone: string | null;
  source: CandidateSource;
  company: string | null;
  issuedAt: string;
};

export type SourceLine = {
  source: CandidateSource;
  candidates: number;
  sessions: number;
  held: number;
  heldWithMock: number;
  cancelled: number;
};

export type CandidateAnalysis = {
  /** Everyone with a session - booked or cancelled - in the range. */
  lines: CandidateLine[];
  /** How many candidates had 1, 2, 3, 4, and 5 or more sessions. */
  perCandidate: { sessions: string; candidates: number }[];
  sources: SourceLine[];
  /** Tokens issued in the range, disabled ones included. */
  tokensIssued: number;
  notBooked: NotBookedLine[];
};

export type Report = {
  from: string;
  to: string;
  /** "day" normally; "week" once the range is too long for a bar a day. */
  bucket: "day" | "week";
  totals: {
    /** Booked, not cancelled: held plus scheduled. */
    sessions: number;
    held: number;
    scheduled: number;
    interviews: number;
    assessments: number;
    hours: number;
    candidates: number;
    candidatesUniq: number;
    candidatesDirect: number;
    companies: number;
    cancelled: number;
    heldWithMock: number;
    heldWithoutMock: number;
    bookedByCandidates: number;
    bookedByControllers: number;
    /** Days in the range with at least one session. */
    activeDays: number;
    bookableHours: number;
  };
  timeline: TimelineBucket[];
  /** Sessions by the hour they start, 7 AM to 7 PM. */
  hours: { hour: number; sessions: number }[];
  companies: CompanyLine[];
  panels: PanelLine[];
  controllers: ControllerLine[];
  noMock: NoMockLine[];
  candidates: CandidateAnalysis;
};

type SessionRow = {
  id: string;
  slot_date: string;
  slot_index: number;
  slot_count: number;
  panel_id: string;
  panel_label: string;
  candidate_id: string;
  candidate_name: string;
  token: string;
  source: CandidateSource;
  candidate_phone: string | null;
  candidate_active: boolean;
  company_name: string;
  session_type: SessionType;
  status: "booked" | "cancelled";
  booked_by: "candidate" | "controller";
  recruiter_phone: string | null;
  recruiter_email: string | null;
  mock_done: boolean;
};

/**
 * The first and last dates anything is booked on, for "All time". Falls back
 * to today when nothing has been booked yet.
 */
export async function bookedDateSpan(): Promise<{ from: string; to: string }> {
  const [row] = await sql<{ first: string | null; last: string | null }[]>`
    select to_char(min(slot_date), 'YYYY-MM-DD') as first,
           to_char(max(slot_date), 'YYYY-MM-DD') as last
      from bookings
  `;
  const today = todayKey();
  return { from: row?.first ?? today, to: row?.last ?? today };
}

/**
 * The range a request asks for. A blank end is open: no "from" starts at the
 * first booking and no "to" ends at the last, so both blank is "All time".
 */
export async function resolveReportRange(
  params: URLSearchParams,
): Promise<{ from: string; to: string } | { error: string }> {
  let from = params.get("from")?.trim() ?? "";
  let to = params.get("to")?.trim() ?? "";

  if (!from || !to) {
    const span = await bookedDateSpan();
    from ||= span.from;
    to ||= span.to;
  }

  if (!isValidDateKey(from) || !isValidDateKey(to)) {
    return { error: "Dates must be written as YYYY-MM-DD." };
  }
  if (from > to) return { error: "The start date is after the end date." };
  if (daySpan(from, to) > MAX_REPORT_DAYS) {
    return { error: `Choose a range of ${MAX_REPORT_DAYS} days or fewer.` };
  }
  return { from, to };
}

export async function listReportSessions(
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<ReportSession[]> {
  const rows = await sql<SessionRow[]>`
    select b.id,
           to_char(b.slot_date, 'YYYY-MM-DD') as slot_date,
           b.slot_index,
           b.slot_count,
           b.panel_id,
           coalesce(p.label, b.panel_id) as panel_label,
           b.candidate_id,
           c.name as candidate_name,
           c.token,
           c.source,
           c.phone as candidate_phone,
           c.active as candidate_active,
           b.company_name,
           b.session_type,
           b.status,
           b.booked_by,
           b.recruiter_phone,
           b.recruiter_email,
           (mc.candidate_id is not null) as mock_done
      from bookings b
      join candidates c on c.id = b.candidate_id
      left join panels p on p.id = b.panel_id
      -- One mock clears a candidate for the whole day, as on the Schedule.
      left join mock_completions mc
             on mc.candidate_id = b.candidate_id
            and mc.mock_date    = b.slot_date
     where b.slot_date between ${from}::date and ${to}::date
     order by b.slot_date, b.slot_index, p.sort_order, b.panel_id
  `;

  return rows.map((row) => ({
    id: row.id,
    date: row.slot_date,
    slotIndex: Number(row.slot_index),
    slotCount: Number(row.slot_count),
    panelId: row.panel_id,
    panelLabel: row.panel_label,
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
    token: row.token,
    source: row.source,
    candidatePhone: row.candidate_phone,
    candidateActive: Boolean(row.candidate_active),
    companyName: row.company_name.trim(),
    sessionType: row.session_type,
    status: row.status,
    bookedBy: row.booked_by,
    recruiterPhone: row.recruiter_phone,
    recruiterEmail: row.recruiter_email,
    mockDone: Boolean(row.mock_done),
    held:
      row.status === "booked" &&
      isSlotInPast(row.slot_date, Number(row.slot_index), now),
  }));
}

/**
 * "TCS", "tcs" and "T.C.S" are one company. Only letters and digits count, so
 * the report groups spellings the booking form let through separately.
 */
function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "") || name.toLowerCase();
}

/** Monday of the week a date falls in. */
function weekStart(key: string): string {
  const date = fromDateKey(key);
  const offset = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - offset);
  return toDateKey(date);
}

function daySpan(from: string, to: string): number {
  const ms = fromDateKey(to).getTime() - fromDateKey(from).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

const CONTROLLER_COLUMNS: Record<string, keyof Omit<ControllerLine, "name">> = {
  "candidate.created": "tokensIssued",
  "booking.created": "sessionsBooked",
  "booking.moved": "sessionsMoved",
  "booking.cancelled": "sessionsCancelled",
  "mock.completed": "mocksTicked",
  "panel.closed": "panelsClosed",
  "controller.signed_in": "signIns",
};

async function controllerActivity(
  from: string,
  to: string,
): Promise<ControllerLine[]> {
  // The range is calendar days where the schedule runs, not UTC days: an
  // action at 2 AM in Chennai belongs to that morning, not the evening before.
  const zone = SCHEDULE_TIMEZONE ?? "UTC";
  const rows = await sql<{ actor_name: string; action: string; n: number }[]>`
    select actor_name, action, count(*)::int as n
      from audit_logs
     where actor_role = 'controller'
       and occurred_at >= (${from}::date)::timestamp at time zone ${zone}
       and occurred_at <  (${to}::date + 1)::timestamp at time zone ${zone}
     group by actor_name, action
  `;

  const byName = new Map<string, ControllerLine>();
  for (const row of rows) {
    const column = CONTROLLER_COLUMNS[row.action];
    if (!column) continue;
    const line = byName.get(row.actor_name) ?? {
      name: row.actor_name,
      tokensIssued: 0,
      sessionsBooked: 0,
      sessionsMoved: 0,
      sessionsCancelled: 0,
      mocksTicked: 0,
      panelsClosed: 0,
      signIns: 0,
    };
    line[column] += Number(row.n);
    byName.set(row.actor_name, line);
  }

  // Busiest first, by the work done rather than by sign-ins.
  const work = (line: ControllerLine) =>
    line.tokensIssued +
    line.sessionsBooked +
    line.sessionsMoved +
    line.sessionsCancelled +
    line.mocksTicked +
    line.panelsClosed;
  return [...byName.values()].sort(
    (a, b) => work(b) - work(a) || a.name.localeCompare(b.name),
  );
}

/**
 * Tokens issued in the range, and the ones among them still waiting on a
 * first booking - the people worth a phone call. "Never booked" means no
 * session is booked on any date: someone who booked and then cancelled
 * everything is in the same position as someone who never started. Disabled
 * tokens are counted as issued but left off the list, since they were
 * stopped on purpose.
 */
async function tokenFollowUp(
  from: string,
  to: string,
): Promise<Pick<CandidateAnalysis, "tokensIssued" | "notBooked">> {
  const zone = SCHEDULE_TIMEZONE ?? "UTC";
  const rows = await sql<
    {
      id: string;
      name: string;
      token: string;
      phone: string | null;
      source: CandidateSource;
      company: string | null;
      active: boolean;
      issued_at: string;
      booked: boolean;
    }[]
  >`
    select c.id, c.name, c.token, c.phone, c.source, c.company, c.active,
           c.created_at as issued_at,
           exists (
             select 1 from bookings b
              where b.candidate_id = c.id and b.status = 'booked'
           ) as booked
      from candidates c
     where c.created_at >= (${from}::date)::timestamp at time zone ${zone}
       and c.created_at <  (${to}::date + 1)::timestamp at time zone ${zone}
     order by c.created_at desc
  `;

  return {
    tokensIssued: rows.length,
    notBooked: rows
      .filter((row) => row.active && !row.booked)
      .map((row) => ({
        id: row.id,
        name: row.name,
        token: row.token,
        phone: row.phone,
        source: row.source,
        company: row.company,
        issuedAt: new Date(row.issued_at).toISOString(),
      })),
  };
}

/** Folds the range's sessions into one line per candidate. */
function analyseCandidates(
  sessions: ReportSession[],
): Pick<CandidateAnalysis, "lines" | "perCandidate" | "sources"> {
  // The line, and the sets it is counted from until the fold is done.
  type Building = {
    line: CandidateLine;
    companyKeys: Set<string>;
    heldDays: Set<string>;
    mockDays: Set<string>;
  };
  const byId = new Map<string, Building>();

  // Sessions arrive in date order, so the first one seen is the earliest.
  for (const session of sessions) {
    let building = byId.get(session.candidateId);
    if (!building) {
      building = {
        line: {
          id: session.candidateId,
          name: session.candidateName,
          token: session.token,
          source: session.source,
          phone: session.candidatePhone,
          active: session.candidateActive,
          sessions: 0,
          held: 0,
          scheduled: 0,
          interviews: 0,
          assessments: 0,
          companies: [],
          heldDays: 0,
          mockDays: 0,
          noMock: 0,
          cancelled: 0,
          firstDate: null,
          lastDate: null,
        },
        companyKeys: new Set(),
        heldDays: new Set(),
        mockDays: new Set(),
      };
      byId.set(session.candidateId, building);
    }
    const { line } = building;

    if (session.status === "cancelled") {
      line.cancelled += 1;
      continue;
    }

    line.sessions += 1;
    if (session.sessionType === "Interview") line.interviews += 1;
    else line.assessments += 1;

    if (session.held) {
      line.held += 1;
      building.heldDays.add(session.date);
      // The mock belongs to the day, so every session that day agrees.
      if (session.mockDone) building.mockDays.add(session.date);
      else line.noMock += 1;
    } else {
      line.scheduled += 1;
    }

    const key = companyKey(session.companyName);
    if (!building.companyKeys.has(key)) {
      building.companyKeys.add(key);
      line.companies.push(session.companyName);
    }

    line.firstDate ??= session.date;
    line.lastDate = session.date;
  }

  const lines: CandidateLine[] = [...byId.values()]
    .map(({ line, heldDays, mockDays }) => ({
      ...line,
      heldDays: heldDays.size,
      mockDays: mockDays.size,
    }))
    .sort(
      (a, b) =>
        b.sessions - a.sessions ||
        b.noMock - a.noMock ||
        a.name.localeCompare(b.name),
    );

  const booked = lines.filter((line) => line.sessions > 0);
  const perCandidate = ["1", "2", "3", "4", "5+"].map((label, index) => ({
    sessions: label,
    candidates: booked.filter((line) =>
      index === 4 ? line.sessions >= 5 : line.sessions === index + 1,
    ).length,
  }));

  const sources: SourceLine[] = (["Uniq", "Direct"] as const).map((source) => {
    const mine = lines.filter((line) => line.source === source);
    return {
      source,
      candidates: mine.filter((line) => line.sessions > 0).length,
      sessions: mine.reduce((sum, line) => sum + line.sessions, 0),
      held: mine.reduce((sum, line) => sum + line.held, 0),
      heldWithMock: mine.reduce((sum, line) => sum + line.held - line.noMock, 0),
      cancelled: mine.reduce((sum, line) => sum + line.cancelled, 0),
    };
  });

  return { lines, perCandidate, sources };
}

export async function buildReport(
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<{ report: Report; sessions: ReportSession[] }> {
  const [sessions, panels, closures, controllers, followUp] = await Promise.all([
    listReportSessions(from, to, now),
    listPanels(),
    sql<{ panel_id: string; closed_on: string }[]>`
      select panel_id, to_char(closed_on, 'YYYY-MM-DD') as closed_on
        from panel_closures
       where closed_on between ${from}::date and ${to}::date
    `,
    controllerActivity(from, to),
    tokenFollowUp(from, to),
  ]);

  const live = sessions.filter((session) => session.status === "booked");
  const bucket: Report["bucket"] =
    daySpan(from, to) > DAILY_LIMIT ? "week" : "day";
  const bucketOf = (date: string) => (bucket === "week" ? weekStart(date) : date);

  // Every bucket in the range, empty ones included: a day with no sessions is
  // a gap in the chart, not a missing bar.
  const timeline = new Map<string, TimelineBucket>();
  for (let day = from; day <= to; day = shiftDateKey(day, 1)) {
    const start = bucketOf(day);
    if (!timeline.has(start)) {
      timeline.set(start, {
        start,
        held: 0,
        scheduled: 0,
        interviews: 0,
        assessments: 0,
        cancelled: 0,
        noMock: 0,
      });
    }
  }

  const hours = new Map<number, number>();
  for (let index = 0; index < SLOT_COUNT; index += 2) {
    hours.set(Math.floor(slotStartMinutes(index) / 60), 0);
  }

  const companies = new Map<
    string,
    CompanyLine & { spellings: Map<string, number>; people: Set<string> }
  >();
  const candidates = new Map<string, CandidateSource>();
  const activeDays = new Set<string>();
  const panelStats = new Map<string, { sessions: number; halfHours: number }>();

  let held = 0;
  let interviews = 0;
  let heldWithMock = 0;
  let halfHours = 0;
  let bookedByCandidates = 0;

  for (const session of sessions) {
    const point = timeline.get(bucketOf(session.date));
    const key = companyKey(session.companyName);
    let company = companies.get(key);
    if (!company) {
      company = {
        name: session.companyName,
        sessions: 0,
        interviews: 0,
        assessments: 0,
        candidates: 0,
        noMock: 0,
        cancelled: 0,
        spellings: new Map(),
        people: new Set(),
      };
      companies.set(key, company);
    }

    if (session.status === "cancelled") {
      if (point) point.cancelled += 1;
      company.cancelled += 1;
      continue;
    }

    const isInterview = session.sessionType === "Interview";
    const missedMock = session.held && !session.mockDone;

    if (point) {
      if (session.held) point.held += 1;
      else point.scheduled += 1;
      if (isInterview) point.interviews += 1;
      else point.assessments += 1;
      if (missedMock) point.noMock += 1;
    }

    const hour = Math.floor(slotStartMinutes(session.slotIndex) / 60);
    hours.set(hour, (hours.get(hour) ?? 0) + 1);

    company.sessions += 1;
    if (isInterview) company.interviews += 1;
    else company.assessments += 1;
    if (missedMock) company.noMock += 1;
    company.people.add(session.candidateId);
    company.spellings.set(
      session.companyName,
      (company.spellings.get(session.companyName) ?? 0) + 1,
    );

    const panel = panelStats.get(session.panelId) ?? { sessions: 0, halfHours: 0 };
    panel.sessions += 1;
    panel.halfHours += session.slotCount;
    panelStats.set(session.panelId, panel);

    candidates.set(session.candidateId, session.source);
    activeDays.add(session.date);
    halfHours += session.slotCount;
    if (session.held) held += 1;
    if (isInterview) interviews += 1;
    if (session.held && session.mockDone) heldWithMock += 1;
    if (session.bookedBy === "candidate") bookedByCandidates += 1;
  }

  // A panel is bookable on the days sessions ran, unless it was shut that day.
  const closedOn = new Map<string, Set<string>>();
  for (const closure of closures) {
    const days = closedOn.get(closure.panel_id) ?? new Set<string>();
    days.add(closure.closed_on);
    closedOn.set(closure.panel_id, days);
  }

  // Panels still in service, then any retired panel that held a session.
  const panelList = [...panels];
  for (const session of live) {
    if (!panelList.some((panel) => panel.id === session.panelId)) {
      panelList.push({ id: session.panelId, label: session.panelLabel });
    }
  }

  const panelLines: PanelLine[] = panelList.map((panel) => {
    const stats = panelStats.get(panel.id) ?? { sessions: 0, halfHours: 0 };
    const closed = closedOn.get(panel.id) ?? new Set<string>();
    const openDays = [...activeDays].filter((day) => !closed.has(day)).length;
    return {
      id: panel.id,
      label: panel.label,
      sessions: stats.sessions,
      hours: stats.halfHours / 2,
      bookableHours: openDays * BOOKABLE_HOURS_PER_PANEL_DAY,
      closedDays: closed.size,
    };
  });

  const companyLines: CompanyLine[] = [...companies.values()]
    .filter((company) => company.sessions > 0 || company.cancelled > 0)
    .map((company) => {
      // Shown under the spelling used most; ties go to the first one seen.
      let name = company.name;
      let best = 0;
      for (const [spelling, count] of company.spellings) {
        if (count > best) {
          best = count;
          name = spelling;
        }
      }
      return {
        name,
        sessions: company.sessions,
        interviews: company.interviews,
        assessments: company.assessments,
        candidates: company.people.size,
        noMock: company.noMock,
        cancelled: company.cancelled,
      };
    })
    .sort(
      (a, b) =>
        b.sessions - a.sessions ||
        b.cancelled - a.cancelled ||
        a.name.localeCompare(b.name),
    );

  const noMock: NoMockLine[] = live
    .filter((session) => session.held && !session.mockDone)
    .map((session) => ({
      id: session.id,
      date: session.date,
      slotIndex: session.slotIndex,
      slotCount: session.slotCount,
      panelLabel: session.panelLabel,
      candidateId: session.candidateId,
      candidateName: session.candidateName,
      token: session.token,
      companyName: session.companyName,
      sessionType: session.sessionType,
    }))
    // Most recent first: yesterday's misses are the ones still worth chasing.
    .sort((a, b) => b.date.localeCompare(a.date) || a.slotIndex - b.slotIndex);

  const sources = [...candidates.values()];

  const report: Report = {
    from,
    to,
    bucket,
    totals: {
      sessions: live.length,
      held,
      scheduled: live.length - held,
      interviews,
      assessments: live.length - interviews,
      hours: halfHours / 2,
      candidates: candidates.size,
      candidatesUniq: sources.filter((source) => source === "Uniq").length,
      candidatesDirect: sources.filter((source) => source === "Direct").length,
      companies: companyLines.filter((company) => company.sessions > 0).length,
      cancelled: sessions.length - live.length,
      heldWithMock,
      heldWithoutMock: held - heldWithMock,
      bookedByCandidates,
      bookedByControllers: live.length - bookedByCandidates,
      activeDays: activeDays.size,
      bookableHours: panelLines.reduce((sum, panel) => sum + panel.bookableHours, 0),
    },
    timeline: [...timeline.values()],
    hours: [...hours].map(([hour, count]) => ({ hour, sessions: count })),
    companies: companyLines,
    panels: panelLines,
    controllers,
    noMock,
    candidates: { ...analyseCandidates(sessions), ...followUp },
  };

  return { report, sessions };
}
