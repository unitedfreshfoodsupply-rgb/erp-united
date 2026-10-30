-- Pin search_path on the business-rule trigger functions (Supabase advisor
-- "function_search_path_mutable"; Sprint 0 F-18). None is SECURITY DEFINER; pinning
-- removes the dependence on the caller's search_path. The value is what they resolve
-- today: the public schema, then Supabase's extensions schema, temp objects last.
-- Function bodies are unchanged.

ALTER FUNCTION public.accounting_allocation_cap() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.accounting_deduction_cap() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.accounting_entry_balanced() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.accounting_line_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.accounting_period_open() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.eta_document_no_delete() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_append_only() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_attendance_day_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_attendance_day_has_revision() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_bank_account_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_compensation_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_compensation_line_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_compensation_no_overlap() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_employment_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_leave_policy_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_leave_policy_no_overlap() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_leave_request_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_leave_request_no_overlap() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_leave_tier_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_payroll_adjustment_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_payroll_frozen_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_payroll_payment_complete() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_payroll_payment_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_payroll_payment_line_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_payroll_run_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_rule_set_guard() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.hr_rule_set_no_overlap() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.purchasing_bill_frozen() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.purchasing_bill_line_frozen() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.sales_append_only() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.sales_invoice_frozen() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.sales_invoice_line_frozen() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.stock_bucket_never_negative() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.stock_ledger_append_only() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.stock_valuation_append_only() SET search_path = public, extensions, pg_temp;
