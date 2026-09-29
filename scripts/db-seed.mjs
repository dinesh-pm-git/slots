/**
 * Seeds panels, controller accounts, and demo candidates.
 *   npm run db:seed            (skips candidates if any already exist)
 *   npm run db:seed -- --force (adds another batch of demo candidates)
 *
 * Controller accounts are only ever inserted, never updated, so re-running
 * this never resets a password somebody has since changed.
 *
 * Imports the app's own hashing and token helpers via Node's TypeScript
 * stripping, so there is one implementation rather than a copy that can drift.
 */
import postgres from "postgres";

import { hashPassword } from "../src/lib/password.ts";
import { generateToken } from "../src/lib/tokens.ts";

const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL is not set. Create .env.local from .env.example.");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
const sql = postgres(url, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  ssl: isLocal || /sslmode=disable/.test(url) ? false : "require",
});

const PANELS = [
  { id: "CELL1", label: "CELL1", sort_order: 1 },
  { id: "CELL2", label: "CELL2", sort_order: 2 },
  { id: "CELL3", label: "CELL3", sort_order: 3 },
];

const CONTROLLERS = [
  { username: "diviya", name: "Diviya", password: "uniq@123" },
  { username: "dinesh", name: "Dinesh", password: "uniq@123" },
  { username: "manik", name: "Manik", password: "uniq@123" },
  { username: "mukilan", name: "Mukilan", password: "uniq@123" },
  { username: "kanmani", name: "Kanmani", password: "uniq@123" },
  { username: "dyana", name: "Dyana", password: "uniq@123" },
  { username: "mouli", name: "Mouli", password: "uniq@123" },
  { username: "pavithra", name: "Pavithra", password: "uniq@123" },
];

// No panel here: candidates are allocated one per booking, not per token.
const PEOPLE = [
  { name: "Aarav Sharma", phone: "+91 98400 10001" },
  { name: "Priya Nair", phone: "+91 98400 10002" },
  { name: "Rohan Gupta", phone: "+91 98400 10003" },
  { name: "Ananya Iyer", phone: "+91 98400 10004" },
  { name: "Vikram Reddy", phone: "+91 98400 10005" },
  { name: "Meera Krishnan", phone: "+91 98400 10006" },
];

/**
 * Four-character tokens collide occasionally; retry rather than fail. A phone
 * number is one candidate, so a number that is already registered is skipped
 * and null returned.
 */
async function insertWithToken(person) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const token = generateToken();
    try {
      await sql`
        insert into candidates (token, name, phone)
        values (${token}, ${person.name}, ${person.phone})
      `;
      return token;
    } catch (error) {
      if (error.constraint_name === "candidates_phone_unique") return null;
      if (error.code === "23505") continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate a free token for ${person.name}.`);
}

try {
  for (const panel of PANELS) {
    await sql`
      insert into panels (id, label, sort_order)
      values (${panel.id}, ${panel.label}, ${panel.sort_order})
      on conflict (id) do update set label = excluded.label,
                                     sort_order = excluded.sort_order,
                                     active = true
    `;
  }
  console.log(`Panels ready: ${PANELS.map((p) => p.id).join(", ")}`);

  const added = [];
  for (const controller of CONTROLLERS) {
    const rows = await sql`
      insert into controllers (username, name, password_hash)
      values (${controller.username}, ${controller.name},
              ${await hashPassword(controller.password)})
      on conflict (username) do nothing
      returning username
    `;
    if (rows.length > 0) added.push(controller.username);
  }

  const allControllers = await sql`
    select username, name, active from controllers order by username
  `;
  console.log(
    `\nControllers (${added.length} added, ${allControllers.length - added.length} already existed):\n`,
  );
  for (const row of allControllers) {
    const isNew = added.includes(row.username);
    console.log(
      `  ${row.username.padEnd(10)} ${row.name.padEnd(12)} ${isNew ? "password: uniq@123" : "(existing - password unchanged)"}`,
    );
  }

  const existing = await sql`select count(*)::int as count from candidates`;
  const force = process.argv.includes("--force");

  if (existing[0].count > 0 && !force) {
    const rows = await sql`
      select name, token, active from candidates order by name
    `;
    console.log(`\n${rows.length} candidate(s) already seeded:\n`);
    for (const row of rows) {
      console.log(
        `  ${row.token}  ${row.name}${row.active ? "" : "  (disabled)"}`,
      );
    }
    console.log("\nRe-run with -- --force to add another batch.");
  } else {
    const created = [];
    const skipped = [];
    for (const person of PEOPLE) {
      const token = await insertWithToken(person);
      if (token) created.push({ token, ...person });
      else skipped.push(person);
    }
    console.log(`\nSeeded ${created.length} candidates:\n`);
    for (const row of created) {
      console.log(`  ${row.token}  ${row.name}`);
    }
    if (skipped.length > 0) {
      console.log(
        `\nSkipped ${skipped.length} whose phone number is already registered: ` +
          skipped.map((person) => person.name).join(", "),
      );
    }
  }

  console.log(
    "\nControllers sign in with their username. Change these passwords before going live.",
  );
} catch (error) {
  console.error("Seed failed:", error.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
