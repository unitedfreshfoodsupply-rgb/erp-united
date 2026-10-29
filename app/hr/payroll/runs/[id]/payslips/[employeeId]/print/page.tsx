import Image from "next/image";
import { notFound } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireAnyPagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { serviceActorFromContext } from "@/lib/core/actor";
import { getRun } from "@/lib/hr/payroll";
import { PrintButton } from "@/app/sales/invoices/[id]/print/PrintButton";
import { localName } from "@/lib/locale/names";
import { printDir, printLocale, type PrintLocale } from "@/lib/locale/print";

/**
 * One payslip, A4, in the reader's language (`?lang=en`, like the other prints), from the
 * run's frozen lines. Printable once the run is approved; a reversed run's payslip prints
 * marked as reversed.
 */
const READ = ["hr.payroll.prepare", "hr.payroll.view", "hr.payroll.approve", "hr.payroll.post", "hr.payroll.pay"] as const;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export default async function PayslipPrint({ params, searchParams }: { params: { id: string; employeeId: string }; searchParams?: { lang?: string } }) {
  const locale: PrintLocale = printLocale(searchParams);
  const L = (ar: string, en: string) => (locale === "en" ? en : ar);
  const money = (v: Prisma.Decimal.Value) => D(v).toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const gate = await requireAnyPagePermission([...READ]);
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} homeHref="/hr/payroll" />;
  const run = await getRun(params.id, serviceActorFromContext(gate.user)).catch((e) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  const slip = run.employees.find((e) => e.employeeId === params.employeeId);
  if (!slip) notFound();
  if (!["approved", "posted", "reversed"].includes(run.status) || slip.inclusion !== "included") {
    return <main dir={printDir(locale)} lang={locale} className="p-8 font-bold">{L("لسه مفيش قسيمة نهائية — المسير لازم يتعتمد والقسيمة مش موقوفة.", "No final payslip yet: the run must be approved and the payslip not on hold.")}</main>;
  }
  const [company, paid] = await Promise.all([
    prisma.company.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } }),
    prisma.payrollPaymentLine.aggregate({ where: { runEmployeeId: slip.id, payment: { reversedAt: null } }, _sum: { amount: true } }),
  ]);
  const paidAmount = D(paid._sum.amount ?? 0);
  const section = (kinds: string[]) => slip.lines.filter((l) => kinds.includes(l.kind));
  const Labels = ({ ar, en }: { ar: string; en: string }) => <span className="font-bold">{L(ar, en)}</span>;
  const Table = ({ title, lines }: { title: { ar: string; en: string }; lines: typeof slip.lines }) => lines.length === 0 ? null : (
    <section className="mt-4">
      <h3 className="text-sm border-b border-united-dark/20 pb-1"><Labels {...title} /></h3>
      <table className="w-full text-[12px]">
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-united-dark/5">
              <td className="py-1">{localName({ name: l.nameEn, nameAr: l.nameAr }, locale)}{l.explanation ? <div className="text-[10px] text-united-dark/50"><bdi dir="ltr">{l.explanation}</bdi></div> : null}</td>
              <td className="py-1 text-end font-bold" dir="ltr">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
  const Row = ({ ar, en, v, strong }: { ar: string; en: string; v: string; strong?: boolean }) => (
    <div className={`flex justify-between gap-4 py-1 ${strong ? "text-base font-extrabold border-t-2 border-united-dark mt-1 pt-2" : ""}`}><Labels ar={ar} en={en} /><bdi className="tabular-nums">{v}</bdi></div>
  );
  return (
    <main dir={printDir(locale)} lang={locale} data-payslip={`${run.number}:${slip.employee.code}`} className="max-w-[210mm] mx-auto bg-white text-united-dark text-[13px] leading-relaxed p-[12mm] print:p-0">
      {run.status === "reversed" && <div className="mb-3 rounded border-2 border-united-danger p-2 text-center font-extrabold text-united-danger">{L("المسير ده اتعكس — القسيمة دي ملغية", "This run was reversed — this payslip is void")}</div>}
      <header className="flex items-start justify-between gap-6 pb-4 border-b-4 border-united-dark">
        <div className="flex items-start gap-3">
          <Image src="/brand/united-mark.png" alt="" width={48} height={48} className="shrink-0" />
          <div>
            <div className="text-xl font-extrabold tracking-wide">UNITED</div>
            {company && <div className="text-xs text-united-dark/70">{company.legalName}</div>}
          </div>
        </div>
        <div className="text-end">
          <div className="text-2xl font-extrabold text-united-green">{L("قسيمة مرتب", "Payslip")}</div>
          <div className="mt-1 font-bold"><bdi dir="ltr">{run.period}</bdi> · <bdi dir="ltr">{run.number}</bdi></div>
        </div>
      </header>
      <section className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
        <Row ar="الموظف" en="Employee" v={localName(slip.employee, locale)} />
        <Row ar="الكود" en="Code" v={slip.employee.code} />
        <Row ar="القسم" en="Department" v={slip.employee.department ? localName(slip.employee.department, locale) : "—"} />
        <Row ar="الوظيفة" en="Job title" v={slip.employee.jobTitle ?? "—"} />
      </section>
      <Table title={{ ar: "المستحقات", en: "Earnings" }} lines={section(["earning"])} />
      <Table title={{ ar: "الاستقطاعات", en: "Deductions" }} lines={section(["deduction"])} />
      <Table title={{ ar: "استرداد سلف وصرف تحت الحساب", en: "Advance and on-account recovery" }} lines={section(["recovery"])} />
      <section className="mt-5 ms-auto w-full max-w-[100mm] text-[13px]">
        <Row ar="إجمالي المستحقات" en="Gross" v={money(slip.gross)} />
        <Row ar="إجمالي الاستقطاعات" en="Deductions" v={money(slip.employeeDeductions)} />
        <Row ar="الاسترداد" en="Recovery" v={money(slip.advanceRecovery)} />
        <Row ar="الصافي المستحق" en="Net pay" v={`${money(slip.netPayable)} ${L("ج.م", "EGP")}`} strong />
        {run.status === "posted" && <Row ar="المصروف" en="Paid" v={money(paidAmount)} />}
        {run.status === "posted" && <Row ar="المتبقي" en="Unpaid" v={money(D(slip.netPayable).minus(paidAmount))} />}
      </section>
      <Table title={{ ar: "حصة صاحب العمل (للعلم — مش من المرتب)", en: "Employer contributions (information — not deducted)" }} lines={section(["employer_contribution"])} />
      <footer className="mt-8 grid grid-cols-2 gap-8 text-[11px] text-united-dark/60">
        <div>{L("اعتمده", "Approved by")}: {run.approvedBy ?? "—"}</div>
        <div className="text-end">{L("توقيع الموظف", "Employee signature")}: ________________</div>
      </footer>
      <PrintButton lang={locale} />
    </main>
  );
}
