import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { annualTaxOf } from "@/lib/hr/payroll-engine";

// Brackets in the shape of Law 7/2024's first bands (0% to 40,000, 10% to 55,000, …); the
// values a rule set carries are entered and verified by the accountant, never by code.
const base = { period_method: "annualised_monthly" as const, annual_exemption: 20000, brackets: [{ up_to: 40000, rate: 0 }, { up_to: 55000, rate: 10 }, { up_to: null, rate: 15 }], rounding: { mode: "half_up", to: 0.01 } } as never;

test("PAY-01: with annual_income_round_down_to = 10 the annual income is rounded down to the lower 10 EGP before the brackets", () => {
  const p = { ...(base as object), annual_income_round_down_to: 10 } as never;
  assert.equal(annualTaxOf(new Prisma.Decimal("40019.99"), p).toString(), "1", "40,019.99 → 40,010 → 10 × 10% = 1");
  assert.equal(annualTaxOf(new Prisma.Decimal("40010"), p).toString(), "1");
});

test("PAY-01: without the parameter the behaviour is unchanged (no rounding)", () => {
  assert.equal(annualTaxOf(new Prisma.Decimal("40019.99"), base).toFixed(3), "1.999");
});
