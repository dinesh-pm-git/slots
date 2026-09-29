import { conflictConstraint, isUniqueViolation } from "@/lib/db";
import {
  fail,
  forbidden,
  json,
  readJson,
  readString,
  serverError,
  unauthorized,
} from "@/lib/http";
import {
  deleteCandidates,
  describeCandidates,
  findCandidateByPhoneKey,
  insertCandidate,
  listCandidateRecords,
  listCandidates,
  listPanels,
  setCandidatesActive,
  type PhoneHolder,
} from "@/lib/queries";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import {
  CANDIDATE_PHONE_CONSTRAINT,
  candidatePhoneError,
  phoneKey,
} from "@/lib/phone";
import { getSession, isController } from "@/lib/session";
import { generateToken } from "@/lib/tokens";
import { isCandidateSource } from "@/lib/types";

const MAX_NAME = 120;

/** Keeps a bulk audit sentence readable when someone selects fifty rows. */
const NAMES_IN_SUMMARY = 5;

function summariseNames(names: string[]): string {
  if (names.length <= NAMES_IN_SUMMARY) return names.join(", ");
  const shown = names.slice(0, NAMES_IN_SUMMARY).join(", ");
  return `${shown} and ${names.length - NAMES_IN_SUMMARY} more`;
}
const MAX_COMPANY = 120;

/**
 * The number is already someone's. Says who, so the controller can hand over
 * that token - or re-enable it - instead of creating the person twice.
 */
function phoneTaken(phone: string, holder: PhoneHolder) {
  return json(
    {
      error:
        `${phone} is already registered to ${holder.name} (token ${holder.token})` +
        (holder.active
          ? "."
          : ", which is disabled. Enable that token instead of issuing a new one."),
      existing: holder,
    },
    409,
  );
}

/** Roster for the Candidates page and for booking on a candidate's behalf. */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (!isController(session)) return forbidden();

    const [candidates, records, panels] = await Promise.all([
      listCandidates(),
      listCandidateRecords(),
      listPanels(),
    ]);

    return json({ candidates, records, panels });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * Create a candidate and issue them a token.
 *
 * No panel is chosen here. A candidate can be allocated to a different panel
 * for every booking, so the panel is picked when the slot is booked.
 */
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (!isController(session)) return forbidden();

    const body = await readJson(request);

    const name = readString(body, "name");
    if (!name) return fail("Candidate name is required.", 400);
    if (name.length > MAX_NAME) {
      return fail(`Name must be ${MAX_NAME} characters or fewer.`, 400);
    }

    // The phone number identifies the candidate, so it is required and it is
    // unique. See src/lib/phone.ts for what counts as the same number.
    const phone = readString(body, "phone");
    const phoneProblem = candidatePhoneError(phone);
    if (phoneProblem) return fail(phoneProblem, 400);
    const key = phoneKey(phone) as string;

    const holder = await findCandidateByPhoneKey(key);
    if (holder) return phoneTaken(phone, holder);

    // Absent means Uniq, so an older client still creates a usable record.
    const source = body.source === undefined ? "Uniq" : body.source;
    if (!isCandidateSource(source)) {
      return fail("Source must be Direct or Uniq.", 400);
    }

    // Optional: the company is often not known when the token is issued.
    const company = readString(body, "company");
    if (company.length > MAX_COMPANY) {
      return fail(`Company must be ${MAX_COMPANY} characters or fewer.`, 400);
    }

    // A four-character token has a small keyspace, so a collision is possible
    // rather than merely theoretical. Retry on the unique violation.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const token = generateToken();
      try {
        const id = await insertCandidate({
          token,
          name,
          phone,
          source,
          company: company || null,
        });
        await recordAudit({
          session,
          action: AUDIT_ACTIONS.candidateCreated,
          summary:
            `${session.name} issued token ${token} to ${name} (${source}` +
            (company ? `, ${company}` : "") +
            `).`,
          subjectLabel: `${name} (${token})`,
          details: {
            candidateId: id,
            token,
            name,
            phone,
            source,
            company: company || null,
          },
        });

        return json(
          {
            id,
            token,
            name,
            phone,
            source,
            company: company || null,
          },
          201,
        );
      } catch (error) {
        // Another controller registered the same number between the check
        // above and this insert. The unique index settled it; say who won.
        if (conflictConstraint(error) === CANDIDATE_PHONE_CONSTRAINT) {
          const winner = await findCandidateByPhoneKey(key);
          if (winner) return phoneTaken(phone, winner);
        }
        // Otherwise the only unique column left is the token: draw again.
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }

    return fail(
      "Could not allocate a free token. Disable some unused tokens and try again.",
      503,
    );
  } catch (error) {
    return serverError(error);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DELETE = 200;

/**
 * Permanently delete candidates, and with them every booking they hold.
 *
 * Takes a list so the Candidates page can clear a multi-selection in one
 * round trip, which also makes it all-or-nothing rather than half-applied.
 */
export async function DELETE(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (!isController(session)) return forbidden();

    const body = await readJson(request);
    const raw = body.ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail("Select at least one candidate to delete.", 400);
    }
    if (raw.length > MAX_DELETE) {
      return fail(`Delete at most ${MAX_DELETE} candidates at a time.`, 400);
    }

    const ids = [...new Set(raw)].filter(
      (id): id is string => typeof id === "string" && UUID.test(id),
    );
    if (ids.length !== new Set(raw).size) {
      return fail("One of those candidates is not valid.", 400);
    }

    // Read the names before they are gone, so the log can say who was removed.
    const names = await describeCandidates(ids);

    const result = await deleteCandidates(ids);
    if (result.deleted === 0) return fail("Nothing was deleted.", 404);

    await recordAudit({
      session,
      action: AUDIT_ACTIONS.candidateDeleted,
      summary:
        `${session.name} deleted ${result.deleted} candidate${result.deleted === 1 ? "" : "s"}` +
        (names.length > 0 ? ` (${summariseNames(names)})` : "") +
        (result.bookingsRemoved > 0
          ? `, cancelling ${result.bookingsRemoved} booking${result.bookingsRemoved === 1 ? "" : "s"}.`
          : "."),
      subjectLabel: names.join(", ") || null,
      details: { ids, ...result },
    });

    return json(result);
  } catch (error) {
    return serverError(error);
  }
}

/**
 * Enable or disable several tokens at once, for the Candidates page selection.
 * Reversible, so unlike DELETE it needs no confirmation and touches no bookings.
 */
export async function PATCH(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (!isController(session)) return forbidden();

    const body = await readJson(request);

    if (typeof body.active !== "boolean") {
      return fail("active must be true or false.", 400);
    }

    const raw = body.ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail("Select at least one candidate.", 400);
    }
    if (raw.length > MAX_DELETE) {
      return fail(`Update at most ${MAX_DELETE} candidates at a time.`, 400);
    }

    const unique = new Set(raw);
    const ids = [...unique].filter(
      (id): id is string => typeof id === "string" && UUID.test(id),
    );
    if (ids.length !== unique.size) {
      return fail("One of those candidates is not valid.", 400);
    }

    // Read the names before updating, so the sentence can name them.
    const names = await describeCandidates(ids);

    const updated = await setCandidatesActive(ids, body.active);
    if (updated === 0) return fail("Nothing was updated.", 404);

    await recordAudit({
      session,
      action: body.active
        ? AUDIT_ACTIONS.candidateEnabled
        : AUDIT_ACTIONS.candidateDisabled,
      summary:
        `${session.name} ${body.active ? "enabled" : "disabled"} ` +
        `${updated} token${updated === 1 ? "" : "s"}` +
        (names.length > 0 ? `: ${summariseNames(names)}.` : "."),
      subjectLabel: names.join(", ") || null,
      details: { ids, active: body.active, updated },
    });

    return json({ updated, active: body.active });
  } catch (error) {
    return serverError(error);
  }
}
