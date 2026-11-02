-- WS3 (remediation 2026-11) G5 — current / non-current classification of balance-sheet
-- accounts. Additive: one nullable column (NULL = not classified, reported as such by the
-- balance sheet and the ratios — never guessed). Seeded ONLY for accounts the system owns:
-- the standard chart's system accounts, the fixed-asset header and the accounts the asset
-- register controls (non-current), and the GL accounts behind cash boxes and banks
-- (current). Every other account stays unclassified until the accountant sets it.

ALTER TABLE "Account" ADD COLUMN "liquidity" TEXT;
ALTER TABLE "Account" ADD CONSTRAINT "Account_liquidity_known" CHECK (
  "liquidity" IS NULL OR ("liquidity" IN ('current', 'non_current') AND "type" IN ('asset', 'liability'))
);

UPDATE "Account" SET "liquidity" = 'current'
WHERE "liquidity" IS NULL AND "systemKey" IN ('cash', 'bank', 'ar', 'inventory', 'vat_input', 'employee_advances', 'ap', 'grni', 'vat_output', 'employee_payable', 'vat_payable');

UPDATE "Account" SET "liquidity" = 'current'
WHERE "liquidity" IS NULL AND "id" IN (SELECT "accountId" FROM "CashAccount") AND "type" = 'asset';

UPDATE "Account" SET "liquidity" = 'non_current'
WHERE "liquidity" IS NULL AND "type" = 'asset' AND ("id" = 'acc_1700' OR "controlledBy" = 'fixed_assets');
