import Image from "next/image";
import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { prisma } from "@/lib/prisma";
import { getInvoice } from "@/lib/sales/invoicing";
import { etaPublicState } from "@/lib/eta/service";
import { invoiceDocument, type InvoiceLang } from "@/lib/sales/invoiceDocument";
import { PrintButton } from "./PrintButton";
import { notFound } from "next/navigation";
import { ApiError } from "@/lib/rbac";

/**
 * A4 invoice in UNITED's own design (ETA standardises submitted data, not layout).
 * Built from the frozen snapshot on the invoice — never re-read from the customer or
 * the order. `?lang=en` prints the same document in English.
 */
export default async function InvoicePrint({ params, searchParams }: { params: { id: string }; searchParams: { lang?: string } }) {
  const gate = await requirePagePermission("sales.invoices.view");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  const lang: InvoiceLang = searchParams.lang === "en" ? "en" : "ar";
  const inv = await getInvoice(params.id).catch((e) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  if (inv.status !== "issued") return <main className="p-8 font-bold" dir={lang === "ar" ? "rtl" : "ltr"}>{lang === "en" ? "The invoice is still a draft — it cannot be printed before it is issued." : "الفاتورة لسه مسودة — مفيش طباعة قبل الإصدار."}</main>;
  const [company, eta] = await Promise.all([prisma.company.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } }), etaPublicState(inv.id)]);
  const d = invoiceDocument({ invoice: { ...inv, payments: inv.payments }, company, eta, lang });
  const L = d.labels;
  const Row = ({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) => (
    <div className={`flex justify-between gap-4 py-1 ${strong ? "font-extrabold" : ""}`}>
      <span className="text-united-dark/60">{k}</span>
      <span dir="ltr" className="text-united-dark">{v}</span>
    </div>
  );

  return (
    <main dir={d.dir} lang={d.lang} data-invoice={d.meta.number} className="invoice-doc max-w-[210mm] mx-auto bg-white text-united-dark text-[13px] leading-relaxed p-[12mm] print:p-0">
      {/* Header: brand on one side, document identity on the other */}
      <header className="flex items-start justify-between gap-6 pb-5 border-b-4 border-united-dark">
        <div className="flex items-start gap-3">
          <Image src="/brand/united-mark.png" alt="" width={56} height={56} className="shrink-0" />
          <div>
            <div className="text-2xl font-extrabold tracking-wide">UNITED</div>
            <div className="text-xs text-united-dark/60">Fruits &amp; Vegetables</div>
            {d.seller && (
              <div className="mt-2 text-xs text-united-dark/80 space-y-0.5">
                <div className="font-bold">{d.seller.legalName}</div>
                {d.seller.address && <div>{d.seller.address}</div>}
                {(d.seller.phone || d.seller.email) && <div dir="ltr">{[d.seller.phone, d.seller.email].filter(Boolean).join(" · ")}</div>}
              </div>
            )}
          </div>
        </div>
        <div className="text-end">
          <div className="text-3xl font-extrabold text-united-green">{L.title}</div>
          <div className="text-xs text-united-dark/50">{L.subtitle}</div>
          <div className="mt-2 inline-block rounded-lg bg-united-bg px-3 py-1 font-extrabold text-lg" dir="ltr">{d.meta.number}</div>
        </div>
      </header>

      {/* Parties and document facts */}
      <section className="grid grid-cols-3 gap-4 py-5">
        <div className="rounded-lg border border-united-dark/15 p-3">
          <div className="text-[11px] font-bold uppercase text-united-green mb-1">{L.seller}</div>
          <div className="font-extrabold">{d.seller?.name ?? "UNITED"}</div>
          {d.seller?.taxId && <Row k={L.taxId} v={d.seller.taxId} />}
          {d.seller?.commercialReg && <Row k={L.commercialReg} v={d.seller.commercialReg} />}
        </div>
        <div className="rounded-lg border border-united-dark/15 p-3">
          <div className="text-[11px] font-bold uppercase text-united-green mb-1">{L.buyer}</div>
          <div className="font-extrabold">{d.buyer.name}</div>
          {d.buyer.code && <Row k={L.customerCode} v={d.buyer.code} />}
          {d.buyer.taxId && <Row k={L.taxId} v={d.buyer.taxId} />}
          {d.buyer.address && <div className="text-xs text-united-dark/70 mt-1">{d.buyer.address}</div>}
        </div>
        <div className="rounded-lg border border-united-dark/15 p-3">
          <Row k={L.issueDate} v={d.meta.issueDate} />
          {d.meta.issueTime && <Row k={L.issueTime} v={d.meta.issueTime} />}
          {d.meta.dueDate && <Row k={L.dueDate} v={d.meta.dueDate} />}
          {d.meta.order && <Row k={L.order} v={d.meta.order} />}
          {d.meta.delivery && <Row k={L.delivery} v={d.meta.delivery} />}
          <Row k={L.currency} v={d.meta.currency} />
        </div>
      </section>

      {/* Lines */}
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-united-dark text-white">
            {[L.no, L.item, L.qty, L.unit, L.unitPrice, L.discount, L.net, L.tax, L.lineTotal].map((h, i) => (
              <th key={i} className={`px-2 py-2 font-bold ${i < 2 ? "text-start" : "text-center"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.no} className="border-b border-united-dark/10 even:bg-united-bg/60 print-break-inside-avoid">
              <td className="px-2 py-1.5">{l.no}</td>
              <td className="px-2 py-1.5 font-bold">{l.description}</td>
              <td className="px-2 py-1.5 text-center" dir="ltr">{l.qty}</td>
              <td className="px-2 py-1.5 text-center">{l.unit}</td>
              <td className="px-2 py-1.5 text-center" dir="ltr">{l.unitPrice}</td>
              <td className="px-2 py-1.5 text-center" dir="ltr">{l.discount}</td>
              <td className="px-2 py-1.5 text-center" dir="ltr">{l.net}</td>
              <td className="px-2 py-1.5 text-center" dir="ltr">{l.tax}</td>
              <td className="px-2 py-1.5 text-center font-bold" dir="ltr">{l.total}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Tax summary + payment on one side, totals on the other */}
      <section className="grid grid-cols-2 gap-6 pt-5 print-break-inside-avoid">
        <div className="space-y-4">
          <div>
            <div className="text-[11px] font-bold uppercase text-united-green mb-1">{L.taxSummary}</div>
            <table className="w-full text-[12px]">
              <thead><tr className="text-united-dark/60"><th className="text-start font-bold">{L.tax}</th><th className="font-bold">{L.taxBase}</th><th className="font-bold">{L.tax}</th></tr></thead>
              <tbody>
                {d.taxSummary.map((t) => (
                  <tr key={t.label}><td>{t.label}</td><td className="text-center" dir="ltr">{t.base}</td><td className="text-center" dir="ltr">{t.tax}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase text-united-green mb-1">{L.payment}</div>
            {d.payment.terms && <Row k={L.terms} v={d.payment.terms} />}
            <Row k={L.paid} v={d.payment.paid} />
            {d.payment.balance !== null && <Row k={L.balance} v={d.payment.paidInFull ? L.paidInFull : d.payment.balance} strong />}
            {d.payment.receipts.length > 0 && (
              <div className="text-[11px] text-united-dark/60 mt-1" dir="ltr">{d.payment.receipts.map((r) => `${r.number} · ${r.date} · ${r.amount}`).join("  |  ")}</div>
            )}
          </div>
        </div>
        <div className="rounded-lg bg-united-bg p-4 self-start">
          <Row k={L.subtotal} v={d.totals.gross} />
          {d.totals.hasDiscount && <Row k={L.totalDiscount} v={`− ${d.totals.discount}`} />}
          <Row k={L.netTotal} v={d.totals.net} />
          <Row k={L.totalTax} v={d.totals.tax} />
          <div className="mt-2 pt-2 border-t-2 border-united-dark flex justify-between gap-4 text-lg font-extrabold">
            <span>{L.grandTotal}</span>
            <span dir="ltr">{d.totals.total} {d.meta.currency}</span>
          </div>
        </div>
      </section>

      {d.eta && (
        <section className="mt-5 rounded-lg border-2 border-united-green/40 p-3 print-break-inside-avoid" data-eta-uuid={d.eta.uuid}>
          <div className="text-[11px] font-bold uppercase text-united-green mb-1">{L.eta}</div>
          <div className="grid grid-cols-2 gap-x-6">
            <Row k={L.etaUuid} v={d.eta.uuid} />
            <Row k={L.etaStatus} v={d.eta.status} />
            {d.eta.longId && <Row k={L.etaLongId} v={d.eta.longId} />}
            {d.eta.submittedAt && <Row k={L.etaSubmitted} v={d.eta.submittedAt} />}
            {d.eta.acceptedAt && <Row k={L.etaAccepted} v={d.eta.acceptedAt} />}
          </div>
        </section>
      )}

      {d.notes && <p className="mt-4 text-xs text-united-dark/70">{d.notes}</p>}
      <footer className="mt-8 pt-3 border-t border-united-dark/15 flex justify-between text-[11px] text-united-dark/50">
        <span>{L.thanks}</span>
        <span dir="ltr">{d.meta.number}</span>
      </footer>
      <div className="no-print mt-6 flex gap-2">
        <PrintButton lang={lang} />
        <a className="btn-secondary mt-6" href={`?lang=${lang === "ar" ? "en" : "ar"}`}>{lang === "ar" ? "English" : "عربي"}</a>
      </div>
    </main>
  );
}
