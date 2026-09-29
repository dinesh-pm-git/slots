import { fail, forbidden, serverError, unauthorized } from "@/lib/http";
import { percent, rangeLabel } from "@/lib/report-format";
import { buildReport, resolveReportRange, type Report } from "@/lib/reports";
import { getSession, isController } from "@/lib/session";
import {
  SCHEDULE_LOCALE,
  SCHEDULE_TIMEZONE,
  SLOT_MINUTES,
  sessionEndLabel,
  sessionRangeLabel,
  slotStartLabel,
} from "@/lib/time";
import { buildCsv, buildWorkbook, type Sheet, type SheetCell } from "@/lib/xlsx";

const SESSION_HEADERS = [
  "Date",
  "Start",
  "End",
  "Minutes",
  "Panel",
  "Candidate",
  "Token",
  "Candidate phone",
  "Source",
  "Company",
  "Company (grouped)",
  "Type",
  "Status",
  "Booked by",
  "Recruiter phone",
  "Recruiter email",
  "Mock done",
  "Held",
];

const CONTACT_HEADERS = [
  "Company",
  "Recruiter phone",
  "Recruiter email",
  "Last session",
  "Time",
  "Last candidate",
  "Sessions",
];

/** Every company's recruiters in one list, the latest session first. */
function contactRows(report: Report): SheetCell[][] {
  return report.companies
    .flatMap((company) =>
      company.contacts.map((contact) => ({ company: company.name, ...contact })),
    )
    .sort(
      (a, b) =>
        b.lastDate.localeCompare(a.lastDate) ||
        b.lastSlotIndex - a.lastSlotIndex ||
        a.company.localeCompare(b.company),
    )
    .map((row) => [
      row.company,
      row.phone ?? "",
      row.email ?? "",
      row.lastDate,
      slotStartLabel(row.lastSlotIndex),
      row.lastCandidate,
      row.sessions,
    ]);
}

// attachment + the filename is what makes the browser save rather than render.
function csvResponse(filename: string, headers: string[], rows: SheetCell[][]) {
  return new Response(buildCsv(headers, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function xlsxResponse(filename: string, sheets: Sheet[]) {
  return new Response(buildWorkbook(sheets) as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");

/** A moment on the schedule's clock: "30 Sept 2026, 14:05". */
const whenLabel = (iso: string) =>
  new Intl.DateTimeFormat(SCHEDULE_LOCALE, {
    timeZone: SCHEDULE_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

/**
 * Download the report. Excel carries every table on the page as its own sheet,
 * plus every session in the range; CSV is that session list alone, since a
 * CSV file holds one table. `kind=contacts` is the recruiter contacts on
 * their own, latest first, in either format. Controller only.
 */
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (!isController(session)) return forbidden();

    const params = new URL(request.url).searchParams;
    const format = (params.get("format") ?? "xlsx").toLowerCase();
    if (format !== "csv" && format !== "xlsx") {
      return fail("Format must be csv or xlsx.", 400);
    }

    const kind = (params.get("kind") ?? "report").toLowerCase();
    if (kind !== "report" && kind !== "contacts") {
      return fail("Kind must be report or contacts.", 400);
    }

    const range = await resolveReportRange(params);
    if ("error" in range) return fail(range.error, 400);

    const { report, sessions } = await buildReport(range.from, range.to);
    const { totals } = report;

    if (kind === "contacts") {
      const filename = `recruiter-contacts-${range.from}-to-${range.to}.${format}`;
      const rows = contactRows(report);
      return format === "csv"
        ? csvResponse(filename, CONTACT_HEADERS, rows)
        : xlsxResponse(filename, [
            { name: "Recruiter contacts", headers: CONTACT_HEADERS, rows },
          ]);
    }

    const sessionRows: SheetCell[][] = sessions.map((row) => [
      row.date,
      slotStartLabel(row.slotIndex),
      sessionEndLabel(row.slotIndex, row.slotCount),
      row.slotCount * SLOT_MINUTES,
      row.panelLabel,
      row.candidateName,
      row.token,
      row.candidatePhone ?? "",
      row.source,
      row.companyName,
      row.companyGroup,
      row.sessionType,
      row.status === "booked" ? "Booked" : "Cancelled",
      row.bookedBy === "candidate" ? "Candidate" : "Controller",
      row.recruiterPhone ?? "",
      row.recruiterEmail ?? "",
      yesNo(row.mockDone),
      yesNo(row.held),
    ]);

    const filename = `report-${range.from}-to-${range.to}.${format}`;

    if (format === "csv") {
      return csvResponse(filename, SESSION_HEADERS, sessionRows);
    }

    const generated = whenLabel(new Date().toISOString());

    const summary: SheetCell[][] = [
      ["Dates", rangeLabel(report.from, report.to)],
      ["Generated", `${generated} by ${session.name}`],
      ["Sessions held", totals.held],
      ["Sessions still to come", totals.scheduled],
      ["Interviews", totals.interviews],
      ["Assessments", totals.assessments],
      ["Hours booked", totals.hours],
      ["Candidates", totals.candidates],
      ["Candidates from Uniq", totals.candidatesUniq],
      ["Candidates direct", totals.candidatesDirect],
      ["Tokens issued", report.candidates.tokensIssued],
      ["Issued, no session booked yet", report.candidates.notBooked.length],
      ["Companies", totals.companies],
      ["Held with a mock", totals.heldWithMock],
      ["Held without a mock", totals.heldWithoutMock],
      ["Mock cover (%)", percent(totals.heldWithMock, totals.held)],
      ["Cancelled", totals.cancelled],
      ["Booked by candidates", totals.bookedByCandidates],
      ["Booked by controllers", totals.bookedByControllers],
      ["Days with sessions", totals.activeDays],
      ["Bookable panel hours on those days", totals.bookableHours],
      ["Panel use (%)", percent(totals.hours, totals.bookableHours)],
    ];

    const sheets: Sheet[] = [
      { name: "Summary", headers: ["Measure", "Value"], rows: summary },
      {
        name: report.bucket === "week" ? "By week" : "By day",
        headers: [
          report.bucket === "week" ? "Week of" : "Date",
          "Held",
          "Still to come",
          "Interviews",
          "Assessments",
          "Without mock",
          "Cancelled",
        ],
        rows: report.timeline.map((point) => [
          point.start,
          point.held,
          point.scheduled,
          point.interviews,
          point.assessments,
          point.noMock,
          point.cancelled,
        ]),
      },
      {
        name: "By hour",
        headers: ["Starting", "Sessions"],
        rows: report.hours.map((point) => [
          `${point.hour % 12 === 0 ? 12 : point.hour % 12}:00 ${point.hour < 12 ? "AM" : "PM"}`,
          point.sessions,
        ]),
      },
      {
        name: "Companies",
        headers: [
          "Company",
          "Sessions",
          "Interviews",
          "Assessments",
          "Candidates",
          "Without mock",
          "Cancelled",
          "Also written as",
        ],
        rows: report.companies.map((company) => [
          company.name,
          company.sessions,
          company.interviews,
          company.assessments,
          company.candidates,
          company.noMock,
          company.cancelled,
          company.aliases.join(", "),
        ]),
      },
      {
        name: "Panels",
        headers: [
          "Panel",
          "Sessions",
          "Hours booked",
          "Bookable hours",
          "Use (%)",
          "Days closed",
        ],
        rows: report.panels.map((panel) => [
          panel.label,
          panel.sessions,
          panel.hours,
          panel.bookableHours,
          percent(panel.hours, panel.bookableHours),
          panel.closedDays,
        ]),
      },
      {
        name: "Controllers",
        headers: [
          "Controller",
          "Tokens issued",
          "Sessions booked",
          "Sessions moved",
          "Sessions cancelled",
          "Mocks ticked",
          "Panels closed",
          "Sign-ins",
        ],
        rows: report.controllers.map((line) => [
          line.name,
          line.tokensIssued,
          line.sessionsBooked,
          line.sessionsMoved,
          line.sessionsCancelled,
          line.mocksTicked,
          line.panelsClosed,
          line.signIns,
        ]),
      },
      {
        name: "Candidates",
        headers: [
          "Candidate",
          "Token",
          "Phone",
          "Source",
          "Token active",
          "Sessions",
          "Held",
          "Still to come",
          "Interviews",
          "Assessments",
          "Companies",
          "Company names",
          "Days held",
          "Days with mock",
          "Held without mock",
          "Cancelled",
          "First session",
          "Last session",
        ],
        rows: report.candidates.lines.map((line) => [
          line.name,
          line.token,
          line.phone ?? "",
          line.source,
          yesNo(line.active),
          line.sessions,
          line.held,
          line.scheduled,
          line.interviews,
          line.assessments,
          line.companies.length,
          line.companies.join(", "),
          line.heldDays,
          line.mockDays,
          line.noMock,
          line.cancelled,
          line.firstDate ?? "",
          line.lastDate ?? "",
        ]),
      },
      {
        name: "Not booked yet",
        headers: ["Candidate", "Token", "Phone", "Source", "Company", "Token issued"],
        rows: report.candidates.notBooked.map((line) => [
          line.name,
          line.token,
          line.phone ?? "",
          line.source,
          line.company ?? "",
          whenLabel(line.issuedAt),
        ]),
      },
      {
        name: "Without mock",
        headers: ["Date", "Time", "Candidate", "Token", "Company", "Type", "Panel"],
        rows: report.noMock.map((line) => [
          line.date,
          sessionRangeLabel(line.slotIndex, line.slotCount),
          line.candidateName,
          line.token,
          line.companyName,
          line.sessionType,
          line.panelLabel,
        ]),
      },
      {
        name: "Recruiter contacts",
        headers: CONTACT_HEADERS,
        rows: contactRows(report),
      },
      { name: "Sessions", headers: SESSION_HEADERS, rows: sessionRows },
    ];

    return xlsxResponse(filename, sheets);
  } catch (error) {
    return serverError(error);
  }
}
