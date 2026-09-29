import {
  fail,
  forbidden,
  json,
  serverError,
  unauthorized,
} from "@/lib/http";
import { buildReport, resolveReportRange } from "@/lib/reports";
import { getSession, isController } from "@/lib/session";

/** The Reports page for a range of dates. Controller only. */
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (!isController(session)) return forbidden();

    const range = await resolveReportRange(new URL(request.url).searchParams);
    if ("error" in range) return fail(range.error, 400);

    // The session list is for the download; the page only needs the totals.
    const { report } = await buildReport(range.from, range.to);
    return json(report);
  } catch (error) {
    return serverError(error);
  }
}
