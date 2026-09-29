"use client";

import { useMemo, useState } from "react";

import CandidateHistory from "@/components/candidate-history";
import type { CandidateSource } from "@/lib/types";
import { usePolledResource } from "@/lib/use-poll";

type CandidateRecord = {
  id: string;
  token: string;
  name: string;
  phone: string | null;
  source: CandidateSource;
  company: string | null;
  active: boolean;
  bookingCount: number;
  createdAt: string;
};

type Filter = "all" | "active" | "disabled";

/** Who already holds a number the form was given. */
type PhoneHolder = {
  id: string;
  token: string;
  name: string;
  active: boolean;
  /** As it was typed into the form. */
  phone: string;
};

function SourceBadge({ source }: { source: CandidateSource }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
        source === "Uniq"
          ? "bg-indigo-100 text-indigo-700"
          : "bg-amber-100 text-amber-800"
      }`}
    >
      {source}
    </span>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          active ? "bg-emerald-500" : "bg-slate-400"
        }`}
      />
      {active ? "Active" : "Disabled"}
    </span>
  );
}

export default function CandidatesBoard() {
  const [notice, setNotice] = useState<string | null>(null);
  const [issued, setIssued] = useState<CandidateRecord | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState<CandidateSource>("Uniq");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState<PhoneHolder | null>(null);

  // Polled so a token issued by one controller shows up for the others.
  const { data, error, loading, refresh } = usePolledResource<{
    records: CandidateRecord[];
  }>("/api/candidates", 10_000);

  const records = useMemo(() => data?.records ?? [], [data]);

  async function createCandidate(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    setTaken(null);
    setBusy(true);

    try {
      const response = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          source,
          company: company.trim(),
        }),
      });
      const result = await response.json().catch(() => ({}));

      // The number is already someone's: point at them, beside the form,
      // rather than an error at the top of the page.
      if (response.status === 409 && result.existing) {
        setTaken({ ...result.existing, phone: phone.trim() });
        return;
      }

      if (!response.ok) {
        setNotice(result.error ?? "Could not create that candidate.");
        return;
      }

      setIssued({ ...result, active: true, bookingCount: 0 });
      setName("");
      setPhone("");
      setCompany("");
      refresh();
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(record: CandidateRecord) {
    setNotice(null);
    setPendingId(record.id);

    try {
      const response = await fetch(`/api/candidates/${record.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !record.active }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        setNotice(result.error ?? "Could not update that token.");
        return;
      }

      refresh();
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setPendingId(null);
    }
  }

  function toggleOne(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function setSelectedActive(active: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;

    setNotice(null);
    setBulkBusy(true);
    try {
      const response = await fetch("/api/candidates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, active }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setNotice(result.error ?? "Could not update those tokens.");
        return;
      }

      // Selection is kept: enabling then disabling the same batch is common.
      setNotice(
        `${active ? "Enabled" : "Disabled"} ${result.updated} token${result.updated === 1 ? "" : "s"}.`,
      );
      refresh();
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;

    const chosen = records.filter((record) => selected.has(record.id));
    const bookings = chosen.reduce((sum, record) => sum + record.bookingCount, 0);

    const confirmed = window.confirm(
      bookings > 0
        ? `Delete ${ids.length} candidate${ids.length === 1 ? "" : "s"}?\n\nThis also cancels ${bookings} booking${bookings === 1 ? "" : "s"} and frees those slots. It cannot be undone.`
        : `Delete ${ids.length} candidate${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
    );
    if (!confirmed) return;

    setNotice(null);
    setDeleting(true);
    try {
      const response = await fetch("/api/candidates", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setNotice(result.error ?? "Could not delete those candidates.");
        return;
      }

      setSelected(new Set());
      if (issued && ids.includes(issued.id)) setIssued(null);
      setNotice(
        `Deleted ${result.deleted} candidate${result.deleted === 1 ? "" : "s"}` +
          (result.bookingsRemoved > 0
            ? ` and ${result.bookingsRemoved} booking${result.bookingsRemoved === 1 ? "" : "s"}.`
            : "."),
      );
      refresh();
    } catch {
      setNotice("Could not reach the server.");
    } finally {
      setDeleting(false);
    }
  }

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    // A number is found however it was written: "98400 10001" matches a
    // record saved as "+91 9840010001".
    const digits = term.replace(/\D/g, "");
    return records.filter((record) => {
      if (filter === "active" && !record.active) return false;
      if (filter === "disabled" && record.active) return false;
      if (!term) return true;
      return (
        record.name.toLowerCase().includes(term) ||
        record.token.toLowerCase().includes(term) ||
        (record.company ?? "").toLowerCase().includes(term) ||
        record.source.toLowerCase().includes(term) ||
        (record.phone ?? "").includes(term) ||
        (digits.length >= 4 &&
          (record.phone ?? "").replace(/\D/g, "").includes(digits))
      );
    });
  }, [records, filter, search]);

  const activeCount = records.filter((record) => record.active).length;

  // Read live from the roster, so "Enable token" takes effect in the message
  // as soon as the list refreshes.
  const takenRecord = taken
    ? records.find((record) => record.id === taken.id)
    : undefined;
  const takenActive = takenRecord?.active ?? taken?.active ?? true;

  const visibleIds = visible.map((record) => record.id);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  // Selections the current search has scrolled out of sight still count.
  const hiddenSelected = selected.size - selectedVisible.length;

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  const field =
    "mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10";

  return (
    <div className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Candidates
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Newest first &middot; {activeCount} active of {records.length} token
          {records.length === 1 ? "" : "s"}
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {notice}
        </p>
      ) : null}

      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="text-base font-semibold text-slate-900">
          Generate a token
        </h2>

        <p className="mt-1 text-sm text-slate-600">
          A token is not tied to a panel. Candidates are allocated a panel on
          each booking, so one candidate can sit with different panels on the
          same day.
        </p>

        <form
          onSubmit={createCandidate}
          className="mt-4 grid gap-4 sm:grid-cols-3"
        >
          <div className="sm:col-span-2">
            <label
              htmlFor="candidate-name"
              className="block text-sm font-medium text-slate-700"
            >
              Candidate name <span className="text-rose-600">*</span>
            </label>
            <input
              id="candidate-name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Aarav Sharma"
              className={field}
            />
          </div>

          <div>
            <label
              htmlFor="candidate-phone"
              className="block text-sm font-medium text-slate-700"
            >
              Phone number <span className="text-rose-600">*</span>
            </label>
            {/* Required and unique: the number is how a candidate is told
                apart from everyone else. */}
            <input
              id="candidate-phone"
              type="tel"
              required
              maxLength={32}
              autoComplete="off"
              aria-invalid={taken ? true : undefined}
              aria-describedby={taken ? "candidate-phone-taken" : undefined}
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setTaken(null);
              }}
              placeholder="e.g. +91 98765 43210"
              className={field}
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-slate-700">
              Source
            </span>
            {/* One button that flips, rather than two that look alike: there
                are only ever two answers and one is always in force. */}
            <button
              type="button"
              onClick={() =>
                setSource((current) => (current === "Uniq" ? "Direct" : "Uniq"))
              }
              aria-label={`Source: ${source}. Tap to switch.`}
              className={`mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                source === "Uniq"
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                  : "border-amber-500 bg-amber-50 text-amber-800 hover:bg-amber-100"
              }`}
            >
              {source}
              <span aria-hidden className="text-xs opacity-60">
                &#8646;
              </span>
            </button>
          </div>

          <div className="sm:col-span-2">
            <label
              htmlFor="candidate-company"
              className="block text-sm font-medium text-slate-700"
            >
              Company <span className="text-slate-400">(optional)</span>
            </label>
            <input
              id="candidate-company"
              maxLength={120}
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              placeholder="e.g. Northwind Systems"
              className={field}
            />
          </div>

          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-2.5"
            >
              {busy ? "Generating..." : "Generate token"}
            </button>
          </div>
        </form>

        {taken ? (
          <div
            id="candidate-phone-taken"
            role="alert"
            className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          >
            <p className="min-w-0 flex-1 basis-60">
              <span className="font-semibold">{taken.phone}</span> is already
              registered to <span className="font-semibold">{taken.name}</span>
              {" · token "}
              <span className="font-mono font-bold tracking-wider">
                {taken.token}
              </span>
              {takenActive ? "." : " (disabled)."} One number is one candidate:
              {takenActive
                ? " hand over that token instead."
                : " enable that token instead of issuing a new one."}
            </p>
            <div className="flex w-full gap-2 sm:w-auto">
              <button
                type="button"
                onClick={() => setHistoryId(taken.id)}
                className="flex-1 rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 sm:flex-none sm:py-1.5"
              >
                View
              </button>
              {!takenActive && takenRecord ? (
                <button
                  type="button"
                  onClick={() => toggle(takenRecord)}
                  disabled={pendingId === takenRecord.id}
                  className="flex-1 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60 sm:flex-none sm:py-1.5"
                >
                  Enable token
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setTaken(null)}
                className="flex-1 rounded-lg border border-amber-400 px-3 py-2 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 sm:flex-none sm:py-1.5"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {issued ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3">
            <div>
              <p className="text-xs font-medium tracking-wider text-emerald-700 uppercase">
                Token for {issued.name} &middot; {issued.source}
                {issued.company ? ` · ${issued.company}` : ""}
              </p>
              <p className="font-mono text-3xl font-bold tracking-[0.3em] text-emerald-900">
                {issued.token}
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(issued.token)}
                className="rounded-lg border border-emerald-400 px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-100"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => setIssued(null)}
                className="rounded-lg border border-emerald-400 px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Filter tokens"
            className="flex w-full gap-1 rounded-xl bg-slate-100 p-1 sm:w-auto"
          >
            {(["all", "active", "disabled"] as Filter[]).map((value) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium capitalize transition sm:flex-none sm:py-1.5 ${
                  filter === value
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {value}
              </button>
            ))}
          </div>

          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, token, or phone"
            aria-label="Search candidates"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 sm:ml-auto sm:max-w-xs sm:py-2"
          />
        </div>

        {selected.size > 0 ? (
          <div className="sticky top-[4.25rem] z-20 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-300 bg-slate-50/95 px-3 py-2.5 text-sm shadow-lg backdrop-blur sm:static sm:gap-3 sm:bg-slate-50 sm:px-4 sm:shadow-none">
            <span className="font-medium text-slate-900">
              {selected.size} selected
            </span>
            {hiddenSelected > 0 ? (
              <span className="text-xs text-slate-500">
                ({hiddenSelected} not shown by the current filter)
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={() => setSelectedActive(true)}
              disabled={bulkBusy || deleting}
              className="rounded-lg border border-emerald-400 px-2.5 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Enable
            </button>
            <button
              type="button"
              onClick={() => setSelectedActive(false)}
              disabled={bulkBusy || deleting}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Disable
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={deleting || bulkBusy}
              className="ml-auto rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting ? "Deleting..." : `Delete ${selected.size}`}
            </button>
          </div>
        ) : null}

        {/* Phone: one card per candidate. Nine columns do not fit a phone,
            and a sideways-scrolling table hides the action button off-screen. */}
        <div className="mt-4 sm:hidden">
          {loading ? (
            <p className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
              Loading roster...
            </p>
          ) : visible.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
              {records.length === 0
                ? "No candidates yet. Generate a token above."
                : "No candidates match that filter."}
            </p>
          ) : (
            <>
              <label className="mb-2 flex items-center gap-3 px-1 py-1 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  className="h-5 w-5 cursor-pointer rounded border-slate-300 accent-slate-900"
                />
                Select all {visible.length} shown
              </label>

              <ul className="space-y-2">
                {visible.map((record) => (
                  <li
                    key={record.id}
                    className={`rounded-2xl border bg-white p-3.5 shadow-sm transition ${
                      selected.has(record.id)
                        ? "border-indigo-400 ring-2 ring-indigo-100"
                        : "border-slate-200"
                    } ${record.active ? "" : "opacity-70"}`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${record.name}`}
                        checked={selected.has(record.id)}
                        onChange={() => toggleOne(record.id)}
                        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-slate-300 accent-slate-900"
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setHistoryId(record.id)}
                            className="min-w-0 truncate text-left text-base font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2"
                          >
                            {record.name}
                          </button>
                          <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 font-mono text-sm font-bold tracking-widest text-slate-900">
                            {record.token}
                          </span>
                        </div>

                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
                          <SourceBadge source={record.source} />
                          {record.company ? (
                            <span className="min-w-0 truncate">{record.company}</span>
                          ) : null}
                          {record.phone ? (
                            <a
                              href={`tel:${record.phone}`}
                              className="tabular-nums text-indigo-700"
                            >
                              {record.phone}
                            </a>
                          ) : null}
                        </div>

                        <div className="mt-3 flex items-center gap-2">
                          <StatusPill active={record.active} />
                          <span className="text-xs text-slate-500 tabular-nums">
                            {record.bookingCount} booking
                            {record.bookingCount === 1 ? "" : "s"}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggle(record)}
                            disabled={pendingId === record.id}
                            className={`ml-auto rounded-lg border px-3.5 py-2 text-xs font-semibold transition disabled:opacity-50 ${
                              record.active
                                ? "border-slate-300 text-slate-700 active:bg-slate-100"
                                : "border-emerald-400 text-emerald-700 active:bg-emerald-50"
                            }`}
                          >
                            {pendingId === record.id
                              ? "Saving..."
                              : record.active
                                ? "Disable"
                                : "Enable"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="mt-4 hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:block">
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-slate-900"
                    />
                  </th>
                  <th className="px-4 py-3 font-semibold">Token</th>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Phone</th>
                  <th className="px-4 py-3 font-semibold">Source</th>
                  <th className="px-4 py-3 font-semibold">Company</th>
                  <th className="px-4 py-3 font-semibold">Bookings</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                      Loading roster...
                    </td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                      {records.length === 0
                        ? "No candidates yet. Generate a token above."
                        : "No candidates match that filter."}
                    </td>
                  </tr>
                ) : (
                  visible.map((record) => (
                    <tr
                      key={record.id}
                      className={`border-b border-slate-100 last:border-0 ${
                        record.active ? "" : "bg-slate-50 text-slate-400"
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${record.name}`}
                          checked={selected.has(record.id)}
                          onChange={() => toggleOne(record.id)}
                          className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-slate-900"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-base font-semibold tracking-widest">
                        {record.token}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setHistoryId(record.id)}
                          title="View history"
                          className="rounded text-left font-medium underline decoration-slate-300 underline-offset-2 transition hover:decoration-current"
                        >
                          {record.name}
                        </button>
                      </td>
                      <td className="px-4 py-3">{record.phone ?? "—"}</td>
                      <td className="px-4 py-3">
                        <SourceBadge source={record.source} />
                      </td>
                      <td className="px-4 py-3">{record.company ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {record.bookingCount}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill active={record.active} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => toggle(record)}
                          disabled={pendingId === record.id}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                            record.active
                              ? "border-slate-300 text-slate-700 hover:bg-slate-100"
                              : "border-emerald-400 text-emerald-700 hover:bg-emerald-50"
                          }`}
                        >
                          {pendingId === record.id
                            ? "Saving..."
                            : record.active
                              ? "Disable"
                              : "Enable"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Disabling a token blocks sign-in immediately. Existing bookings stay on
          the schedule -- cancel them from the Schedule view if you want the
          slots back.
        </p>
      </section>

      {historyId ? (
        <CandidateHistory
          candidateId={historyId}
          onClose={() => setHistoryId(null)}
        />
      ) : null}
    </div>
  );
}
