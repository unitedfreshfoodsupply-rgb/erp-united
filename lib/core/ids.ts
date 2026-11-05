import { randomBytes } from "crypto";

/**
 * A row id made in the application, for inserts that write many linked rows at once (createMany
 * returns no ids, and nothing guarantees the order of a RETURNING). Same shape as the cuid()
 * Prisma gives a single create — 25 characters, "c" + time + counter + randomness, all base36 —
 * so ids made either way sort and look alike. Unique by construction within a process (the
 * counter) and by 64 random bits across processes.
 */
let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1_679_616; // 36^4
  const time = Date.now().toString(36).padStart(8, "0").slice(-8);
  const seq = counter.toString(36).padStart(4, "0");
  const rand = BigInt(`0x${randomBytes(8).toString("hex")}`).toString(36).padStart(12, "0").slice(-12);
  return `c${time}${seq}${rand}`;
}
