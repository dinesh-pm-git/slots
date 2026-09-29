"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import BookingDialog, {
  type BookedSession,
  type BookingTarget,
} from "@/components/booking-dialog";
import CandidateHistory from "@/components/candidate-history";
import NeedMock from "@/components/need-mock";
import {
  ALL_SLOT_INDEXES,
  coveredSlots,
  fitsInDay,
  isSlotInPast,
  longDateLabel,
  sessionRangeLabel,
  slotEndLabel,
  shiftDateKey,
  slotShortLabel,
  slotStartLabel,
  type CarouselDay,
} from "@/lib/time";
import type {
  Booking,
  CandidateSummary,
  Panel,
  ScheduleView,
  WaitingSummary,
} from "@/lib/types";
import { chipHue } from "@/lib/chip-hue";
import { BUTTON, TONES } from "@/lib/tone";
import { useNow } from "@/lib/use-now";
import { ZOOM_LEVELS, useZoom } from "@/lib/use-zoom";
import { usePolledResource } from "@/lib/use-poll";

type Props = {
  panels: Panel[];
  candidates: CandidateSummary[];
  days: CarouselDay[];
  today: string;
};

const cellKey = (panelId: string, slotIndex: number) => `${panelId}:${slotIndex}`;

const QUICK_DAYS = [
  { label: "Yesterday", offset: -1 },
  { label: "Today", offset: 0 },
  { label: "Tomorrow", offset: 1 },
];

/**
 * The last edit that reached the server, kept so it can be taken back.
 *
 * Only edits with an exact inverse are kept. Closing a panel reseats the whole
 * day and may push people to the waiting list, and reopening does not put
 * them back, so it is not offered as undoable; nor is seating someone from the
 * queue, since cancelling that booking would not return them to their place.
 */
type Change =
  | {
      kind: "move";
      bookingId: string;
      /** Where it was before, to send it back there. */
      date: string;
      panelId: string;
      slotIndex: number;
      label: string;
    }
  | { kind: "cancel"; booking: Booking; label: string }
  | { kind: "add"; bookingId: string; label: string };

/**
 * Controller Schedule view: panels across, half-hour slots down.
 *
 * A session can be reassigned either by dragging its chip onto another cell or
 * by clicking the chip and then clicking the destination - the click path is
 * what makes this usable on a touchscreen.
 */
export default function ScheduleBoard({
  panels: initialPanels,
  candidates,
  days,
  today,
}: Props) {
  const [dateKey, setDateKey] = useState(today);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [target, setTarget] = useState<BookingTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Starts locked on every visit, so a stray tap or drag cannot move anyone.
  // Not remembered between visits on purpose: an edit mode left on is exactly
  // how the accidental moves happened.
  const [editing, setEditing] = useState(false);
  const [lastChange, setLastChange] = useState<Change | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Null until hydration, so the server and first client render agree.
  const now = useNow();
  const { level, zoomIn, zoomOut, zoom, canZoomIn, canZoomOut } = useZoom();

  const { data, error, loading, refresh } = usePolledResource<
    ScheduleView & { closedPanelIds: string[]; waiting: WaitingSummary[] }
  >(`/api/schedule?date=${dateKey}`);

  const closedPanelIds = useMemo(
    () => new Set(data?.closedPanelIds ?? []),
    [data],
  );
  const waiting = useMemo(() => data?.waiting ?? [], [data]);

  const panels = data?.panels ?? initialPanels;
  const bookings = useMemo(() => data?.bookings ?? [], [data]);

  /** The cell a session starts in - the only one that renders a chip. */
  const startAt = useMemo(() => {
    const map = new Map<string, Booking>();
    for (const booking of bookings) {
      map.set(cellKey(booking.panelId, booking.slotIndex), booking);
    }
    return map;
  }, [bookings]);

  /** Every cell a session covers, so the rest are not drawn as free. */
  const occupied = useMemo(() => {
    const set = new Set<string>();
    for (const booking of bookings) {
      for (const index of coveredSlots(booking.slotIndex, booking.slotCount)) {
        set.add(cellKey(booking.panelId, index));
      }
    }
    return set;
  }, [bookings]);

  /** A panel is free for a new session only if every block it needs is clear. */
  const freeForRange = useCallback(
    (panelId: string, start: number, count: number) =>
      fitsInDay(start, count) &&
      coveredSlots(start, count).every(
        (index) => !occupied.has(cellKey(panelId, index)),
      ),
    [occupied],
  );

  const movingBooking = movingId
    ? (bookings.find((booking) => booking.id === movingId) ?? null)
    : null;

  // Escape cancels an in-progress move.
  useEffect(() => {
    if (!movingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMovingId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [movingId]);

  const slotIsPast = useCallback(
    (index: number) => (now ? isSlotInPast(dateKey, index, now) : false),
    [dateKey, now],
  );

  const move = useCallback(
    async (bookingId: string, toPanelId: string, toSlotIndex: number) => {
      const before = bookings.find((booking) => booking.id === bookingId);
      if (
        before &&
        before.panelId === toPanelId &&
        before.slotIndex === toSlotIndex
      ) {
        setMovingId(null);
        return;
      }

      setNotice(null);
      setBusy(true);
      try {
        const response = await fetch(`/api/bookings/${bookingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            panelId: toPanelId,
            slotIndex: toSlotIndex,
            date: dateKey,
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          setNotice(result.error ?? "Could not move that session.");
          return;
        }
        setMovingId(null);
        if (before) {
          setLastChange({
            kind: "move",
            bookingId,
            date: dateKey,
            panelId: before.panelId,
            slotIndex: before.slotIndex,
            label: `Moved ${before.candidateName} to ${toPanelId}, ${slotStartLabel(toSlotIndex)}`,
          });
        }
        void refresh();
      } catch {
        setNotice("Could not reach the server. Please try again.");
      } finally {
        setBusy(false);
        setDropTarget(null);
      }
    },
    [bookings, dateKey, refresh],
  );

  async function cancelBooking(booking: Booking) {
    const confirmed = window.confirm(
      `Cancel ${booking.candidateName}'s ${booking.sessionType.toLowerCase()} at ${slotStartLabel(booking.slotIndex)} on ${booking.panelId}?`,
    );
    if (!confirmed) return;

    setNotice(null);
    const response = await fetch(`/api/bookings/${booking.id}`, {
      method: "DELETE",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setNotice(result.error ?? "Could not cancel that session.");
      return;
    }
    if (movingId === booking.id) setMovingId(null);
    setLastChange({
      kind: "cancel",
      booking,
      label: `Cancelled ${booking.candidateName}, ${slotStartLabel(booking.slotIndex)} on ${booking.panelId}`,
    });
    void refresh();
  }

  /** Locking also drops a half-finished move, so nothing is left armed. */
  function setEditMode(on: boolean) {
    setEditing(on);
    if (!on) {
      setMovingId(null);
      setDropTarget(null);
    }
  }

  const firstDay = days[0]?.key ?? today;
  const lastDay = days[days.length - 1]?.key ?? today;

  function stepDay(offset: number) {
    const next = shiftDateKey(dateKey, offset);
    if (next < firstDay || next > lastDay) return;
    setDateKey(next);
    setMovingId(null);
  }

  function booked(result: BookedSession | null) {
    void refresh();
    if (!result) return;
    const name =
      candidates.find((candidate) => candidate.id === result.candidateId)
        ?.name ?? "Candidate";
    setLastChange({
      kind: "add",
      bookingId: result.id,
      label: `Booked ${name} on ${result.panelId}, ${slotStartLabel(result.slotIndex)}`,
    });
  }

  /** Takes back the last saved edit by applying its exact inverse. */
  async function undo() {
    if (!lastChange) return;
    setNotice(null);
    setUndoing(true);

    try {
      let response: Response;

      if (lastChange.kind === "move") {
        response = await fetch(`/api/bookings/${lastChange.bookingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: lastChange.date,
            panelId: lastChange.panelId,
            slotIndex: lastChange.slotIndex,
          }),
        });
      } else if (lastChange.kind === "add") {
        response = await fetch(`/api/bookings/${lastChange.bookingId}`, {
          method: "DELETE",
        });
      } else {
        // A cancelled booking cannot be revived, so the same session is booked
        // again: same candidate, panel, time, length and details.
        const was = lastChange.booking;
        response = await fetch("/api/bookings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateId: was.candidateId,
            panelId: was.panelId,
            date: was.slotDate,
            slotIndex: was.slotIndex,
            slotCount: was.slotCount,
            companyName: was.companyName,
            sessionType: was.sessionType,
            recruiterPhone: was.recruiterPhone ?? "",
            recruiterEmail: was.recruiterEmail ?? "",
          }),
        });
      }

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Kept, so the reason is visible and another try is possible.
        setNotice(`Could not undo: ${result.error ?? "the server refused it."}`);
        return;
      }

      setLastChange(null);
      setFlash("Change undone.");
      window.setTimeout(() => setFlash(null), 2500);
      void refresh();
    } catch {
      setNotice("Could not reach the server. Please try again.");
    } finally {
      setUndoing(false);
    }
  }

  /**
   * Closing reseats the whole day in booking order, so the warning has to say
   * that plainly - the controller is not just hiding a column.
   */
  async function setClosed(panelId: string, closed: boolean) {
    if (closed) {
      // Never quote a count from data that has not arrived. Saying "nothing is
      // booked" while the feed is still loading is a lie the controller acts on.
      const onPanel = bookings.filter((b) => b.panelId === panelId).length;
      const detail = !data
        ? "Any sessions on it are reseated oldest booking first; whatever no longer fits goes to the waiting list."
        : onPanel > 0
          ? `${onPanel} session${onPanel === 1 ? "" : "s"} sit on it. Sessions are reseated oldest booking first; whatever no longer fits goes to the waiting list.`
          : "Nothing is booked on it.";

      const confirmed = window.confirm(
        `Close ${panelId} for ${longDateLabel(dateKey)}?\n\n${detail}`,
      );
      if (!confirmed) return;
    }

    setNotice(null);
    setBusy(true);
    try {
      const response = await fetch("/api/closures", {
        method: closed ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateKey, panelId }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setNotice(result.error ?? "Could not change that panel.");
        return;
      }

      if (closed) {
        const moved = result.moved?.length ?? 0;
        const queued = result.waitlisted?.length ?? 0;
        setNotice(
          `${panelId} closed. ${moved} session${moved === 1 ? "" : "s"} moved, ` +
            `${queued} went to the waiting list.`,
        );
      } else {
        setNotice(`${panelId} reopened. Sessions moved earlier were not restored.`);
      }
      void refresh();
    } catch {
      setNotice("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function placeFromQueue(entry: WaitingSummary) {
    setNotice(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/waiting-list/${entry.id}`, {
        method: "POST",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(result.error ?? "Could not place them.");
        return;
      }
      setNotice(`${entry.candidateName} placed on ${result.panelId}.`);
      void refresh();
    } catch {
      setNotice("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }


  /** Panels free for a whole session, the clicked one first if it qualifies. */
  const panelsFreeFor = useCallback(
    (slotIndex: number, count: number, preferred?: string) => {
      const free = panels
        .filter((panel) => freeForRange(panel.id, slotIndex, count))
        .map((panel) => panel.id);
      return preferred && free.includes(preferred)
        ? [preferred, ...free.filter((id) => id !== preferred)]
        : free;
    },
    [panels, freeForRange],
  );

  function handleEmptyCellClick(panelId: string, slotIndex: number) {
    if (movingId) {
      void move(movingId, panelId, slotIndex);
      return;
    }

    // The clicked cell leads; the dialog may still move it to another panel,
    // and recomputes the list whenever the length changes there.
    setTarget({
      dateKey,
      slotIndex,
      slotCount: 1,
      panelIds: panelsFreeFor(slotIndex, 1, panelId),
    });
  }

  const countsByPanel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const booking of bookings) {
      counts.set(booking.panelId, (counts.get(booking.panelId) ?? 0) + 1);
    }
    return counts;
  }, [bookings]);

  // Read by .schedule-grid in globals.css, which sizes the columns - a
  // phone overrides the sizing there, which an inline template could not allow.
  const gridSizing = {
    "--time-col": zoom.timeColumn,
    "--panel-col": zoom.column,
    "--panels": panels.length,
  } as React.CSSProperties;

  const dockVisible = Boolean((editing && movingBooking) || lastChange || flash);

  // The phone shows the date as words, not as a date field's "09/25/2026",
  // which a narrow screen cut down to "09/2".
  const shownDay = days.find((day) => day.key === dateKey);
  const relativeDay =
    dateKey === today
      ? "Today"
      : dateKey === shiftDateKey(today, -1)
        ? "Yesterday"
        : dateKey === shiftDateKey(today, 1)
          ? "Tomorrow"
          : null;

  const stepButton =
    "flex min-h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-lg leading-none font-semibold text-slate-700 transition active:bg-slate-100 disabled:opacity-35";

  return (
    <div
      className={`mx-auto max-w-7xl px-3 py-3 sm:px-4 sm:py-6 ${
        dockVisible ? "pb-36 md:pb-28" : ""
      }`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Phone: one row. A day either way and the date between them -
            the three-button strip and its label are too wide. */}
        <div className="flex min-w-0 flex-1 items-stretch gap-1.5 sm:hidden">
          <button
            type="button"
            aria-label="Previous day"
            disabled={dateKey <= firstDay}
            onClick={() => stepDay(-1)}
            className={stepButton}
          >
            &lsaquo;
          </button>
          {/* The date in words, with the date field laid invisibly over it:
              a tap still opens the phone's own calendar. */}
          <label className="relative flex min-h-10 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center rounded-lg border border-slate-300 bg-white px-2 py-1 leading-tight focus-within:border-slate-900 focus-within:ring-2 focus-within:ring-slate-900/10">
            <span className="max-w-full truncate text-sm font-semibold text-slate-900">
              {shownDay
                ? `${shownDay.weekday}, ${shownDay.dayOfMonth} ${shownDay.month}`
                : longDateLabel(dateKey)}
            </span>
            {relativeDay ? (
              <span className="text-[11px] font-medium text-indigo-600">
                {relativeDay}
              </span>
            ) : null}
            <input
              type="date"
              aria-label="Date"
              value={dateKey}
              min={firstDay}
              max={lastDay}
              onChange={(event) => {
                if (event.target.value) setDateKey(event.target.value);
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
          <button
            type="button"
            aria-label="Next day"
            disabled={dateKey >= lastDay}
            onClick={() => stepDay(1)}
            className={stepButton}
          >
            &rsaquo;
          </button>
        </div>

        {/* Laptop: the three days controllers reach for, and any other. */}
        <div className="hidden gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200 sm:flex">
          {QUICK_DAYS.map((day) => {
            const key = shiftDateKey(today, day.offset);
            const selected = key === dateKey;
            return (
              <button
                key={day.label}
                type="button"
                aria-pressed={selected}
                onClick={() => setDateKey(key)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  selected
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {day.label}
              </button>
            );
          })}
        </div>

        {/* Candidates can book six days out, so the grid still has to reach
            them; a date field does that without another eight-tile strip. */}
        <input
          type="date"
          aria-label="Another date"
          value={dateKey}
          min={firstDay}
          max={lastDay}
          onChange={(event) => {
            if (event.target.value) setDateKey(event.target.value);
          }}
          className="hidden rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-slate-900 sm:block"
        />

        <p className="hidden text-sm text-slate-600 sm:block">
          {longDateLabel(dateKey)} &middot; {bookings.length} session
          {bookings.length === 1 ? "" : "s"}
        </p>

        <div className="flex items-center gap-2 sm:ml-auto">
          {/* The phone has one layout of its own, so zoom is a laptop control. */}
          <div className="hidden items-center gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200 sm:flex">
            <button
              type="button"
              onClick={zoomOut}
              disabled={!canZoomOut}
              aria-label="Zoom out"
              title="Fit more of the day on screen"
              className="rounded-lg px-2.5 py-1 text-base leading-none font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              &minus;
            </button>
            <span className="w-16 text-center text-xs font-medium text-slate-600">
              {ZOOM_LEVELS[level].name}
            </span>
            <button
              type="button"
              onClick={zoomIn}
              disabled={!canZoomIn}
              aria-label="Zoom in"
              title="Show more of each session"
              className="rounded-lg px-2.5 py-1 text-base leading-none font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </div>

          {/* Locked by default. Every change - book, move, cancel, close a
              panel, seat from the queue - needs Edit on first. */}
          <button
            type="button"
            onClick={() => setEditMode(!editing)}
            aria-pressed={editing}
            className={`flex min-h-10 items-center gap-1.5 self-stretch rounded-lg px-3.5 text-sm font-semibold transition sm:min-h-0 sm:py-1.5 ${
              editing
                ? "bg-amber-400 text-amber-950 shadow-sm hover:bg-amber-300"
                : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
          >
            {editing ? (
              <>
                <span
                  aria-hidden
                  className="h-2 w-2 animate-pulse rounded-full bg-amber-900"
                />
                Done
              </>
            ) : (
              <>
                <svg
                  aria-hidden
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4"
                >
                  <path d="M13.6 2.9a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8l-9.4 9.4-3.9 1.1a.6.6 0 0 1-.7-.7l1.1-3.9 9.4-9.4Z" />
                </svg>
                Edit
              </>
            )}
          </button>
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:mt-4"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 sm:mt-4"
        >
          {notice}
        </p>
      ) : null}

      {historyId ? (
        <CandidateHistory
          candidateId={historyId}
          onClose={() => setHistoryId(null)}
        />
      ) : null}

      <section
        className={`mt-3 overflow-hidden rounded-2xl border bg-white shadow-sm transition sm:mt-4 ${
          editing ? "border-amber-300 ring-2 ring-amber-200" : "border-slate-200"
        }`}
      >
        {/* On a phone: the screen less the header and the toolbar (about
            8.5rem between them), so the grid runs to the bottom of the screen
            and the page itself barely scrolls. */}
        <div className="thin-scroll max-h-[calc(100dvh-8.5rem)] min-h-64 overflow-auto overscroll-contain sm:max-h-[72vh]">
          <div
            className="schedule-grid grid w-full sm:w-auto sm:min-w-max"
            style={gridSizing}
          >
            <div
              style={{ gridColumn: 1, gridRow: 1 }}
              className="sticky top-0 left-0 z-30 border-r border-b border-slate-200 bg-slate-50 px-1 py-2 text-xs font-semibold tracking-wider text-slate-500 uppercase sm:px-3 sm:py-3"
            >
              <span className="max-sm:hidden">Time</span>
            </div>
            {panels.map((panel, column) => (
              <div
                key={panel.id}
                style={{ gridColumn: column + 2, gridRow: 1 }}
                className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-1 py-2 text-center sm:px-3 sm:py-3"
              >
                <p className="truncate text-xs font-bold tracking-tight text-slate-900 sm:text-sm">
                  {panel.label}
                </p>
                {closedPanelIds.has(panel.id) ? (
                  <p
                    className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold sm:text-[11px] ${TONES.closed.chip}`}
                  >
                    Closed
                  </p>
                ) : (
                  <p className="text-[10px] text-slate-500 sm:text-xs">
                    {countsByPanel.get(panel.id) ?? 0} booked
                  </p>
                )}
                {editing ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setClosed(panel.id, !closedPanelIds.has(panel.id))
                    }
                    className={`mt-1 rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition disabled:opacity-50 max-sm:hidden ${
                      closedPanelIds.has(panel.id)
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {closedPanelIds.has(panel.id) ? "Reopen" : "Close day"}
                  </button>
                ) : null}
              </div>
            ))}

            {ALL_SLOT_INDEXES.map((slotIndex) => (
              <div
                key={`time-${slotIndex}`}
                style={{ gridColumn: 1, gridRow: slotIndex + 2 }}
                className={`sticky left-0 z-10 border-r border-b border-slate-100 px-1 py-1 text-right sm:px-2 ${zoom.detail ? "sm:py-2" : "sm:py-0.5"} ${slotIsPast(slotIndex) ? "bg-slate-50 text-slate-400" : "bg-white text-slate-600"}`}
              >
                {/* Phone: a ruler - the hour, then ":30". */}
                <p
                  className={`whitespace-nowrap tabular-nums sm:hidden ${
                    slotIndex % 2 === 0
                      ? "text-[11px] font-semibold"
                      : "text-[10px] opacity-60"
                  }`}
                >
                  {slotShortLabel(slotIndex)}
                </p>
                <div className="max-sm:hidden">
                  <p
                    className={`font-semibold tabular-nums ${zoom.detail ? "text-xs" : zoom.text}`}
                  >
                    {slotStartLabel(slotIndex)}
                  </p>
                  {zoom.detail ? (
                    <p className="text-[10px] tabular-nums opacity-70">
                      {slotEndLabel(slotIndex)}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}

            {ALL_SLOT_INDEXES.flatMap((slotIndex) =>
              panels.map((panel, column) => {
                const key = cellKey(panel.id, slotIndex);
                const booking = startAt.get(key);
                const past = slotIsPast(slotIndex);

                // Covered by a session that started higher up: the chip above
                // spans over this cell, so nothing is drawn here at all.
                if (!booking && occupied.has(key)) return null;

                const placement = {
                  gridColumn: column + 2,
                  gridRow: booking
                    ? `${slotIndex + 2} / span ${booking.slotCount}`
                    : slotIndex + 2,
                };

                if (booking) {
                  const isMoving = movingId === booking.id;
                  const hue = chipHue(booking.companyName);
                  // Locked, a tap only looks: it opens the history. Editing,
                  // it picks the session up to move.
                  const activate = () => {
                    if (!editing || past) {
                      setHistoryId(booking.candidateId);
                      return;
                    }
                    setMovingId(isMoving ? null : booking.id);
                  };
                  // The session has happened and no mock was ticked off for
                  // that candidate that day. Ticking one late on the Mock page
                  // clears this on the next poll, as it does the chevrons.
                  const noMock = past && booking.needsMock;
                  return (
                    <div
                      key={key}
                      style={placement}
                      className={`relative isolate border-b border-slate-100 max-sm:p-0.5 ${zoom.padding} ${past ? "bg-slate-50" : ""}`}
                    >
                      <div
                        draggable={editing && !busy && !past}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", booking.id);
                          event.dataTransfer.effectAllowed = "move";
                          setMovingId(booking.id);
                        }}
                        onDragEnd={() => setDropTarget(null)}
                        onClick={activate}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            activate();
                          }
                        }}
                        title={`${booking.candidateName} / ${booking.companyName} / ${booking.sessionType} / ${sessionRangeLabel(booking.slotIndex, booking.slotCount)}${noMock ? " / No mock" : ""}`}
                        className={`group relative isolate flex h-full flex-col overflow-hidden rounded-lg border py-1 pr-1 pl-2.5 shadow-sm transition sm:rounded-xl sm:py-1.5 sm:pr-2 sm:pl-3.5 ${hue.card} ${
                          past
                            ? "cursor-pointer opacity-60 saturate-50"
                            : isMoving
                              ? "cursor-grab shadow-lg ring-2 ring-sky-400 ring-offset-1 active:cursor-grabbing"
                              : editing
                                ? "cursor-grab hover:-translate-y-px hover:shadow-md active:cursor-grabbing"
                                : "cursor-pointer hover:shadow-md"
                        }`}
                      >
                        {/* Solid rail down the left edge: the company's colour
                            at full strength, so the chip reads as a block of
                            booked time even when its body is mostly empty. */}
                        <span
                          aria-hidden
                          className={`absolute inset-y-0 left-0 z-[2] w-1 ${hue.rail}`}
                        />

                        {booking.needsMock && !past ? (
                          <>
                            <NeedMock compact label={false} />
                            {/* Fades the chevrons out under the text, so the
                                words sit on clean colour and the pattern
                                sweeps in from the right. */}
                            <span
                              aria-hidden
                              className={`pointer-events-none absolute inset-0 z-[1] bg-linear-to-r ${hue.fade}`}
                            />
                          </>
                        ) : null}

                        {/* Phone: who, and for whom - nothing else fits a
                            column a third of the screen wide, and nothing
                            else is needed to find someone. */}
                        <p
                          className={`relative z-10 line-clamp-2 text-[11px] leading-tight break-words sm:hidden ${hue.name}`}
                        >
                          <span className="font-semibold tracking-[0.02em] uppercase">
                            {booking.candidateName}
                          </span>
                          <span className={hue.company}>
                            {" "}
                            &ndash; {booking.companyName}
                          </span>
                        </p>

                        {/* Laptop, line one: who, and what kind of session.
                            The name gives way first when space runs out, so
                            the session type is never the part that gets cut. */}
                        <div
                          className={`relative z-10 flex items-start gap-1.5 max-sm:hidden ${zoom.nameText}`}
                        >
                          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                            <button
                              type="button"
                              title={`View ${booking.candidateName}'s history`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setHistoryId(booking.candidateId);
                              }}
                              className={`min-w-0 cursor-pointer truncate rounded text-left font-semibold tracking-[0.04em] uppercase underline decoration-transparent underline-offset-2 transition hover:decoration-current ${hue.name}`}
                            >
                              {booking.candidateName}
                            </button>

                            {zoom.detail ? (
                              <span
                                className={`shrink-0 text-[0.9em] font-medium whitespace-nowrap ${hue.session}`}
                              >
                                <span aria-hidden className="mr-1.5 opacity-60">
                                  &ndash;
                                </span>
                                {booking.sessionType}
                              </span>
                            ) : null}
                          </div>

                          {editing && !past ? (
                            <button
                              type="button"
                              aria-label={`Cancel booking for ${booking.candidateName}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void cancelBooking(booking);
                              }}
                              className="shrink-0 rounded px-1 text-sm leading-none text-slate-500 opacity-0 transition group-hover:opacity-100 hover:text-rose-700 focus:opacity-100 pointer-coarse:-my-1 pointer-coarse:px-2 pointer-coarse:py-1 pointer-coarse:text-base pointer-coarse:opacity-100"
                            >
                              &times;
                            </button>
                          ) : null}
                        </div>

                        {/* Laptop, line two: the company, as the display line.
                            Sized per zoom to fill what the name leaves of a
                            half-hour chip; uppercase has no descenders, so it
                            can sit on a line height of 1. A longer session has
                            room to wrap rather than cut the name off. */}
                        <p
                          className={`relative z-10 mt-1 font-bold tracking-[0.02em] uppercase max-sm:hidden ${hue.company} ${zoom.companyText} ${
                            booking.slotCount > 1
                              ? "line-clamp-3 leading-[1.05] break-words"
                              : "truncate leading-none"
                          }`}
                        >
                          {booking.companyName}
                        </p>
                      </div>

                      {/* Stamped over the chip rather than inside it: the chip
                          of a finished session is faded, and this is the one
                          thing on it that still wants attention, so it sits
                          outside the fade at full strength. It lets taps
                          through to the chip underneath. */}
                      {noMock ? (
                        <span className="pointer-events-none absolute top-1/2 right-1 z-10 -translate-y-1/2 -rotate-6 rounded-md border-[1.5px] border-rose-500 bg-white/90 px-1 py-px text-[8px] leading-none font-black tracking-[0.14em] whitespace-nowrap text-rose-600 uppercase shadow-sm sm:right-3 sm:border-2 sm:px-2 sm:py-0.5 sm:text-[11px]">
                          No mock
                        </span>
                      ) : null}
                    </div>
                  );
                }

                if (closedPanelIds.has(panel.id)) {
                  return (
                    <div
                      key={key}
                      style={placement}
                      className="border-b border-slate-100 bg-slate-100 p-0.5 sm:p-1.5"
                    >
                      <div
                        className={`flex h-full max-sm:min-h-10 ${zoom.row} items-center justify-center rounded-lg border border-dashed max-sm:text-[10px] ${zoom.text} font-medium ${TONES.closed.card} ${TONES.closed.text}`}
                      >
                        Closed
                      </div>
                    </div>
                  );
                }

                if (past || !editing) {
                  // Nothing to do here: a past slot is history, and a locked
                  // grid takes no bookings. Drawn, but not a button.
                  return (
                    <div
                      key={key}
                      style={placement}
                      className={`border-b border-slate-100 max-sm:p-0.5 ${zoom.padding} ${past ? "bg-slate-50" : ""}`}
                    >
                      <div
                        className={`h-full max-sm:min-h-10 ${zoom.row} rounded-lg border border-dashed ${past ? "border-slate-200" : "border-slate-200/70"}`}
                      />
                    </div>
                  );
                }

                const isDropTarget = dropTarget === key;
                return (
                  <div
                    key={key}
                    style={placement}
                    onDragOver={(event) => {
                      if (!movingId) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget(key);
                    }}
                    onDragLeave={() =>
                      setDropTarget((current) => (current === key ? null : current))
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      const bookingId =
                        event.dataTransfer.getData("text/plain") || movingId;
                      if (bookingId) void move(bookingId, panel.id, slotIndex);
                    }}
                    className={`border-b border-slate-100 max-sm:p-0.5 ${zoom.padding}`}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleEmptyCellClick(panel.id, slotIndex)}
                      className={`h-full max-sm:min-h-10 ${zoom.row} w-full rounded-lg border border-dashed max-sm:text-[10px] ${zoom.text} transition ${isDropTarget ? "border-sky-500 bg-sky-100 text-sky-800" : movingId ? "border-sky-300 bg-sky-50/40 text-sky-700 hover:border-sky-500 hover:bg-sky-100" : "border-slate-200 text-transparent hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 pointer-coarse:text-slate-300 active:border-emerald-400 active:bg-emerald-50 active:text-emerald-700"}`}
                    >
                      {movingId ? "Place here" : "Add"}
                    </button>
                  </div>
                );
              }),
            )}
          </div>
        </div>
      </section>

      {waiting.length > 0 ? (
        <section className="mt-5 overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm">
          <header className="border-b border-sky-100 bg-sky-50 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-sky-900">
              Waiting list &middot; {waiting.length}
            </h2>
            <p className="text-xs text-sky-800">
              First come, first served. Place someone once a panel frees up.
            </p>
          </header>
          <ul className="divide-y divide-slate-100">
            {waiting.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
              >
                <span
                  className={`w-10 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${TONES.waiting.chip}`}
                >
                  #{entry.position}
                </span>
                <span className="w-32 shrink-0 tabular-nums text-slate-600">
                  {sessionRangeLabel(entry.slotIndex, entry.slotCount)}
                </span>
                <span className="min-w-0 flex-1 text-slate-900">
                  <button
                    type="button"
                    title={`View ${entry.candidateName}'s history`}
                    onClick={() => setHistoryId(entry.candidateId)}
                    className="cursor-pointer rounded font-medium underline decoration-transparent underline-offset-2 transition hover:decoration-current"
                  >
                    {entry.candidateName}
                  </button>{" "}
                  &middot; {entry.companyName} &middot;{" "}
                  {entry.sessionType}
                  {entry.reason === "panel_closed" ? (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                      pushed out by a closure
                    </span>
                  ) : null}
                </span>
                {editing ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => placeFromQueue(entry)}
                    className={`shrink-0 ${BUTTON.book}`}
                  >
                    Place
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-3 text-xs text-slate-500">
        {loading && !data ? (
          "Loading schedule..."
        ) : editing ? (
          <>
            <span className="pointer-coarse:hidden">
              Drag a session to another panel or time, or click it and then an
              empty slot. Click an empty slot to book.
            </span>
            <span className="hidden pointer-coarse:inline">
              Tap a session, then an empty slot to move it. Tap an empty slot
              to book.
            </span>{" "}
            Tap Done when finished.
          </>
        ) : (
          <>
            View only &mdash;{" "}
            <span className="pointer-coarse:hidden">click</span>
            <span className="hidden pointer-coarse:inline">tap</span> a
            session for the candidate&apos;s history. Turn on Edit to book,
            move or cancel.
          </>
        )}{" "}
        Updates every few seconds.
      </p>

      {/* The dock: what is armed, and what can be taken back. Bottom of the
          screen, clear of the home indicator - where the eye already is after
          a tap, and never pushing the grid down. */}
      {dockVisible ? (
        <div className="no-print fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-lg flex-col gap-2 md:bottom-6">
          {editing && movingBooking ? (
            <div
              role="status"
              className="rounded-2xl bg-sky-600 px-4 py-3 text-sm text-white shadow-xl"
            >
              <p className="truncate font-semibold">
                Moving {movingBooking.candidateName}
                <span className="font-normal text-sky-100">
                  {" "}
                  &middot; {movingBooking.companyName}
                </span>
              </p>
              <p className="text-xs text-sky-100">
                Choose an empty slot for it.
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => void cancelBooking(movingBooking)}
                  className="rounded-lg bg-white/15 px-3 py-2 text-xs font-semibold transition hover:bg-white/25 active:bg-white/25"
                >
                  Cancel booking
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryId(movingBooking.candidateId)}
                  className="rounded-lg bg-white/15 px-3 py-2 text-xs font-semibold transition hover:bg-white/25 active:bg-white/25"
                >
                  History
                </button>
                <button
                  type="button"
                  onClick={() => setMovingId(null)}
                  className="ml-auto rounded-lg bg-white px-3.5 py-2 text-xs font-bold text-sky-700 transition active:bg-sky-50"
                >
                  Done
                </button>
              </div>
            </div>
          ) : null}

          {lastChange ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-2xl bg-slate-900 py-2 pr-2 pl-4 text-sm text-white shadow-xl"
            >
              <p className="min-w-0 flex-1 truncate">{lastChange.label}</p>
              <button
                type="button"
                onClick={undo}
                disabled={undoing}
                className="shrink-0 rounded-lg px-3 py-2 text-sm font-bold text-amber-300 transition hover:bg-white/10 active:bg-white/10 disabled:opacity-60"
              >
                {undoing ? "Undoing..." : "Undo"}
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setLastChange(null)}
                className="shrink-0 rounded-lg px-2.5 py-2 leading-none text-slate-400 transition hover:bg-white/10 active:bg-white/10"
              >
                &times;
              </button>
            </div>
          ) : flash ? (
            <p
              role="status"
              className="rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl"
            >
              {flash}
            </p>
          ) : null}
        </div>
      ) : null}

      {target ? (
        <BookingDialog
          key={`${target.dateKey}:${target.slotIndex}:${target.slotCount}`}
          target={target}
          role="controller"
          panels={panels}
          candidates={candidates}
          panelsFreeFor={(count: number) =>
            panelsFreeFor(target.slotIndex, count)
          }
          onClose={() => setTarget(null)}
          onBooked={booked}
        />
      ) : null}
    </div>
  );
}
