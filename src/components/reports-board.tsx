"use client";

import { useMemo, useState } from "react";

import CandidateHistory from "@/components/candidate-history";
import { hoursLabel, percent, rangeLabel } from "@/lib/report-format";
import type { Report } from "@/lib/reports";
import {
  SCHEDULE_LOCALE,
  fromDateKey,
  sessionRangeLabel,
  shiftDateKey,
  todayKey,
} from "@/lib/time";
import { usePolledResource } from "@/lib/use-poll";

/*
 * Colour on this page does one job each:
 *   indigo-600  sessions that have happened (and every single-series bar)
 *   indigo-400  sessions still to come - the same hue a step lighter, so the
 *               two read as one quantity split in time, not two things
 *   rose        a session held without its mock, always with a label
 * Both indigo steps were checked against the white card: the lighter one
 * clears 2.98:1, above the 2:1 floor for a mark beside another.
 */
const HELD = "bg-indigo-600";
const SCHEDULED = "bg-indigo-400";

type Preset = "today" | "7d" | "30d" | "month" | "all";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

/** Blank ends mean open: the server fills them from the first/last booking. */
function presetRange(preset: Preset, today: string): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: shiftDateKey(today, -6), to: today };
    case "30d":
      return { from: shiftDateKey(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "all":
      return { from: "", to: "" };
  }
}

const shortDate = (key: string) =>
  fromDateKey(key).toLocaleDateString(SCHEDULE_LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/** 7 -> "7a", 12 -> "12p", 15 -> "3p": thirteen of these fit a phone. */
const hourTick = (hour: number) =>
  `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? "a" : "p"}`;

const hourLong = (hour: number) =>
  `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? "AM" : "PM"}`;

/** A clean top for the axis: 0 / 5 / 10 / 15 rather than 0 / 4.25 / 8.5. */
function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ??
    10 * magnitude;
  const safeStep = Math.max(1, step);
  const top = Math.ceil(max / safeStep) * safeStep;
  const ticks: number[] = [];
  for (let tick = 0; tick <= top; tick += safeStep) ticks.push(tick);
  return { top, ticks };
}

// --- small pieces -------------------------------------------------------------

function StatTile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
        {value}
      </p>
      {children ? (
        <div className="mt-1 space-y-0.5 text-xs leading-snug text-slate-500">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Card({
  title,
  subtitle,
  action,
  className = "",
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Chart or table: every chart has the same numbers as a table beside it. */
function ViewToggle({
  table,
  onChange,
}: {
  table: boolean;
  onChange: (table: boolean) => void;
}) {
  return (
    <div className="no-print flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
      {[false, true].map((asTable) => (
        <button
          key={String(asTable)}
          type="button"
          aria-pressed={table === asTable}
          onClick={() => onChange(asTable)}
          className={`rounded-md px-2.5 py-1 transition ${
            table === asTable
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          {asTable ? "Table" : "Chart"}
        </button>
      ))}
    </div>
  );
}

function LegendKey({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
      <span aria-hidden className={`h-2.5 w-2.5 rounded-[3px] ${swatch}`} />
      {label}
    </span>
  );
}

type Column = {
  key: string;
  /** Up to two short lines under the column. */
  tick: [string, string?];
  /** Bottom-up; a zero segment is simply not drawn. */
  segments: { name: string; value: number; swatch: string }[];
  /** What a hover or keyboard focus shows, value first. */
  tip: { title: string; lines: { label: string; value: number | string; swatch?: string }[] };
};

/**
 * Columns grown from one baseline. Each whole column is the hit target - a
 * pointer or the keyboard anywhere in its band shows the tooltip - so a short
 * bar is as easy to read as a tall one.
 */
function ColumnChart({
  columns,
  height = 168,
  maxTicks = 12,
  label,
}: {
  columns: Column[];
  height?: number;
  maxTicks?: number;
  label: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  const totals = columns.map((column) =>
    column.segments.reduce((sum, segment) => sum + segment.value, 0),
  );
  const peak = Math.max(0, ...totals);
  const { top, ticks } = niceScale(peak);
  const peakIndex = peak > 0 ? totals.indexOf(peak) : -1;
  const every = Math.max(1, Math.ceil(columns.length / maxTicks));

  return (
    <div role="group" aria-label={label}>
      {/* Headroom for the label over the tallest column. */}
      <div className="relative mt-5 ml-7" style={{ height }}>
        {/* Hairline grid, one step off the card. */}
        {ticks.map((tick) => (
          <div
            key={tick}
            aria-hidden
            className={`absolute inset-x-0 border-t ${tick === 0 ? "border-slate-300" : "border-slate-100"}`}
            style={{ bottom: `${(tick / top) * 100}%` }}
          >
            <span className="absolute -top-2 -left-7 w-5 text-right text-[10px] leading-none text-slate-400 tabular-nums">
              {tick}
            </span>
          </div>
        ))}

        <div className="absolute inset-0 flex items-end">
          {columns.map((column, index) => {
            const drawn = column.segments.filter((segment) => segment.value > 0);
            const anchor =
              index < columns.length / 3
                ? "left-0"
                : index >= (columns.length * 2) / 3
                  ? "right-0"
                  : "left-1/2 -translate-x-1/2";
            return (
              <button
                key={column.key}
                type="button"
                aria-label={`${column.tip.title}: ${column.tip.lines
                  .map((line) => `${line.label} ${line.value}`)
                  .join(", ")}`}
                // A mouse shows the tooltip while it hovers. A finger has no
                // hover - "leave" fires the moment it lifts - so a tap toggles
                // the tooltip instead.
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setActive(index);
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === "mouse") setActive(null);
                }}
                onPointerUp={(event) => {
                  if (event.pointerType !== "mouse") {
                    setActive((current) => (current === index ? null : index));
                  }
                }}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                className="relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center rounded-md outline-none focus-visible:bg-indigo-50"
              >
                {/* The one value worth labelling: the busiest column. */}
                {index === peakIndex ? (
                  <span
                    aria-hidden
                    className="absolute text-[11px] leading-none font-semibold text-slate-700 tabular-nums"
                    style={{ bottom: (totals[index] / top) * height + 6 }}
                  >
                    {totals[index]}
                  </span>
                ) : null}

                <span className="flex w-[70%] max-w-6 flex-col-reverse gap-[2px]">
                  {drawn.map((segment, position) => (
                    <span
                      key={segment.name}
                      className={`block w-full transition ${segment.swatch} ${
                        position === drawn.length - 1 ? "rounded-t-[4px]" : ""
                      } ${active === index ? "brightness-110" : ""}`}
                      style={{
                        height: Math.max(2, (segment.value / top) * height),
                      }}
                    />
                  ))}
                </span>

                {active === index ? (
                  <span
                    role="tooltip"
                    className={`pointer-events-none absolute bottom-[calc(100%+8px)] z-20 w-max max-w-[14rem] rounded-lg bg-slate-900 px-3 py-2 text-left text-xs text-white shadow-lg ${anchor}`}
                  >
                    <span className="block font-medium text-slate-300">
                      {column.tip.title}
                    </span>
                    {column.tip.lines.map((line) => (
                      <span
                        key={line.label}
                        className="mt-1 flex items-center gap-2"
                      >
                        {line.swatch ? (
                          <span
                            aria-hidden
                            className={`h-0.5 w-3 rounded-full ${line.swatch}`}
                          />
                        ) : null}
                        <span className="font-semibold tabular-nums">
                          {line.value}
                        </span>
                        <span className="text-slate-300">{line.label}</span>
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Ticks under the columns, thinned out when there are many. */}
      <div aria-hidden className="mt-1.5 ml-7 flex">
        {columns.map((column, index) => (
          <span
            key={column.key}
            className="min-w-0 flex-1 text-center text-[10px] leading-tight text-slate-500 tabular-nums"
          >
            {index % every === 0 ? (
              <>
                <span className="block">{column.tick[0]}</span>
                {column.tick[1] ? (
                  <span className="block text-slate-400">{column.tick[1]}</span>
                ) : null}
              </>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function Table({
  head,
  rows,
  align,
}: {
  head: string[];
  rows: (string | number)[][];
  /** Per column; numbers read best right-aligned. */
  align?: ("left" | "right")[];
}) {
  return (
    <div className="thin-scroll overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
            {head.map((cell, index) => (
              <th
                key={cell}
                className={`px-2 py-2 font-medium whitespace-nowrap ${align?.[index] === "right" ? "text-right" : ""}`}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`px-2 py-1.5 whitespace-nowrap text-slate-700 ${align?.[index] === "right" ? "text-right tabular-nums" : ""}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const WarnIcon = () => (
  <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8.5 3.3a1.7 1.7 0 0 1 3 0l6 10.6A1.7 1.7 0 0 1 16 16.5H4a1.7 1.7 0 0 1-1.5-2.6l6-10.6ZM10 7a.8.8 0 0 0-.8.8v3.4a.8.8 0 0 0 1.6 0V7.8A.8.8 0 0 0 10 7Zm0 7.6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
    />
  </svg>
);

// --- the page -----------------------------------------------------------------

const COMPANIES_SHOWN = 10;

export default function ReportsBoard() {
  const [preset, setPreset] = useState<Preset | null>("7d");
  const [range, setRange] = useState(() => presetRange("7d", todayKey()));
  const [dayTable, setDayTable] = useState(false);
  const [hourTable, setHourTable] = useState(false);
  const [allCompanies, setAllCompanies] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    return params.toString();
  }, [range]);

  // A report changes slowly; once a minute keeps "held" honest through a day.
  const { data, error, loading } = usePolledResource<Report>(
    `/api/reports${query ? `?${query}` : ""}`,
    60_000,
  );

  // While a new range loads, the last report stays on screen, dimmed, rather
  // than the page collapsing to "Loading..." and jumping back.
  const [kept, setKept] = useState<Report | null>(null);
  if (data && data !== kept) setKept(data);
  const report = data ?? kept;

  function choosePreset(next: Preset) {
    setPreset(next);
    setRange(presetRange(next, todayKey()));
  }

  function setEnd(end: "from" | "to", value: string) {
    setPreset(null);
    setRange((current) => ({ ...current, [end]: value }));
  }

  const download = (format: "xlsx" | "csv") =>
    `/api/reports/export?format=${format}${query ? `&${query}` : ""}`;

  const field =
    "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10";

  const totals = report?.totals;
  const topCompany = report?.companies.find((company) => company.sessions > 0);
  const mockCover = totals ? percent(totals.heldWithMock, totals.held) : null;
  const panelUse = totals ? percent(totals.hours, totals.bookableHours) : null;
  const bookings = totals ? totals.sessions + totals.cancelled : 0;
  const empty = totals ? bookings === 0 : false;

  const weekly = report?.bucket === "week";
  const dayColumns: Column[] = (report?.timeline ?? []).map((point) => {
    const date = fromDateKey(point.start);
    return {
      key: point.start,
      tick: weekly
        ? [String(date.getDate()), date.toLocaleDateString(SCHEDULE_LOCALE, { month: "short" })]
        : [String(date.getDate()), date.toLocaleDateString(SCHEDULE_LOCALE, { weekday: "short" })],
      segments: [
        { name: "Held", value: point.held, swatch: HELD },
        { name: "Still to come", value: point.scheduled, swatch: SCHEDULED },
      ],
      tip: {
        title: weekly ? `Week of ${shortDate(point.start)}` : shortDate(point.start),
        lines: [
          { label: "held", value: point.held, swatch: HELD },
          ...(point.scheduled > 0
            ? [{ label: "still to come", value: point.scheduled, swatch: SCHEDULED }]
            : []),
          { label: "interviews", value: point.interviews },
          { label: "assessments", value: point.assessments },
          ...(point.noMock > 0 ? [{ label: "without mock", value: point.noMock }] : []),
          ...(point.cancelled > 0 ? [{ label: "cancelled", value: point.cancelled }] : []),
        ],
      },
    };
  });

  const hourColumns: Column[] = (report?.hours ?? []).map((point) => ({
    key: String(point.hour),
    tick: [hourTick(point.hour)],
    segments: [{ name: "Sessions", value: point.sessions, swatch: HELD }],
    tip: {
      title: `Starting ${hourLong(point.hour)}–${hourLong(point.hour + 1)}`,
      lines: [{ label: point.sessions === 1 ? "session" : "sessions", value: point.sessions }],
    },
  }));

  const companies = report?.companies ?? [];
  const companiesShown = allCompanies
    ? companies
    : companies.slice(0, COMPANIES_SHOWN);
  const companyPeak = Math.max(1, ...companies.map((company) => company.sessions));

  return (
    <div className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Reports
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Sessions, mocks, panels and controller activity for the dates you
            choose.
          </p>
        </div>

        <div className="no-print flex w-full gap-2 sm:w-auto">
          <a
            href={download("csv")}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-100 sm:flex-none sm:py-2"
          >
            Sessions CSV
          </a>
          <a
            href={download("xlsx")}
            className="flex-1 rounded-lg bg-emerald-600 px-3 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-emerald-700 sm:flex-none sm:py-2"
          >
            Download Excel
          </a>
        </div>
      </header>

      {/* One row of filters above everything they scope. */}
      <section className="no-print mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div
            role="group"
            aria-label="Date range"
            className="thin-scroll -mx-1 flex w-[calc(100%+0.5rem)] gap-1 overflow-x-auto px-1 lg:w-auto"
          >
            {PRESETS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={preset === option.id}
                onClick={() => choosePreset(option.id)}
                className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition sm:py-1.5 ${
                  preset === option.id
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto lg:ml-auto">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-600">
              From
              <input
                type="date"
                value={range.from}
                max={range.to || undefined}
                onChange={(event) => setEnd("from", event.target.value)}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-600">
              To
              <input
                type="date"
                value={range.to}
                min={range.from || undefined}
                onChange={(event) => setEnd("to", event.target.value)}
                className={field}
              />
            </label>
          </div>
        </div>

        <p className="mt-3 text-sm text-slate-600" aria-live="polite">
          {report ? (
            <>
              <span className="font-medium text-slate-900">
                {rangeLabel(report.from, report.to)}
              </span>
              {weekly ? " · a bar per week" : ""}
              {loading ? " · updating..." : ""}
            </>
          ) : loading ? (
            "Loading..."
          ) : null}
        </p>
      </section>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {error}
        </p>
      ) : null}

      {report && totals ? (
        <div
          className={`transition-opacity ${loading ? "opacity-60" : ""}`}
          aria-busy={loading}
        >
          {empty ? (
            <p className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-12 text-center text-sm text-slate-500">
              Nothing was booked in these dates.
            </p>
          ) : (
            <>
              {/* Headline numbers. */}
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <StatTile label="Sessions held" value={totals.held.toLocaleString()}>
                  {totals.scheduled > 0 ? (
                    <p>+{totals.scheduled} still to come</p>
                  ) : null}
                  <p>
                    {totals.interviews} interview{totals.interviews === 1 ? "" : "s"}
                    {" · "}
                    {totals.assessments} assessment{totals.assessments === 1 ? "" : "s"}
                  </p>
                </StatTile>

                <StatTile label="Candidates" value={totals.candidates.toLocaleString()}>
                  <p>
                    Uniq {totals.candidatesUniq} &middot; Direct{" "}
                    {totals.candidatesDirect}
                  </p>
                </StatTile>

                <StatTile label="Companies" value={totals.companies.toLocaleString()}>
                  {topCompany ? (
                    <p className="truncate" title={topCompany.name}>
                      Most: {topCompany.name} ({topCompany.sessions})
                    </p>
                  ) : null}
                </StatTile>

                <StatTile
                  label="Mock cover"
                  value={mockCover === null ? "—" : `${mockCover}%`}
                >
                  {totals.held === 0 ? (
                    <p>Nothing held yet</p>
                  ) : totals.heldWithoutMock > 0 ? (
                    <p className="flex items-center gap-1 font-medium text-rose-700">
                      <WarnIcon />
                      {totals.heldWithoutMock} held without mock
                    </p>
                  ) : (
                    <p>Every held session had its mock</p>
                  )}
                </StatTile>

                <StatTile
                  label="Panel use"
                  value={panelUse === null ? "—" : `${panelUse}%`}
                >
                  <p>
                    {hoursLabel(totals.hours)}h of {hoursLabel(totals.bookableHours)}h
                    bookable
                  </p>
                </StatTile>

                <StatTile label="Cancelled" value={totals.cancelled.toLocaleString()}>
                  <p>{percent(totals.cancelled, bookings) ?? 0}% of bookings</p>
                </StatTile>
              </div>

              {/* When: by day, and by the hour sessions start. */}
              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <Card
                  className="lg:col-span-2"
                  title={weekly ? "Sessions per week" : "Sessions per day"}
                  subtitle={
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      <LegendKey swatch={HELD} label="Held" />
                      {totals.scheduled > 0 ? (
                        <LegendKey swatch={SCHEDULED} label="Still to come" />
                      ) : null}
                    </span>
                  }
                  action={<ViewToggle table={dayTable} onChange={setDayTable} />}
                >
                  {dayTable ? (
                    <Table
                      head={[weekly ? "Week of" : "Date", "Held", "To come", "Without mock", "Cancelled"]}
                      align={["left", "right", "right", "right", "right"]}
                      rows={report.timeline.map((point) => [
                        shortDate(point.start),
                        point.held,
                        point.scheduled,
                        point.noMock,
                        point.cancelled,
                      ])}
                    />
                  ) : (
                    <ColumnChart
                      label={weekly ? "Sessions per week" : "Sessions per day"}
                      columns={dayColumns}
                      maxTicks={10}
                    />
                  )}
                </Card>

                <Card
                  title="Busiest hours"
                  subtitle="Sessions by the hour they start"
                  action={<ViewToggle table={hourTable} onChange={setHourTable} />}
                >
                  {hourTable ? (
                    <Table
                      head={["Starting", "Sessions"]}
                      align={["left", "right"]}
                      rows={report.hours.map((point) => [
                        hourLong(point.hour),
                        point.sessions,
                      ])}
                    />
                  ) : (
                    <ColumnChart
                      label="Sessions by starting hour"
                      columns={hourColumns}
                      maxTicks={13}
                    />
                  )}
                </Card>
              </div>

              {/* The misses: sessions that went ahead without a mock. */}
              <Card
                className="mt-4"
                title="Held without a mock"
                subtitle={
                  report.noMock.length > 0
                    ? `${report.noMock.length} session${report.noMock.length === 1 ? "" : "s"}, most recent first. Ticking a mock off late on the Mock page clears it here.`
                    : "Every session held in these dates had its mock."
                }
              >
                {report.noMock.length > 0 ? (
                  <div className="thin-scroll max-h-96 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-white">
                        <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                          <th className="px-2 py-2 font-medium">Date</th>
                          <th className="px-2 py-2 font-medium">Time</th>
                          <th className="px-2 py-2 font-medium">Candidate</th>
                          <th className="px-2 py-2 font-medium">Company</th>
                          <th className="hidden px-2 py-2 font-medium sm:table-cell">
                            Panel
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.noMock.map((line) => (
                          <tr key={line.id}>
                            <td className="px-2 py-1.5 whitespace-nowrap text-slate-700">
                              {shortDate(line.date)}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap text-slate-600 tabular-nums">
                              {sessionRangeLabel(line.slotIndex, line.slotCount)}
                            </td>
                            <td className="px-2 py-1.5">
                              <button
                                type="button"
                                onClick={() => setHistoryId(line.candidateId)}
                                title={`View ${line.candidateName}'s history`}
                                className="text-left font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2 transition hover:decoration-slate-900"
                              >
                                {line.candidateName}
                              </button>
                              <span className="ml-1.5 font-mono text-xs text-slate-400">
                                {line.token}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-slate-700">
                              {line.companyName}
                              <span className="ml-1 text-xs text-slate-400">
                                {line.sessionType}
                              </span>
                            </td>
                            <td className="hidden px-2 py-1.5 whitespace-nowrap text-slate-600 sm:table-cell">
                              {line.panelLabel}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </Card>

              {/* Where: panels, and who the sessions were with. */}
              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <Card
                  title="Panels"
                  subtitle={`Hours booked of 7 AM–8 PM, on the ${totals.activeDays} day${totals.activeDays === 1 ? "" : "s"} with sessions`}
                >
                  <ul className="space-y-4">
                    {report.panels.map((panel) => {
                      const use = percent(panel.hours, panel.bookableHours);
                      return (
                        <li key={panel.id}>
                          <div className="flex items-baseline justify-between gap-2 text-sm">
                            <span className="font-semibold text-slate-900">
                              {panel.label}
                            </span>
                            <span className="font-semibold text-slate-900 tabular-nums">
                              {use === null ? "—" : `${use}%`}
                            </span>
                          </div>
                          <div
                            role="meter"
                            aria-label={`${panel.label} use`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={use ?? 0}
                            className="mt-1.5 h-2 overflow-hidden rounded-full bg-indigo-100"
                          >
                            <div
                              className="h-full rounded-full bg-indigo-600"
                              style={{ width: `${Math.min(100, use ?? 0)}%` }}
                            />
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {panel.sessions} session{panel.sessions === 1 ? "" : "s"}
                            {" · "}
                            {hoursLabel(panel.hours)}h of {hoursLabel(panel.bookableHours)}h
                            {panel.closedDays > 0
                              ? ` · closed ${panel.closedDays} day${panel.closedDays === 1 ? "" : "s"}`
                              : ""}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                </Card>

                <Card
                  className="lg:col-span-2"
                  title="Companies"
                  subtitle={`${totals.companies} compan${totals.companies === 1 ? "y" : "ies"}, busiest first. Spellings that differ only in case or spacing count as one.`}
                >
                  <div className="thin-scroll overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                          <th className="px-2 py-2 font-medium">Company</th>
                          <th className="px-2 py-2 font-medium">Sessions</th>
                          <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">
                            Candidates
                          </th>
                          <th className="px-2 py-2 text-right font-medium">
                            No mock
                          </th>
                          <th className="px-2 py-2 text-right font-medium">
                            Cancelled
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {companiesShown.map((company) => (
                          <tr key={company.name}>
                            <td className="max-w-[10rem] truncate px-2 py-1.5 font-medium text-slate-900 sm:max-w-[16rem]" title={company.name}>
                              {company.name}
                            </td>
                            <td className="px-2 py-1.5">
                              {/* The number, with its length beside it. */}
                              <span className="flex items-center gap-2">
                                <span className="w-5 text-right text-slate-900 tabular-nums">
                                  {company.sessions}
                                </span>
                                <span
                                  aria-hidden
                                  className="h-2 rounded-r-[4px] bg-indigo-600"
                                  style={{
                                    width: `${(company.sessions / companyPeak) * 6}rem`,
                                  }}
                                />
                                {company.assessments > 0 ? (
                                  <span className="text-xs whitespace-nowrap text-slate-400">
                                    {company.assessments} assess.
                                  </span>
                                ) : null}
                              </span>
                            </td>
                            <td className="hidden px-2 py-1.5 text-right text-slate-700 tabular-nums sm:table-cell">
                              {company.candidates}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right tabular-nums ${company.noMock > 0 ? "font-semibold text-rose-700" : "text-slate-400"}`}
                            >
                              {company.noMock}
                            </td>
                            <td className="px-2 py-1.5 text-right text-slate-500 tabular-nums">
                              {company.cancelled}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {companies.length > COMPANIES_SHOWN ? (
                    <button
                      type="button"
                      onClick={() => setAllCompanies((open) => !open)}
                      className="no-print mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                    >
                      {allCompanies
                        ? "Show the top 10"
                        : `Show all ${companies.length}`}
                    </button>
                  ) : null}
                </Card>
              </div>

              {/* Who: the controllers, and how much candidates did themselves. */}
              <Card
                className="mt-4"
                title="Controller activity"
                subtitle={
                  totals.sessions > 0
                    ? `Candidates booked ${totals.bookedByCandidates} of the ${totals.sessions} sessions themselves (${percent(totals.bookedByCandidates, totals.sessions)}%); controllers booked ${totals.bookedByControllers}.`
                    : undefined
                }
              >
                {report.controllers.length > 0 ? (
                  <Table
                    head={["Controller", "Tokens issued", "Booked", "Moved", "Cancelled", "Mocks ticked", "Panels closed", "Sign-ins"]}
                    align={["left", "right", "right", "right", "right", "right", "right", "right"]}
                    rows={report.controllers.map((line) => [
                      line.name,
                      line.tokensIssued,
                      line.sessionsBooked,
                      line.sessionsMoved,
                      line.sessionsCancelled,
                      line.mocksTicked,
                      line.panelsClosed,
                      line.signIns,
                    ])}
                  />
                ) : (
                  <p className="text-sm text-slate-500">
                    No controller activity was logged in these dates.
                  </p>
                )}
              </Card>
            </>
          )}
        </div>
      ) : null}

      {historyId ? (
        <CandidateHistory
          candidateId={historyId}
          onClose={() => setHistoryId(null)}
        />
      ) : null}
    </div>
  );
}
