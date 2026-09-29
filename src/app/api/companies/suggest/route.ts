import { suggestCompany, type Spelling } from "@/lib/company-match";
import { sql } from "@/lib/db";
import { json, serverError, unauthorized } from "@/lib/http";
import { getSession } from "@/lib/session";

/**
 * One company name to offer while the booking form's Company field is typed
 * in - `{ suggestion: string | null }`.
 *
 * Open to candidates as well as controllers, since candidates do most of the
 * booking and most of the typos. It answers with a single name, only once two
 * letters are in, and never with the list: the schedule does not show a
 * candidate who else is booked or with whom, and this should not either.
 *
 * Names come from sessions still on the books. A name only ever used on
 * cancelled bookings is as likely to be a test or a slip as a company.
 */
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const typed = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 120);
    if (typed.replace(/[^a-z0-9]/gi, "").length < 2) {
      return json({ suggestion: null });
    }

    // First-used order, which breaks ties between equally used spellings.
    const spellings = await sql<Spelling[]>`
      select btrim(company_name) as name, count(*)::int as uses
        from bookings
       where status = 'booked'
       group by btrim(company_name)
       order by min(created_at)
    `;

    return json({ suggestion: suggestCompany(typed, spellings) });
  } catch (error) {
    return serverError(error);
  }
}
