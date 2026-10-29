/* Signing in with the account's email instead of the username (migration 20261030120000):
   the email is optional, unique and stored lower-case; the username keeps working; a wrong
   password or an unknown email is refused like any failed login. */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { call, makeChecker } from "./_harness";
import { assertTestDatabase } from "./_guard";

const { check, section, finish } = makeChecker();

async function main() {
  assertTestDatabase();
  const db = new PrismaClient();
  const tag = `zzmail${Date.now() % 1_000_000_000}`;
  const email = `${tag}@example.com`;
  const password = `pw-${tag}-Ok`;
  await db.user.create({ data: { name: tag, username: tag, email, passwordHash: await bcrypt.hash(password, 10), role: "SUPER_ADMIN" } });

  section("1. EMAIL OR USERNAME");
  const byEmail = await call(`${tag}-e`, "POST", "/api/auth/login", { username: email, password });
  check("signs in with the email", byEmail.status === 200, [byEmail.status, byEmail.body?.error]);
  check("…as the same administrator", byEmail.body?.user?.role === "SUPER_ADMIN" && byEmail.body?.user?.username === tag, byEmail.body?.user);
  check("the email is matched without regard to case", (await call(`${tag}-E`, "POST", "/api/auth/login", { username: email.toUpperCase(), password })).status === 200);
  check("the username still works", (await call(`${tag}-u`, "POST", "/api/auth/login", { username: tag, password })).status === 200);
  check("a signed-in administrator reaches the admin overview", (await call(`${tag}-e`, "GET", "/api/admin/overview")).status === 200);

  section("2. REFUSALS");
  check("wrong password by email → 401", (await call(`${tag}-x`, "POST", "/api/auth/login", { username: email, password: "wrong-password" })).status === 401);
  check("unknown email → 401", (await call(`${tag}-y`, "POST", "/api/auth/login", { username: `nobody-${email}`, password })).status === 401);
  let dup = false;
  try { await db.user.create({ data: { name: "dup", username: `${tag}d`, email, passwordHash: "x", role: "PREPARER" } }); } catch { dup = true; }
  check("one email is one account (unique)", dup);
  let upper = false;
  try { await db.user.create({ data: { name: "up", username: `${tag}u`, email: email.toUpperCase(), passwordHash: "x", role: "PREPARER" } }); } catch { upper = true; }
  check("emails are stored lower-case (constraint)", upper);

  await db.user.deleteMany({ where: { username: { startsWith: tag } } });
  await db.$disconnect();
  finish("LOGIN BY EMAIL");
}

main().catch((e) => { console.error(e); process.exit(1); });
