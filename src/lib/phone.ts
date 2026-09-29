/**
 * A candidate's phone number is who they are: one person, one record.
 *
 * The number is stored as it was typed, for display. Its key is what makes two
 * spellings of it the same number: only the digits count, and a leading 91 or
 * 0 in front of a ten-digit Indian number is dropped, so "+91 98400 10001",
 * "098400 10001" and "9840010001" are all 9840010001.
 *
 * db/schema.sql computes the same key as candidates.phone_key, and the unique
 * index on that column is what actually enforces it - two controllers issuing
 * a token for the same number at once cannot both succeed. This copy exists so
 * the API can name who already holds a number before it tries the insert.
 * Change one and the other must change with it.
 */

export const MAX_CANDIDATE_PHONE = 32;

/** The index that keeps one candidate per phone number. */
export const CANDIDATE_PHONE_CONSTRAINT = "candidates_phone_unique";

/** The number reduced to what identifies it, or null when it has no digits. */
export function phoneKey(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  return digits.replace(/^(?:0091|91|0)(\d{10})$/, "$1");
}

/** Why a candidate's number is unacceptable, or null when it is fine. */
export function candidatePhoneError(phone: string): string | null {
  if (!phone) return "Phone number is required.";
  if (phone.length > MAX_CANDIDATE_PHONE) {
    return `Phone number must be ${MAX_CANDIDATE_PHONE} characters or fewer.`;
  }
  if (!/^[0-9+()\-\s]+$/.test(phone)) {
    return "Enter a valid phone number.";
  }

  // Ten digits is a mobile or a landline with its area code; fifteen is the
  // longest number with a country code. Anything shorter cannot identify
  // anyone, and a number that identifies no one cannot be kept unique.
  const key = phoneKey(phone) ?? "";
  if (key.length < 10 || key.length > 15) {
    return "Enter the full phone number: 10 digits, or with the country code.";
  }

  return null;
}
