/**
 * Which company names are the same company, written differently.
 *
 * The booking form takes the company as free text, so one employer arrives as
 * "SRM Technologies", "SRM tech" and "Srm tech", or with a slip of the keys as
 * "virtuval tech guru" for "Virtual Tech Gurus". Reports group them so a
 * company is one line, not four.
 *
 * Three rules, applied in order and deliberately cautious - two companies
 * wrongly merged is a worse report than one company split in two, and the
 * page lists the spellings it merged so a wrong merge is visible:
 *
 *   1. Case, spacing and punctuation never count, and neither do generic
 *      words at the end ("Limited", "Technologies", "Software"...), so
 *      "Aptagrim Limited" is "Aptagrim" and "Trace software" is "Trace".
 *   2. Small spelling slips count as the same name, scaled to the length: a
 *      five-letter name may differ by one changed letter (Sekal / Sekel) but
 *      not by an added one (Mobis / Mobius are two companies); a longer name
 *      may be a couple of letters out, provided it still starts the same way.
 *   3. A name that is the start of exactly one longer name joins it -
 *      "Bounteous" and "Bounteous x Accolite" - but a name that starts two
 *      different companies ("Virtual" alone) joins neither.
 *
 * Pure functions, no database: this runs over the names already fetched.
 */

/** Trailing words that describe a company rather than name it. */
const GENERIC_ENDINGS = new Set([
  "limited",
  "ltd",
  "private",
  "pvt",
  "inc",
  "llp",
  "llc",
  "corp",
  "corporation",
  "company",
  "co",
  "india",
  "technologies",
  "technology",
  "tech",
  "software",
  "softwares",
  "solutions",
  "solution",
  "systems",
  "services",
  "labs",
  "lab",
  "infotech",
  "info",
  "digital",
  "global",
  "connect",
  "consulting",
  "ai",
]);

/** The words that name the company: "SRM Technologies Pvt Ltd" -> ["srm"]. */
export function companyWords(name: string): string[] {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // Keep at least one word, and at least three letters: "ID Software" is
  // "id software", not "id".
  while (
    words.length > 1 &&
    GENERIC_ENDINGS.has(words[words.length - 1]) &&
    words.slice(0, -1).join("").length >= 3
  ) {
    words.pop();
  }
  return words;
}

/** The squashed name two spellings are compared by. */
export function companyKey(name: string): string {
  // A name with no Latin letters or digits falls back to itself, lowercased,
  // rather than to an empty key that would lump such names together.
  return companyWords(name).join("") || name.trim().toLowerCase();
}

/** Edits to turn one into the other, a swap of neighbours counting as one. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Jaro-Winkler similarity, 0 to 1. It rewards a shared beginning, which is
 * where names that are the same company agree: typos land in the middle.
 */
function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const end = Math.min(b.length - 1, i + window);
    for (let j = Math.max(0, i - window); j <= end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let outOfOrder = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) outOfOrder += 1;
    k += 1;
  }
  const transpositions = outOfOrder / 2;

  const jaro =
    (matches / a.length +
      matches / b.length +
      (matches - transpositions) / matches) /
    3;

  let prefix = 0;
  while (prefix < 4 && a[prefix] !== undefined && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Rule 2: are two keys the same name, give or take a slip? */
export function similarKeys(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);

  // Four letters or fewer is too little to tell a typo from another company.
  if (shorter < 5) return false;

  // Five letters: one letter changed, nothing added or dropped, and the
  // first two agree. Sekal / Sekel, but not Mobis / Mobius.
  if (shorter === 5) {
    if (a.length !== b.length || a.slice(0, 2) !== b.slice(0, 2)) return false;
    let differences = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differences += 1;
    return differences === 1;
  }

  const allowed = longer > 10 ? 3 : 2;
  return editDistance(a, b) <= allowed && jaroWinkler(a, b) >= 0.9;
}

export type CompanyGroups = {
  /** A stable id for the company a spelling belongs to. */
  idOf: (name: string) => string;
  /** The spelling a company is shown under. */
  nameOf: (id: string) => string;
  /** Its other spellings, most used first. */
  aliasesOf: (id: string) => string[];
  /**
   * Every distinct spelling (capitals and spacing folded), how often it was
   * used, and the company it belongs to.
   */
  forms: () => { name: string; uses: number; id: string }[];
  /** How often a company was used, all its spellings together. */
  usesOf: (id: string) => number;
};

/** A spelling and how many bookings used it. */
export type Spelling = { name: string; uses: number };

/**
 * Groups every spelling in `names` - one entry per use, so how often each
 * spelling is used decides which one a company is shown under: the most
 * used, and on a tie the one in capitals, then the earliest.
 */
export function groupCompanies(names: string[]): CompanyGroups {
  const uses = new Map<string, number>();
  for (const raw of names) {
    const name = raw.trim();
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return groupUses(uses);
}

/** The same, from spellings already counted, in first-used order. */
export function groupSpellings(spellings: Spelling[]): CompanyGroups {
  const uses = new Map<string, number>();
  for (const spelling of spellings) {
    const name = spelling.name.trim();
    uses.set(name, (uses.get(name) ?? 0) + spelling.uses);
  }
  return groupUses(uses);
}

function groupUses(uses: Map<string, number>): CompanyGroups {

  const keys = [...new Set([...uses.keys()].map(companyKey))];
  const parent = new Map(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    // A name that was not in the list is a company of its own.
    if (!parent.has(key)) return key;
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(key, root);
    return root;
  };
  const join = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  // Rule 2.
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (similarKeys(keys[i], keys[j])) join(keys[i], keys[j]);
    }
  }

  // Rule 3, on whole words and only when it points one way.
  const wordsOf = new Map<string, string[]>();
  for (const name of uses.keys()) wordsOf.set(companyKey(name), companyWords(name));
  for (const short of keys) {
    const shortWords = wordsOf.get(short) ?? [];
    if (short.length < 4 || shortWords.length === 0) continue;
    const targets = new Set<string>();
    for (const long of keys) {
      const longWords = wordsOf.get(long) ?? [];
      if (
        longWords.length > shortWords.length &&
        shortWords.every((word, index) => longWords[index] === word)
      ) {
        targets.add(find(long));
      }
    }
    if (targets.size === 1) join(short, [...targets][0]);
  }

  // Spellings that differ only in capitals or spacing are one form, counted
  // together and written the way it was written most - "TCS" over "tcs".
  const order = [...uses.keys()];
  const firstSeen = (name: string) => order.indexOf(name);
  const capital = (name: string) => (/^[A-Z0-9]/.test(name) ? 1 : 0);
  const best = (a: { uses: number; name: string }, b: { uses: number; name: string }) =>
    b.uses - a.uses ||
    capital(b.name) - capital(a.name) ||
    firstSeen(a.name) - firstSeen(b.name);

  type Form = { name: string; uses: number; variants: { name: string; uses: number }[] };
  const forms = new Map<string, Form>();
  for (const name of order) {
    const form = name.toLowerCase().replace(/\s+/g, " ");
    const entry = forms.get(form) ?? { name, uses: 0, variants: [] };
    entry.uses += uses.get(name) ?? 0;
    entry.variants.push({ name, uses: uses.get(name) ?? 0 });
    forms.set(form, entry);
  }

  // Each company's forms, most used first, each under its best-written variant.
  const byCompany = new Map<string, Form[]>();
  for (const form of forms.values()) {
    form.variants.sort(best);
    form.name = form.variants[0].name;
    const id = find(companyKey(form.name));
    const list = byCompany.get(id) ?? [];
    list.push(form);
    byCompany.set(id, list);
  }
  for (const list of byCompany.values()) list.sort(best);

  return {
    idOf: (name) => find(companyKey(name.trim())),
    nameOf: (id) => byCompany.get(id)?.[0].name ?? id,
    aliasesOf: (id) => byCompany.get(id)?.slice(1).map((form) => form.name) ?? [],
    forms: () =>
      [...forms.values()].map((form) => ({
        name: form.name,
        uses: form.uses,
        id: find(companyKey(form.name)),
      })),
    usesOf: (id) =>
      (byCompany.get(id) ?? []).reduce((sum, form) => sum + form.uses, 0),
  };
}

/** Lowercase letters and digits only: "LTI Mindtree" -> "ltimindtree". */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The shortest a name may be and still be offered: "c" and "dd" are noise. */
const MIN_SUGGESTED_LENGTH = 3;

/**
 * The one company worth offering for what has been typed so far, or null.
 *
 * Nothing until two letters are in. Then, best first:
 *   - a known name that starts with what was typed ("Mov" -> "Movate");
 *   - one with a later word that does ("mind" -> "LTI Mindtree");
 *   - from four letters, one that starts almost like it, a letter out
 *     ("virtuv" -> "Virtual Tech Gurus").
 * Within each, the company used most wins.
 *
 * What is offered is always the company's own name - the one Reports shows
 * it under - never the spelling that happened to match. Offering the match
 * would hand a slip straight back: "virtuv" is the start of the typo
 * "virtuval tech guru", and the point is to arrive at "Virtual Tech Gurus".
 * For the same reason a known misspelling typed out in full is offered the
 * company's name, while the company's name typed in full gets nothing,
 * apart from fixing its capitals ("tcs" -> "TCS").
 */
export function suggestCompany(
  typed: string,
  spellings: Spelling[],
): string | null {
  const text = typed.trim();
  const query = squash(text);
  if (query.length < 2) return null;

  const groups = groupSpellings(spellings);
  const forms = groups
    .forms()
    .filter((form) => squash(form.name).length >= MIN_SUGGESTED_LENGTH);

  const offer = (id: string) => {
    const name = groups.nameOf(id);
    return name === text ? null : name;
  };

  const typedForm = text.toLowerCase().replace(/\s+/g, " ");
  const exact = forms.find(
    (form) => form.name.toLowerCase().replace(/\s+/g, " ") === typedForm,
  );
  if (exact) return offer(exact.id);

  const startsWith = (form: { name: string }) => squash(form.name).startsWith(query);
  const laterWordStartsWith = (form: { name: string }) => {
    const words = form.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return words.slice(1).some((_, index) =>
      words.slice(index + 1).join("").startsWith(query),
    );
  };
  const startsAlmostWith = (form: { name: string }) => {
    if (query.length < 4) return false;
    const name = squash(form.name);
    // A letter added, dropped or changed somewhere in the typing.
    return [query.length - 1, query.length, query.length + 1].some(
      (length) => length > 0 && editDistance(query, name.slice(0, length)) <= 1,
    );
  };

  for (const fits of [startsWith, laterWordStartsWith, startsAlmostWith]) {
    const found = forms.filter(fits);
    if (found.length === 0) continue;
    // Most used company first; on a tie, one whose own name fits the typing.
    found.sort(
      (a, b) =>
        groups.usesOf(b.id) - groups.usesOf(a.id) ||
        Number(fits({ name: groups.nameOf(b.id) })) -
          Number(fits({ name: groups.nameOf(a.id) })),
    );
    return offer(found[0].id);
  }
  return null;
}
