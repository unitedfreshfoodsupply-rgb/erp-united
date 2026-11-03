# Opening balances: one total per customer and per supplier (readiness, 3 November 2026)

**Short answer.** UNITED can take your opening balances as **one total per customer and one total per supplier**. No historical invoices are needed, and the accounting design does not change. The batch takes each total on one line, named by the customer's or supplier's UNITED code. It posts the total to the receivables (1300) or payables (2100) control account against opening equity (3300), and only after a second person approves it. This was verified end to end on a local test database: direction, cut-off date, sub-ledger against control account, trial balance, balance sheet, duplicate protection and approval.

**It is not yet ready for the real supplier balances in production.** Five things must happen first (§8):
- this release is deployed;
- the owner decides how to treat the opening stock already posted on its own (G-5 and G-6);
- a second person is set up who can approve;
- the legacy trial balance at the cut-off date is produced;
- four accounting decisions (§9) are taken.

No balance was posted, and no production data was changed.

## 1. The method

| Step | Rule in UNITED |
|---|---|
| Cut-off date | The last day before UNITED goes live. All opening balances post on that date; everything after it is entered normally in UNITED. |
| One line per party | Kind "customer" or "supplier", the party's UNITED code, a signed amount, an optional due date and an optional reference. |
| Direction | **Customer:** a positive amount means the customer owes us. It debits AR (1300) and credits opening equity (3300). A negative amount is an advance or credit the customer holds; it posts the other way.<br>**Supplier:** a positive amount means we owe the supplier. It debits opening equity (3300) and credits AP (2100). A negative amount is an advance we paid the supplier.<br>Every AR and AP line carries the party, so the sub-ledger is the control account's own lines. |
| Control accounts | Lines for a party always post to AR (1300) or AP (2100). Neither account can be entered as a plain GL line in the batch, nor can opening equity, inventory, GRNI, VAT or employee accounts. |
| Balance | The batch is one opening trial balance. Total debits must equal total credits, and opening equity (3300) must net to zero. The legacy cash, bank, capital, retained earnings and loan balances (GL lines), plus stock and assets, close the difference left by the party totals. |
| Posting | All in one transaction on approval: one entry per party line (traceable as `opening_balance`), one entry for the GL lines and one for the stock, each balanced against 3300. |

**Industry practice.** Odoo, SAP and Dynamics 365 all load opening balances through a clearing (opening-equity) account. That account must net to zero, under one cut-off date, with the sub-ledger reconciled to the control account and to the legacy trial balance. Each allows one balance per party when invoice detail is not needed. UNITED's batch follows the same pattern.

## 2. The seven checks you asked for

| Requirement | How UNITED does it | Evidence |
|---|---|---|
| Debit/credit direction | The sign rules in §1 and the template's computed "amount for UNITED" column. A customer credit and a supplier advance are negative totals. | e2e `opening-batch` §2 and §4:<br>• customer +12,000 and −1,500 by code;<br>• supplier +8,000 and −700;<br>• AR +10,500 and AP −7,300 in the ledger;<br>• the customer's statement closes at −1,500 and the supplier's at −700. |
| Opening cut-off date | Set on the batch and frozen once it is submitted. Every line posts on it. Posting is refused in a closed period, a closed year, on or before the lock date, or after the current month. The cut-over report refuses a cut-off date earlier than the reversal of the direct opening stock. | e2e `opening-batch` and unit `cutover-opening` |
| Sub-ledger balances | Each line becomes the party's opening item. Statements, aging and the credit check read it. | e2e: one opening row per party, with the right closing balance |
| Reconciliation with AR and AP control accounts | The integrity report compares AR and AP with the GL, in total and per party. The template's Checks sheet compares the party totals with the legacy control balances. The cut-over report shows the AR and AP figures. | e2e: integrity report green after posting and after a correction |
| Trial balance and balance sheet | The batch shows its opening trial balance before submission. After posting, the trial balance balances and the balance sheet moves by exactly AR and AP. | e2e: receivables +10,500, payables +7,300, balance sheet still balanced (new check) |
| No duplicate opening entries | Several layers:<br>• one initial batch only (database unique index);<br>• a second initial batch is refused;<br>• the direct entry forms close once the batch posts;<br>• each journal entry posts once (unique per source);<br>• **new:** a customer or supplier line entered twice is refused;<br>• **new:** a party on more than one line is flagged for review;<br>• **new:** identical stock or GL lines are flagged. | e2e: a repeated paste blocks submission (409), a party on two lines raises a warning |
| Audit trail, review and approval | Every step is audited: created, lines added or removed, submitted, rejected, cancelled, posted, and each party line. Submitting freezes the lines (database triggers). A different person must approve (`accounting.opening.approve`). Rejecting returns the batch to draft. Corrections go through approved correction batches only. | e2e: the preparer cannot approve (403); frozen lines refused by the API and by the database |

## 3. What changed for this (this release, no posting rule changed)

- **Lines by code.** A batch line can name its record by the code people use: `party_code` (customer or supplier code), `account_code` or `sku`. Internal ids are still accepted. An unknown code refuses the whole paste with the line number. The paste also handles quoted cells, such as "1,250.00".
- **Duplicates.** A customer or supplier line repeated with the same amount, due date and reference blocks submission. A party on two lines with different figures, and identical stock or GL lines, raise warnings for the reviewer. The misleading message shown when opening stock had already been posted directly is fixed.
- **Template.** `OPENING_BALANCES_TEMPLATE_2026-11.xlsx` (in the maturity folder) contains:
  - bilingual instructions;
  - sheets for suppliers, customers, GL and stock, each with a debit and a credit column and a computed signed amount;
  - checks for duplicates, a missing code, both sides filled in and zero;
  - "Paste" sheets that produce exactly the columns the batch reads;
  - a Checks sheet comparing the party totals with the legacy control balances, the batch balance and the sign-off block.

  It contains no figures.

## 4. Implemented, incomplete, incorrect

| | Item |
|---|---|
| **Implemented and verified** | One total per party; sign rules; cut-off date; one batch; validation as an opening trial balance; two-person approval; posting once; statements, aging and credit checks read the opening items; integrity report per party; correction batches; cut-over readiness report; refusal of repeated party lines; lines by code; bilingual template. |
| **Incomplete** | (a) A **negative** opening total (a customer's credit, our advance to a supplier) is correct in the ledger, statements and balances, but it is not offered for allocation against new invoices or bills. It stays "unapplied" in aging while an invoice of the same customer shows open (A-12).<br>(b) An aggregate balance has one due date, so aging shows the whole balance as due on that date (A-13).<br>(c) No file upload: the batch is filled by pasting from the template.<br>(d) No automatic comparison with the legacy trial balance: the template's Checks sheet and the cut-over report are the comparison.<br>(e) GRNI and VAT balances have no line kind (by design: GRNI is settled before cut-over or carried as a supplier balance; VAT is filed and settled in the old system). |
| **Incorrect (found, fixed in this release)** | Submitting a batch while opening stock had already been posted directly showed "opening balances already posted" instead of the real reason. |

## 5. Risks of duplication and reconciliation

| Risk | Control |
|---|---|
| The same supplier total entered twice | Refused at submission (new); the template flags repeated codes. |
| A party split over several lines by mistake | Warning on the batch; the template flags repeated codes. |
| Old invoices later re-entered as live documents | Procedure: no pre-cut-off invoice or bill is entered in UNITED, because their balance is in the opening total. After cut-off, set the lock date (A-14). |
| Opening stock counted twice | The batch refuses stock lines while a direct opening stock document stands (production has one: ADJ-2026-00001, 418,281.23). G-5 and G-6 decide this. |
| A party total that does not match the legacy ledger | The template's Checks sheet must show zero difference against the legacy AR and AP control balances before import. After posting, the integrity report must be green. |
| Equity misstated | 3300 must net to zero. The batch refuses an unbalanced trial balance, and the cut-over report checks 3300 overall and at the cut-off date. |
| Approval by the preparer | Refused in the code. The approver must be another user who holds `accounting.opening.approve`. |

## 6. The exact workflow

1. **Prepare** (accountant). Fill the template from the legacy trial balance at the cut-off date. Each party's total goes on one row, debit or credit. Clear every flag in the "check" columns.
2. **Reconcile before import** (accountant). On the Checks sheet, enter the legacy AR and AP control balances. Both differences must be zero, and the batch balance difference must be zero.
3. **Import** (accountant, `accounting.manage`). Go to Accounting → Opening balances → New initial batch, with the cut-off date. For each kind (supplier, customer, GL, and stock once G-5 is decided), select the kind and paste the matching "Paste" sheet. An unknown code refuses the paste and names the line.
4. **Validate** (the system, on every view). The batch screen shows:
   - the opening trial balance;
   - the customer, supplier, stock and asset totals;
   - **problems** that block submission: duplicate party lines, an unbalanced batch, a closed period, an earlier initial batch, direct opening stock;
   - **warnings** for the reviewer: a party on two lines, identical lines, direct party openings.
5. **Review** (chief accountant). Match the screen totals to the Checks sheet and sign it.
6. **Approve** (accountant submits; the owner approves). "Send for approval" freezes the lines. The approver opens the request from the approvals inbox and approves it, or rejects it back to draft.
7. **Post** (the system, on approval). Everything posts once on the cut-off date. A second initial batch is refused from then on, and changes go through approved correction batches.
8. **Reconcile after posting** (chief accountant). File these with the template:
   - the integrity report, green: AR and AP equal their control account per party;
   - the cut-over readiness report, with no blocker;
   - the statements of the largest parties;
   - the trial balance and the balance sheet.

## 7. Production today (read-only aggregates, 3 November 2026)

| Figure | Value |
|---|---|
| Migrations applied | 77, so the batch mechanism (migration 76) is already there; the by-code lines and duplicate checks arrive with this release |
| Customers / suppliers / products | 108 / 83 / 222 |
| Opening batches / party opening balances | 0 / 0 |
| Active users | **1** |
| Direct opening stock | ADJ-2026-00001: 418,281.23 in 3300 |
| Supplier bills / receipts of goods / sales invoices | 0 / 0 / 1 |

## 8. Is the system ready to receive the real supplier opening balances?

**Functionally, yes.** The aggregate method works as you described, end to end, and was verified on a local test database.

**In production, not yet.** Before the real totals can be posted:

1. **Deploy this release.** It brings the by-code lines, the duplicate refusal and the corrected messages (the 18 migrations of the production migration plan).
2. **Decide G-5 and G-6.** Opening stock is already posted directly (418,281.23 in 3300). The owner and the chief accountant decide whether to reverse it and bring stock in through the batch, and fix the cut-off date.
3. **Create a second user.** Production has one active user. Someone must prepare (`accounting.manage`) and someone else must approve (`accounting.opening.approve`). The preparer cannot approve their own batch, so with one user nothing can post, and the cut-over report shows this as a blocker.
4. **Produce the legacy trial balance at the cut-off date.** The AR and AP control totals and the GL balances are needed for the Checks sheet and to balance the batch.
5. **Take decisions A-12 to A-15** (§9).
6. **Check the one sales invoice already in production.** If it is dated before the cut-off date, its balance must not also be included in that customer's opening total.

## 9. Decisions needed

| # | Decision | Current behaviour | Impact | Recommendation | Approver |
|---|---|---|---|---|---|
| A-12 | Negative opening totals (customer credit, supplier advance) | Correct in the ledger and the statement, but cannot be allocated against new invoices or bills; shown as unapplied in aging | An invoice of that customer shows open although the account nets to zero; collections may chase it | Before the first collections run: confirm whether any party has a negative opening total. If none does, accept. If some do, build allocation of negative opening items (an open-item matching change only; the ledger postings stay the same), or settle each one by an approved refund or offset after go-live. | Chief accountant |
| A-13 | Due date of an aggregate balance | Blank means the cut-off date; the whole balance ages from one date | Aging and the credit check treat the whole opening balance as due at cut-off | Cut-off date + the party's payment terms, entered in the template's due-date column; or the cut-off date if the legacy aging is not carried | Chief accountant |
| A-14 | Lock date after cut-off | Not set | Live documents dated before the cut-off date could still be entered | Set `accounting.lock_date` to the cut-off date once the correction window closes. Correction batches are dated on the cut-off date, so set the lock only after the last correction. | Chief accountant |
| A-15 | One line per party in the initial batch | A party on two lines is a warning, not a refusal | A split or duplicated party total could pass if the reviewer misses the warning | Keep it a warning; the review and the Checks sheet are the control. Make it a refusal only if the owner wants it enforced. | Chief accountant with the owner |
