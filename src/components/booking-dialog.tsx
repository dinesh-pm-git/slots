"use client";

import { useEffect, useMemo, useState } from "react";

import { MAX_RECRUITER_EMAIL, MAX_RECRUITER_PHONE } from "@/lib/contact";
import {
  APPROVAL_LABEL,
  DURATION_CHOICES,
  durationLabel,
  fitsInDay,
  EXTRA_HOURS_NOTE,
  hasExtraHours,
  longDateLabel,
  sessionRangeLabel,
} from "@/lib/time";
import {
  SESSION_TYPES,
  type CandidateSummary,
  type Panel,
  type SessionType,
} from "@/lib/types";

/** What was just booked, so the caller can offer to take it back. */
export type BookedSession = {
  id: string;
  panelId: string;
  slotIndex: number;
  slotCount: number;
  candidateId: string;
};

export type BookingTarget = {
  dateKey: string;
  slotIndex: number;
  /** Length in half-hour blocks: 1 = 30 min ... 4 = 2 hours. */
  slotCount: number;
  /** Panels free for the WHOLE session, best choice first. */
  panelIds: string[];
  /** "waitlist" when every panel is taken and this joins the queue instead. */
  mode?: "book" | "waitlist";
};

type Props = {
  target: BookingTarget;
  role: "candidate" | "controller";
  panels: Panel[];
  candidates: CandidateSummary[];
  onClose: () => void;
  /** Null when the request joined the waiting list rather than booking. */
  onBooked: (booked: BookedSession | null) => void;
  /**
   * Supplied when the length may be changed here: returns the panels free for
   * a whole session of that many blocks, so switching to 2 hours re-checks
   * availability instead of failing at submit.
   */
  panelsFreeFor?: (slotCount: number) => string[];
};

/**
 * Collects the two mandatory fields, Company Name and Session Type, plus an
 * optional recruiter contact.
 *
 * Candidates are never shown a panel - availability is consolidated across
 * panels and the server allocates whichever one is free. Controllers do pick,
 * because they are arranging the panels themselves.
 *
 * Callers mount this with a key derived from the target slot, so opening a
 * different slot remounts it with fresh state instead of resetting fields in
 * an effect.
 */
export default function BookingDialog({
  target,
  role,
  panels,
  candidates,
  onClose,
  onBooked,
  panelsFreeFor,
}: Props) {
  const [companyName, setCompanyName] = useState("");
  const [recruiterPhone, setRecruiterPhone] = useState("");
  const [recruiterEmail, setRecruiterEmail] = useState("");
  const [sessionType, setSessionType] = useState<SessionType>("Interview");
  const [candidateId, setCandidateId] = useState("");
  const [slotCount, setSlotCount] = useState(target.slotCount);
  const [panelId, setPanelId] = useState(target.panelIds[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One company name offered while typing, so "virtuval tech guru" becomes
  // "Virtual Tech Gurus" before it is ever saved. Asked for once the typing
  // pauses, and kept with the text it answers, so a reply that arrives after
  // more typing is simply ignored.
  const [suggested, setSuggested] = useState<{
    typed: string;
    name: string | null;
  } | null>(null);

  useEffect(() => {
    const typed = companyName.trim();
    if (typed.replace(/[^a-z0-9]/gi, "").length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/companies/suggest?q=${encodeURIComponent(typed)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { suggestion?: string | null };
        setSuggested({ typed, name: body.suggestion ?? null });
      } catch {
        // Aborted by more typing, or offline: no suggestion is the fallback.
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [companyName]);

  const suggestion =
    suggested &&
    suggested.typed === companyName.trim() &&
    suggested.name &&
    suggested.name !== companyName.trim()
      ? suggested.name
      : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const availableIds = useMemo(
    () => (panelsFreeFor ? panelsFreeFor(slotCount) : target.panelIds),
    [panelsFreeFor, slotCount, target.panelIds],
  );

  const choices = useMemo(
    () =>
      availableIds.map((id) => ({
        id,
        label: panels.find((panel) => panel.id === id)?.label ?? id,
      })),
    [panels, availableIds],
  );

  // Changing the length can take the chosen panel away; fall back to a free one.
  const effectivePanelId = availableIds.includes(panelId)
    ? panelId
    : (availableIds[0] ?? "");

  const tooLate = !fitsInDay(target.slotIndex, slotCount);
  const waitlisting = target.mode === "waitlist";
  const noRoom = !waitlisting && availableIds.length === 0;

  const panelLabel = useMemo(
    () =>
      choices.find((choice) => choice.id === effectivePanelId)?.label ??
      effectivePanelId,
    [choices, effectivePanelId],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(
        waitlisting ? "/api/waiting-list" : "/api/bookings",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: target.dateKey,
          slotIndex: target.slotIndex,
          slotCount,
          companyName: companyName.trim(),
          recruiterPhone: recruiterPhone.trim(),
          recruiterEmail: recruiterEmail.trim(),
          sessionType,
          ...(role === "controller"
            ? waitlisting
              ? { candidateId }
              : { candidateId, panelId: effectivePanelId }
            : {}),
        }),
      },
      );
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(
          result.error ??
            (waitlisting
              ? "Could not join the waiting list."
              : "Could not book that slot."),
        );
        return;
      }

      onBooked(
        waitlisting || typeof result.id !== "string"
          ? null
          : {
              id: result.id,
              panelId: result.panelId,
              slotIndex: target.slotIndex,
              slotCount,
              candidateId,
            },
      );
      onClose();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-dialog-title"
        className="thin-scroll max-h-[92dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:max-h-[90vh] sm:rounded-2xl sm:p-6"
      >
        <h2
          id="booking-dialog-title"
          className="text-lg font-semibold text-slate-900"
        >
          {target.mode === "waitlist" ? "Join the waiting list" : "Book this slot"}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {tooLate
            ? `Starts ${sessionRangeLabel(target.slotIndex, 1).split(" ")[0]}`
            : sessionRangeLabel(target.slotIndex, slotCount)}{" "}
          on {longDateLabel(target.dateKey)}
          <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
            {durationLabel(slotCount)}
          </span>
        </p>

        {hasExtraHours(target.slotIndex, slotCount) ? (
          <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span className="font-semibold">{APPROVAL_LABEL}</span> — this
            session runs {EXTRA_HOURS_NOTE}.
          </p>
        ) : null}

        {target.mode === "waitlist" ? (
          <p className="mt-3 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
            Every panel is taken at this time. You will be given a place in the
            queue, and a controller can seat you if one frees up.
          </p>
        ) : null}

        <form onSubmit={submit} className="mt-5 space-y-4">
          {panelsFreeFor ? (
            <fieldset>
              <legend className="block text-sm font-medium text-slate-700">
                Session length
              </legend>
              <div className="mt-1.5 grid grid-cols-4 gap-2">
                {DURATION_CHOICES.map((choice) => {
                  const disabled = !fitsInDay(target.slotIndex, choice.slots);
                  return (
                    <label
                      key={choice.slots}
                      className={
                        disabled
                          ? "cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-medium text-slate-400"
                          : slotCount === choice.slots
                            ? "cursor-pointer rounded-lg border border-slate-900 bg-slate-900 px-2 py-2 text-center text-xs font-semibold text-white transition"
                            : "cursor-pointer rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-xs font-medium text-slate-700 transition hover:border-slate-400"
                      }
                    >
                      <input
                        type="radio"
                        name="dialogSlotCount"
                        value={choice.slots}
                        disabled={disabled}
                        checked={slotCount === choice.slots}
                        onChange={() => setSlotCount(choice.slots)}
                        className="sr-only"
                      />
                      {choice.label}
                    </label>
                  );
                })}
              </div>
              {noRoom && !tooLate ? (
                <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  No panel is free for {durationLabel(slotCount)} starting here.
                  Pick a shorter session.
                </p>
              ) : (
                <p className="mt-2 text-xs text-slate-500">
                  A longer session needs the same panel free for the whole time.
                </p>
              )}
            </fieldset>
          ) : null}

          {role === "controller" ? (
            <div>
              <label
                htmlFor="candidate"
                className="block text-sm font-medium text-slate-700"
              >
                Candidate
              </label>
              <select
                id="candidate"
                required
                value={candidateId}
                onChange={(event) => setCandidateId(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10"
              >
                <option value="" disabled>
                  Select a candidate...
                </option>
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {role === "controller" && target.mode !== "waitlist" ? (
            <div>
              <label
                htmlFor="panel"
                className="block text-sm font-medium text-slate-700"
              >
                Panel <span className="text-rose-600">*</span>
              </label>
              {choices.length > 1 ? (
                <select
                  id="panel"
                  value={effectivePanelId}
                  onChange={(event) => setPanelId(event.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10"
                >
                  {choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900">
                  {panelLabel}
                  <span className="ml-2 font-normal text-slate-500">
                    (the only panel free at this time)
                  </span>
                </p>
              )}
            </div>
          ) : null}

          <div>
            <label
              htmlFor="companyName"
              className="block text-sm font-medium text-slate-700"
            >
              Company Name <span className="text-rose-600">*</span>
            </label>
            <input
              id="companyName"
              required
              maxLength={120}
              autoFocus={role === "candidate"}
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder="e.g. Northwind Systems"
              autoComplete="off"
              aria-describedby={suggestion ? "companyName-suggestion" : undefined}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10"
            />
            {/* One suggestion at most: a tap takes it, typing on ignores it. */}
            {suggestion ? (
              <button
                id="companyName-suggestion"
                type="button"
                onClick={() => setCompanyName(suggestion)}
                aria-label={`Use company name ${suggestion}`}
                className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-left text-sm text-indigo-900 transition hover:bg-indigo-100 active:scale-[0.99] sm:py-1"
              >
                <span className="shrink-0 text-xs text-indigo-600">
                  Use
                </span>
                <span className="truncate font-semibold">{suggestion}</span>
              </button>
            ) : null}
          </div>

          <fieldset>
            <legend className="block text-sm font-medium text-slate-700">
              Recruiter Contact
            </legend>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              <input
                type="tel"
                aria-label="Recruiter phone"
                maxLength={MAX_RECRUITER_PHONE}
                value={recruiterPhone}
                onChange={(event) => setRecruiterPhone(event.target.value)}
                placeholder="Phone"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10"
              />
              <input
                type="email"
                aria-label="Recruiter email"
                maxLength={MAX_RECRUITER_EMAIL}
                value={recruiterEmail}
                onChange={(event) => setRecruiterEmail(event.target.value)}
                placeholder="Email"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10"
              />
            </div>
          </fieldset>

          <fieldset>
            <legend className="block text-sm font-medium text-slate-700">
              Session Type <span className="text-rose-600">*</span>
            </legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {SESSION_TYPES.map((type) => (
                <label
                  key={type}
                  className={
                    sessionType === type
                      ? "cursor-pointer rounded-lg border border-slate-900 bg-slate-900 px-3 py-2.5 text-center text-sm font-medium text-white transition"
                      : "cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-center text-sm font-medium text-slate-700 transition hover:border-slate-400"
                  }
                >
                  <input
                    type="radio"
                    name="sessionType"
                    value={type}
                    checked={sessionType === type}
                    onChange={() => setSessionType(type)}
                    className="sr-only"
                  />
                  {type}
                </label>
              ))}
            </div>
          </fieldset>

          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"
            >
              {error}
            </p>
          ) : null}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || noRoom || tooLate}
              className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy
                ? target.mode === "waitlist"
                  ? "Joining..."
                  : "Booking..."
                : target.mode === "waitlist"
                  ? "Join waiting list"
                  : "Confirm booking"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
