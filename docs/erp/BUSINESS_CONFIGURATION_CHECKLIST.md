# UNITED ERP — Business configuration checklist (finance and admin team)

This checklist is for the finance manager, the owner and the system administrator. It lists
every setting and master-data decision that **needs approval before go-live**.

**Technical default vs approved policy.**
- A **technical default** is what the software ships with so it can run. It is not a policy
  decision.
- An **approved policy** is a value management has decided and signed off.
- The software never switches a policy on by itself. Every row below is at its technical
  default until someone with `admin.settings` changes it. Each change asks for a reason and is
  written to the audit log.

**Where to change it.** Settings: *Administration → Settings*. Master data: the screens named in
the table.

**Recommended value.** This is a professional suggestion for a fresh-produce distributor of
UNITED's size. It is **not** an approval. Fill in the "Approved value / by / date" columns.

## 1. Accounting policy settings

| # | Setting (key) | Technical default | Recommended | Impact if left unchanged | Approved value / by / date |
|---|---|---|---|---|---|
| C1 | Fiscal year start month (`accounting.fiscal_year_start_month`) | 1 (January) | 1, unless the tax year differs | Fiscal years run January–December. **Cannot change after the first year-end close.** | |
| C2 | Manual journals need approval (`accounting.manual_journal_approval`) + threshold (`…_threshold`) | Off / 0 | **On**, threshold 0 (every manual journal) or e.g. 10,000 | One accountant can post any manual journal alone. | |
| C3 | Transfers need approval (`accounting.transfer_approval`) + threshold | Off / 0 | On above e.g. 50,000 | Large cash/bank movements need no second person. | |
| C4 | Cost centre required on expenses (`accounting.cost_center_required`) | Off | On, **after** C5 is set up | Expenses can be posted without a cost centre; the cost-centre report shows them as "unallocated". | |
| C7 | Bank charges account (`accounting.bank_charges_account`) | empty | An expense account, e.g. "Bank charges" | Bank-fee deductions on receipts, and transfer fees, are refused until set. | |
| C14a | Tax withheld by customers (`accounting.withholding_receivable_account`) | empty | An asset account "Withholding tax receivable" | The withholding deduction is not offered on receipts. | |
| C14b | Tax withheld from suppliers (`accounting.withholding_payable_account`) | empty | A liability account "Withholding tax payable" | The withholding deduction is not offered on supplier payments. | |
| C14c | Receipt differences account + limit (`accounting.write_off_account`, `accounting.write_off_limit`) | empty / 0 | An expense account; limit e.g. 5 EGP | Small differences cannot be forgiven; the invoice stays open by piastres. | |
| C14d | Net salaries payable (`hr.payroll_net_pay_account`) | empty | Liability account "Salaries payable" | **Payroll cannot be posted** until set. | |
| C8 | Service-bill approval threshold (`purchasing.service_bill_approval_threshold`) | 0 (every service bill needs approval) | e.g. 5,000 | Every rent or electricity bill waits for approval. | |
| — | Purchase-order approval (`purchasing.po_approval_threshold`) | 10,000 | Confirm | POs above it wait for accounting. | |
| — | Bill match tolerance (`purchasing.bill_match_tolerance_pct`) | 1 % | Confirm | Bills differing by more wait for approval. | |
| — | Over-receipt tolerance (`purchasing.over_receipt_tolerance_pct`) | 10 % | Confirm (produce weights vary) | Receipts above it are refused. | |
| — | Expense approval threshold (`hr.expense_approval_threshold`) | 500 | Confirm | Expenses above it wait. | |

## 2. Controls and segregation of duties

| # | Setting / decision | Technical default | Recommended | Impact if left unchanged | Approved |
|---|---|---|---|---|---|
| C16 | Approval by someone other than the requester (`approvals.require_different_approver`) | **Off** | **On** in production | Operational approvals can be decided by their requester: shortages, adjustments, POs, expenses, bills. Accounting approvals (journals, transfers, period/year reopen, opening batch) **always** require a different person, whatever this setting says. | |
| C10 | Finance users and who holds which permission | Super Admin holds everything | At least **two** finance users: an accountant (ACCOUNTANT role) and a finance manager holding `accounting.periods.reopen`, `accounting.opening.approve` and `accounting.journals.approve` | With one finance user, period reopening, opening-balance approval and approval-gated journals and transfers **cannot be completed**, because they need a second person. | |
| C9 | Cash box never negative on payments, expenses and refunds | Enforced only on transfers, asset purchases and VAT payments | Decide. If "never negative", a small change is needed (gap register L2). | The cash count is the control. | |
| — | Inventory adjustment approval (`inventory.adjustment_approval_threshold`) | 0 (none) | e.g. 10 kg | Any adjustment posts at once. | |
| — | Grading loss approval (`inventory.grading_loss_approval_threshold`) | 0 (none) | Confirm | Grading losses post at once. | |
| — | Credit control (`sales.credit_check_mode`) | warn | warn or block | Over-limit customers are only flagged. | |

## 3. Inventory costing policy

| # | Setting | Technical default | Recommended | Impact | Approved |
|---|---|---|---|---|---|
| C17 | Grading cost policy (`inventory.grading_cost_policy`) | proportional | **proportional** (keep) | Every grade carries the purchase cost per kg. NRV moves cost to the better grade by market value; it needs a maintained price list and changes reported margins. | |
| — | Grading waste treatment (`inventory.grading_waste_loss`) | expense_at_grading | (only used under NRV) | — | |
| — | Missing price at grading (`inventory.grading_price_missing`) | fallback | fallback | — | |
| C18 | **What the supplier is paid for** | Bills cover everything accepted (good + Grade B + waste). | Confirm with purchasing. | If the farm is paid only for good produce, record Grade B and waste the farm takes back as **rejected** at receipt. They then never enter stock or GRNI. | |
| — | Reserve stock automatically (`sales.auto_reserve`) | off | on, once receipts are fully recorded | — | |

## 4. Master data to create (none is seeded)

| # | Item | Screen | Decision needed |
|---|---|---|---|
| C5 | Cost centres (warehouses, fleet, each vehicle, operations, departments, admin, sales) and department links | Accounting → Cost Centers | Structure. Link a department to have payroll allocated to it. |
| C6 | Asset categories: life, method, residual %, start rule, accounts | Assets → Categories | Policy per category, capitalisation threshold, crates and pallets (gap register G9). The screen offers suggestions that only pre-fill the form. |
| C11 | Opening cut-over date and opening trial balance | Accounting → Opening balances | Date. Figures signed off by the finance manager. One initial batch only; corrections by an approved correction batch. |
| C12 | VAT return frequency | Accounting → Tax | Monthly. Returns must be contiguous, and the period must have ended. |
| C13 | Cash-flow class of every new balance-sheet account | Accounting → Chart of Accounts | Operating, investing or financing. Unclassified accounts are shown under operating and flagged. |
| C15 | Bank statement matching tolerance | Per import (±3 days by default) | Bank practice. |
| — | Cash boxes and bank accounts (bank name, account number) | Accounting → Cash & Banks | One per real account. |
| — | ETA e-invoicing credentials and activation | Administration → ETA | Only after the pre-production run (gap register L9). |

## 5. Go-live sign-off

- [ ] C1–C18 decided and entered; each change shows in the audit log with its reason.
- [ ] Two finance users exist; the finance manager holds the reopen, opening-approval and
      journal-approval permissions.
- [ ] Asset categories and cost centres created.
- [ ] Opening batch prepared, validated (difference 0), submitted, and approved by the finance
      manager.
- [ ] *Accounting → Health check* is green after the opening batch.
