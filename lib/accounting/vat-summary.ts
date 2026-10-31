import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { isValidISODate } from "@/lib/dates";
import { D } from "@/lib/inventory/decimal";

export type VatSourceTotals = { outputBase: string; outputTax: string; inputBase: string; inputTax: string };
export type VatLedgerTotals = { outputDebit: string; outputCredit: string; inputDebit: string; inputCredit: string };

export function summarizeVatRows(rows: { taxCode: string; rate: string | Prisma.Decimal; outputBase: string | Prisma.Decimal; outputTax: string | Prisma.Decimal; inputBase: string | Prisma.Decimal; inputTax: string | Prisma.Decimal }[], ledger: VatLedgerTotals) {
  const byCode = new Map<string, { taxCode: string; rate: string; outputBase: Prisma.Decimal; outputTax: Prisma.Decimal; inputBase: Prisma.Decimal; inputTax: Prisma.Decimal }>();
  for (const row of rows) {
    const key = `${row.taxCode}|${String(row.rate)}`;
    const current = byCode.get(key) ?? { taxCode: row.taxCode, rate: String(row.rate), outputBase: D(0), outputTax: D(0), inputBase: D(0), inputTax: D(0) };
    current.outputBase = current.outputBase.plus(row.outputBase);
    current.outputTax = current.outputTax.plus(row.outputTax);
    current.inputBase = current.inputBase.plus(row.inputBase);
    current.inputTax = current.inputTax.plus(row.inputTax);
    byCode.set(key, current);
  }
  const lines = [...byCode.values()].sort((a, b) => a.taxCode.localeCompare(b.taxCode) || a.rate.localeCompare(b.rate)).map((row) => ({
    taxCode: row.taxCode, rate: row.rate, outputBase: row.outputBase.toFixed(2), outputTax: row.outputTax.toFixed(2), inputBase: row.inputBase.toFixed(2), inputTax: row.inputTax.toFixed(2),
  }));
  const sum = (key: "outputBase" | "outputTax" | "inputBase" | "inputTax") => lines.reduce((total, line) => total.plus(line[key]), D(0));
  const outputTax = sum("outputTax");
  const inputTax = sum("inputTax");
  const glOutput = D(ledger.outputCredit).minus(ledger.outputDebit);
  const glInput = D(ledger.inputDebit).minus(ledger.inputCredit);
  const outputDiff = outputTax.minus(glOutput);
  const inputDiff = inputTax.minus(glInput);
  return {
    lines,
    totals: { outputBase: sum("outputBase").toFixed(2), outputTax: outputTax.toFixed(2), inputBase: sum("inputBase").toFixed(2), inputTax: inputTax.toFixed(2), netPayable: outputTax.minus(inputTax).toFixed(2) },
    ledger: { outputDebit: D(ledger.outputDebit).toFixed(2), outputCredit: D(ledger.outputCredit).toFixed(2), outputExpectedCredit: outputTax.toFixed(2), outputDifference: outputDiff.toFixed(2), inputDebit: D(ledger.inputDebit).toFixed(2), inputCredit: D(ledger.inputCredit).toFixed(2), inputExpectedDebit: inputTax.toFixed(2), inputDifference: inputDiff.toFixed(2), reconciled: outputDiff.isZero() && inputDiff.isZero() },
  };
}

export async function vatSummary(from: string, to: string) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ApiError(400, "فترة ملخص الضريبة غير صالحة");
  const rows = await prisma.$queryRaw<{ taxCode: string; rate: Prisma.Decimal; outputBase: Prisma.Decimal; outputTax: Prisma.Decimal; inputBase: Prisma.Decimal; inputTax: Prisma.Decimal }[]>`
    SELECT d."taxCode", d."rate",
      coalesce(sum(d."outputBase"), 0) AS "outputBase",
      coalesce(sum(d."outputTax"), 0) AS "outputTax",
      coalesce(sum(d."inputBase"), 0) AS "inputBase",
      coalesce(sum(d."inputTax"), 0) AS "inputTax"
    FROM (
      SELECT l."taxCode", l."taxRate" AS "rate", l."net" AS "outputBase", l."tax" AS "outputTax", 0::numeric AS "inputBase", 0::numeric AS "inputTax"
      FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId"
      WHERE i."status" = 'issued' AND i."issueDate" >= ${from} AND i."issueDate" <= ${to}
      UNION ALL
      SELECT il."taxCode", il."taxRate", -l."net", -l."tax", 0::numeric, 0::numeric
      FROM "CreditNoteLine" l JOIN "CreditNote" n ON n."id" = l."creditNoteId" JOIN "SalesInvoiceLine" il ON il."id" = l."invoiceLineId"
      WHERE n."issueDate" >= ${from} AND n."issueDate" <= ${to}
      UNION ALL
      SELECT l."taxCode", l."taxRate", 0::numeric, 0::numeric, l."net", l."tax"
      FROM "SupplierBillLine" l JOIN "SupplierBill" b ON b."id" = l."billId"
      WHERE b."status" = 'posted' AND b."billDate" >= ${from} AND b."billDate" <= ${to}
      UNION ALL
      SELECT bl."taxCode", bl."taxRate", 0::numeric, 0::numeric, -l."net", -l."tax"
      FROM "DebitNoteLine" l JOIN "DebitNote" n ON n."id" = l."debitNoteId" JOIN "SupplierBillLine" bl ON bl."id" = l."billLineId"
      WHERE n."issueDate" >= ${from} AND n."issueDate" <= ${to}
      UNION ALL
      SELECT l."taxCode", l."taxRate", 0::numeric, 0::numeric, l."net", l."tax"
      FROM "SupplierBillServiceLine" l JOIN "SupplierBill" b ON b."id" = l."billId"
      WHERE b."status" = 'posted' AND b."billDate" >= ${from} AND b."billDate" <= ${to}
      UNION ALL
      SELECT ev."taxCode", ev."taxRate", ev."proceeds", ev."tax", 0::numeric, 0::numeric
      FROM "AssetEvent" ev
      WHERE ev."type" = 'disposal' AND ev."taxCode" IS NOT NULL AND ev."date" >= ${from} AND ev."date" <= ${to}      UNION ALL
      SELECT sl."taxCode", sl."taxRate", 0::numeric, 0::numeric, -l."net", -l."tax"
      FROM "DebitNoteServiceLine" l JOIN "DebitNote" n ON n."id" = l."debitNoteId" JOIN "SupplierBillServiceLine" sl ON sl."id" = l."serviceLineId"
      WHERE n."issueDate" >= ${from} AND n."issueDate" <= ${to}
    ) d
    GROUP BY d."taxCode", d."rate"
    ORDER BY d."taxCode", d."rate"`;
  const ledgerRows = await prisma.$queryRaw<{ systemKey: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
    SELECT a."systemKey", coalesce(sum(l."debit"), 0) AS debit, coalesce(sum(l."credit"), 0) AS credit
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE a."systemKey" IN ('vat_input', 'vat_output') AND e."date" >= ${from} AND e."date" <= ${to} AND e."sourceType" <> 'vat_settlement'
    GROUP BY a."systemKey"`;
  const byKey = new Map(ledgerRows.map((row) => [row.systemKey, row]));
  const zero = new Prisma.Decimal(0);
  const summary = summarizeVatRows(rows, {
    outputDebit: (byKey.get("vat_output")?.debit ?? zero).toString(), outputCredit: (byKey.get("vat_output")?.credit ?? zero).toString(),
    inputDebit: (byKey.get("vat_input")?.debit ?? zero).toString(), inputCredit: (byKey.get("vat_input")?.credit ?? zero).toString(),
  });
  const codes = [...new Set(rows.map((r) => r.taxCode))];
  const taxRates = await prisma.taxRate.findMany({ where: { code: { in: codes } }, select: { code: true, name: true, nameAr: true, rate: true } });
  const names = new Map(taxRates.map((t) => [t.code, t]));
  return {
    from, to, ...summary,
    lines: summary.lines.map((line) => ({ ...line, taxName: names.get(line.taxCode)?.nameAr ?? line.taxCode, taxNameEn: names.get(line.taxCode)?.name ?? line.taxCode })),
  };
}
