# Phased opening migration (November 2026)

UNITED goes live before the complete legacy trial balance at the cut-off is known. The opening position therefore goes in through the steps below, in the order the figures become known:

1. Supplier balances.
2. Customer balances.
3. Everything else: cash, banks, stock, fixed assets, loans, capital, and opening-balance equity 3300.
4. Reconciliation of the complete position.
5. Formal closure, approved by a second person.

The earlier one-batch opening (`kind = initial`) needed all of it at once, so its debits had to equal its credits. Supplier lines alone were refused as "unbalanced" ([supplier reconciliation, §6](../../../UNITED_AUDIT_20261102/maturity/supplier-opening-2026-10/final-20261104/SUPPLIER_OPENING_FINAL_RECONCILIATION_2026-11-04.md)). The two modes exclude each other:
- once the phased migration has started, no initial batch can be created;
- a database with an initial batch cannot start a phased migration.

## 1. Accounting treatment

| Account | Role |
|---|---|
| **3900 Opening balance clearing (provisional)**, `systemKey = opening_clearing`, equity under 3000 (new, migration `20261104140000_phased_opening_migration`) | The other side of every phase batch. Temporary: it must be **zero** before the migration can close. Moved by opening batches only, enforced twice: in the application (`CONTROL_ACCOUNTS`, so manual journals and service bills refuse it) and by the trigger `JournalLine_opening_clearing` (only `opening_batch` and `opening_balance` entries may post to it) |
| 3300 Opening balance equity | Unchanged. It still holds the opening stock posted directly before batches existed (ADJ-2026-00001, 418,281.23). An `equity_transfer` line moves its balance into 3900 so it takes part in the reconciliation; the original entry is never reversed or edited |
| 2100 AP / 1300 AR | Each party balance is a `PartyOpeningBalance` document. It appears in the party's statement and aging at once, with a journal entry against 3900 |

Entries posted on the cut-off date when a phase batch is approved:

| Segment / line | Entry |
|---|---|
| Supplier, positive (we owe) | Dr 3900 / Cr 2100 (party = supplier) |
| Customer, positive (they owe) | Dr 1300 (party = customer) / Cr 3900 |
| GL line (cash, bank, loans, capital…) | the line, against 3900 (one entry per batch, `sourceId = <batch>:gl`) |
| Stock | through the stock ledger at cost (Dr 1400 / Cr 3300, as always), then Dr 3300 / Cr 3900 for exactly what that valuation put on 3300 (`<batch>:stock`); 3300 is left as it was |
| Fixed assets | Dr cost / Cr accumulated depreciation, against 3900 (`<batch>:assets`) |
| `equity_transfer` | Dr/Cr 3300 for its whole balance, against 3900 (`<batch>:equity`); the amount must zero 3300 and is re-checked when the batch is approved |

Nothing invents a balance. A phase batch need not balance by itself: whatever its lines leave is its movement on 3900, and the control center traces that movement back to the batch.

When the legacy trial balance is complete and entered, 3900 returns to zero. A balance left in 3900 means opening figures are still missing, or were counted twice.

## 2. Controls

- **Maker-checker.** A phase batch is approved through the existing approval engine (`accounting.opening_batch`, permission `accounting.opening.approve`). Its preparer and its submitter cannot approve it, and approval posts it once (status, locks, DB guards).
- **Idempotency.** Batch creation takes an idempotency key. A source row (`file · row`) posts once across the whole migration, whether it comes twice in one sheet, from a repeated import, or from another batch. Importing the same sheet again changes nothing.
- **Source evidence.** Every line keeps `source_file`, `source_row`, `source_name` and `source_amount`. The batch keeps the file name and its SHA-256.
- **Identity.** A sheet row is matched by its ERP code only (the canonical customer or supplier record). The name in the sheet is evidence, never identity. A supplier sheet can be restricted to one category, so a vegetable sheet never matches a fruit supplier.
- **Exception register (`OpeningException`).** Every row that is not posted is kept with its evidence until it is decided as `resolved` or `excluded`, always with a reason. Reasons: no ERP record, another category, the same party twice, already in another batch, needs a decision. Exceptions are never deleted (DB guard).
- **Audit.** Every step is in the audit log: start, batch created, lines added, rows imported, submitted, posted, exception recorded or decided, confirmation, closure requested, withdrawn, rejected or closed.

## 3. Statuses and the control center

Accounting → Opening balances → Opening migration control center:
- each segment by stage: imported (draft), pending approval, approved and posted (one step);
- posted totals and the clearing account traced batch by batch (anything left untraced must be zero);
- opening equity 3300;
- open exceptions and unmatched rows;
- pending approvals;
- the closure checks and the people's confirmations;
- CSV export of the opening position, by account and by party.

| Status | When |
|---|---|
| In Progress | nothing posted yet, or a batch is still being prepared |
| Awaiting Approval | a phase batch or the closure request is waiting for a second person |
| Reconciliation Required | everything is posted and a closure check fails |
| Ready for Final Closure | everything is posted and every check passes |
| Closed | closure approved; permanent (DB guard). From then on, changes go only through an approved correction batch |

## 4. Final closure

Closure can be requested only when every check passes, and the checks run again inside the approval:
- no batch left in draft or pending;
- supplier sub-ledger equals 2100, in total and per supplier;
- customer sub-ledger equals 1300, in total and per customer;
- inventory valuation equals 1400;
- the fixed-asset register equals its accounts;
- the trial balance balances;
- every movement on 3900 traces to a migration batch, and 3900 is zero;
- 3300 is zero;
- every exception is decided;
- four people's confirmations: suppliers complete, customers complete, cash and banks verified against the count and the statements, and the other accounts agree with the legacy trial balance;
- a second person exists, and the requester cannot approve.

The closure stores its evidence: the checks, the batches and their movements, who approved it, and when.

**Provisional reporting.** The trial balance, balance sheet, P&L and comparative statements return `opening: { final, state, cutoverDate, clearing }`. The screens show a banner while `final` is false, so no report presents a provisional opening as final. The cut-over readiness report treats the migration as complete only when it is closed and 3900 is zero.

## 5. Decisions for the accountant / owner (not taken by the system)

| # | Decision | Default in the code | Evidence |
|---|---|---|---|
| AD-1 | Classification of 3900 as equity, under 3000 beside 3300 (cash-flow: financing) | equity, provisional, must be zero at closure | standard "opening balance equity / suspense" treatment; change before go-live if the accountant prefers another class (the account is not used yet) |
| AD-2 (G-5/G-6) | Use `equity_transfer` to bring the directly posted opening stock (3300, −418,281.23) into the reconciliation | not posted in production; rehearsed on a copy (3300 → 0, 3900 credited 418,281.23) | rehearsal evidence below |
| AD-3 | The 40 exception rows (15 candidates, 25 unmatched), and `زمامات` (excluded as a net figure) | open in the register; nothing is posted for them | `supplier_opening_exceptions.csv` |
| AD-4 | Column D, 47,177.00: before or after the cut-off | an open "needs decision" exception | reconciliation §5 |
| AD-5 | Row 4 `سعيد نور`: 160,020.00 or 160,200.00 | open; not posted | reconciliation §5 |
| AD-6 | The legacy trial balance at 31 Oct 2026 (cash, banks, capital…) for the "other" segment | none entered; 3900 stays non-zero until it is | — |

## 6. Rehearsal on a copy of production (4 Nov 2026, local)

Database `united_phase_rehearsal`: the production rehearsal copy plus this release's three migrations. Script and output: `UNITED_AUDIT_20261102/maturity/phased-opening-20261104/rehearsal.ts`, `rehearsal.json`.

| Step | Result |
|---|---|
| Identity re-check of the 14 verified rows | id **and** code equal in the copy; all vegetable |
| Import preview, commit, repeat | 14 rows, 4,260,486.80. 11 matched, 3 zero. The repeat changed nothing (11 already in) |
| Exception register | 42 recorded: 25 no match, 15 candidates, column D, `زمامات`. `زمامات` was excluded with its reason; 41 are open, 11,667,096.00 (= 11,619,919.00 + 47,177.00) |
| Validation | no problems; debit = credit = 4,260,486.80, of which 4,260,486.80 on 3900 |
| Maker-checker | self-approval refused (403); posted by the second user |
| Sub-ledger ↔ GL | 11 of 11 suppliers equal; total 4,260,486.80. Integrity: trial balance, AP, AR, inventory, traceability and party references all green |
| Statement SUP-00049 | opening balance on 31 Oct 2026: 1,283,160.00, reference `مراجعه موردين.xlsx · 28` |
| `equity_transfer` (other segment) | 3300 −418,281.23 → 0; 3900 credited 418,281.23 |
| After | status *Reconciliation Required*. 3900 = 3,842,205.57 Dr, fully traced (0.00 untraced). Inventory unchanged (418,281.23). Reports marked provisional. Failing checks: 3900 not zero, 41 exceptions, the four confirmations |

Production was not touched by any of this.
