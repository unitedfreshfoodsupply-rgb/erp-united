import { unitLabel } from "@/lib/format";
import Image from "next/image";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/session-guard";
import { AccessDenied } from "@/components/AccessDenied";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { getBill } from "@/lib/purchasing/bills";
import { billDocument, type BillLang } from "@/lib/purchasing/billDocument";
import { DocumentPrintStyles } from "@/components/print/DocumentPrintStyles";
import { DocumentGapNotice } from "@/components/print/DocumentGapNotice";
import { PrintButton } from "@/app/sales/invoices/[id]/print/PrintButton";

/**
 * A4 print of a supplier bill: UNITED's record of the supplier's invoice, from the snapshot
 * frozen when it posted. A bill not posted yet prints with its state on it. `?lang=en` for English.
 */
export default async function BillPrint({ params, searchParams }: { params: { id: string }; searchParams: { lang?: string } }) {
  const gate = await requirePagePermission("purchasing.bills.view");
  if (!gate.ok) return <AccessDenied missing={gate.missing} role={gate.user.role} />;
  const lang: BillLang = searchParams.lang === "en" ? "en" : "ar";
  const b = await getBill(params.id).catch((e) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  const attachments = await prisma.attachment.findMany({ where: { entityType: "supplier_bill", entityId: b.id, deletedAt: null }, select: { fileName: true, category: true }, orderBy: { createdAt: "asc" } });
  const d = billDocument({ bill: b, snapshot: b.postSnapshot, current: b.current, attachments, lang });
  const L = d.labels;
  const hasCodes = d.lines.some((l) => l.code);
  const Row = ({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) => (
    <div className={`flex justify-between gap-4 py-0.5 ${strong ? "font-extrabold" : ""}`}>
      <span className="text-united-dark/60">{k}</span>
      <span dir="ltr" className="text-united-dark text-end whitespace-nowrap">{v}</span>
    </div>
  );
  const goodsHeads = [L.no, ...(hasCodes ? [L.code] : []), L.item, L.receipt, L.po, L.received, L.qty, L.unit, L.unitPrice, L.agreed, L.net, L.tax, L.lineTotal];
  const people = [[L.recordedBy, d.people.recordedBy], [L.approvedBy, d.people.approvedBy], [L.postedBy, d.people.postedBy]] as const;

  return (
    <main dir={d.dir} lang={d.lang} data-bill={d.meta.number} data-source={d.source} className="commercial-doc max-w-[210mm] mx-auto bg-white text-united-dark text-[13px] leading-relaxed p-[12mm] print:p-0">
      <DocumentPrintStyles pageLabel={L.page} ofLabel={L.of} number={d.meta.number} />
      <DocumentGapNotice gaps={d.buyerGaps} lang={lang} />

      <header className="flex items-start justify-between gap-6 pb-4 border-b-4 border-united-dark doc-keep">
        <div className="flex items-start gap-3">
          <Image src="/brand/united-mark.webp" alt="" width={56} height={56} className="shrink-0" />
          <div>
            <div className="text-2xl font-extrabold tracking-wide">UNITED</div>
            <div className="text-xs text-united-dark/60">Fruits &amp; Vegetables</div>
            {d.buyer && <div className="mt-2 text-xs font-bold text-united-dark/80">{d.buyer.legalName}</div>}
          </div>
        </div>
        <div className="text-end">
          <div className="text-3xl font-extrabold text-united-green" data-testid="doc-title">{d.title}</div>
          <div className="text-xs text-united-dark/50">{d.subtitle}</div>
          <div className="mt-2 inline-block rounded-lg bg-united-bg px-3 py-1 font-extrabold text-lg" dir="ltr">{d.meta.number}</div>
          <div className="mt-1 text-[11px] text-united-dark/60">{d.recordNote}</div>
        </div>
      </header>

      {!d.status.final && (
        <div className="mt-3 rounded-lg border-2 border-united-danger/50 px-3 py-2 text-center text-lg font-extrabold text-united-danger doc-keep" data-testid="bill-status-banner">
          {d.status.label}
        </div>
      )}

      <section className="grid grid-cols-3 gap-3 py-4 doc-keep">
        <div className="rounded-lg border border-united-dark/15 p-3">
          <div className="text-[11px] font-bold uppercase text-united-green mb-1">{L.supplier}</div>
          <div className="font-extrabold">{d.supplier?.name ?? "—"}</div>
          {d.supplier?.legalName && d.supplier.legalName !== d.supplier.name && <div className="text-xs">{d.supplier.legalName}</div>}
          {d.supplier?.code && <Row k={L.supplierCode} v={d.supplier.code} />}
          {d.supplier?.taxId && <Row k={L.taxId} v={d.supplier.taxId} />}
          {d.supplier?.commercialReg && <Row k={L.commercialReg} v={d.supplier.commercialReg} />}
          {d.supplier?.phone && <Row k={L.phone} v={d.supplier.phone} />}
          {d.supplier?.address && <div className="text-xs text-united-dark/70 mt-1">{d.supplier.address}</div>}
        </div>
        <div className="rounded-lg border border-united-dark/15 p-3">
          <div className="text-[11px] font-bold uppercase text-united-green mb-1">{L.buyer}</div>
          <div className="font-extrabold">{d.buyer?.name ?? "UNITED"}</div>
          {d.buyer?.taxId && <Row k={L.taxId} v={d.buyer.taxId} />}
          {d.buyer?.commercialReg && <Row k={L.commercialReg} v={d.buyer.commercialReg} />}
          {d.buyer?.address && <div className="text-xs text-united-dark/70 mt-1">{d.buyer.address}</div>}
        </div>
        <div className="rounded-lg border border-united-dark/15 p-3">
          <Row k={L.supplierInvoiceNo} v={d.meta.supplierInvoiceNo} strong />
          <Row k={L.billDate} v={d.meta.billDate} />
          <Row k={L.dueDate} v={d.meta.dueDate} />
          {d.meta.terms && <Row k={L.terms} v={d.meta.terms} />}
          <Row k={L.status} v={d.status.label} />
          {d.meta.match && <Row k={L.match} v={d.meta.match} />}
          <Row k={L.currency} v={d.meta.currency} />
        </div>
      </section>

      {(d.meta.purchaseOrders.length > 0 || d.meta.receipts.length > 0) && (
        <section className="pb-3 text-xs doc-keep">
          {d.meta.purchaseOrders.length > 0 && <div><span className="font-bold">{L.purchaseOrders}: </span><span dir="ltr">{d.meta.purchaseOrders.join(" · ")}</span></div>}
          {d.meta.receipts.length > 0 && <div><span className="font-bold">{L.receipts}: </span><span dir="ltr">{d.meta.receipts.join(" · ")}</span></div>}
        </section>
      )}

      {d.lines.length > 0 && (
        <table className="doc-lines w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-united-bg text-united-dark border-b-2 border-united-dark">
              {goodsHeads.map((h, i) => <th key={i} className={`px-1.5 py-2 font-extrabold ${i < (hasCodes ? 3 : 2) ? "text-start" : "text-center"}`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.no} className="border-b border-united-dark/10 even:bg-united-bg/40">
                <td className="px-1.5 py-1.5">{l.no}</td>
                {hasCodes && <td className="px-1.5 py-1.5 whitespace-nowrap" dir="ltr">{l.code ?? "—"}</td>}
                <td className="px-1.5 py-1.5 font-bold">{l.description}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.receipt}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.po ?? "—"}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.received}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.qty}</td>
                <td className="px-1.5 py-1.5 text-center">{unitLabel(l.unit, lang)}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.unitPrice}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.agreed}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.net}</td>
                <td className="px-1.5 py-1.5 text-center whitespace-nowrap" dir="ltr">{l.tax}</td>
                <td className="px-1.5 py-1.5 text-center font-bold whitespace-nowrap" dir="ltr">{l.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {d.serviceLines.length > 0 && (
        <table className="doc-lines w-full border-collapse text-[12px] mt-2">
          <thead>
            <tr className="bg-united-bg text-united-dark border-b-2 border-united-dark">
              {[L.no, L.description, L.account, L.net, L.tax, L.lineTotal].map((h, i) => <th key={i} className={`px-2 py-2 font-extrabold ${i < 3 ? "text-start" : "text-center"}`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.serviceLines.map((l) => (
              <tr key={l.no} className="border-b border-united-dark/10">
                <td className="px-2 py-1.5">{l.no}</td>
                <td className="px-2 py-1.5 font-bold">{l.description}</td>
                <td className="px-2 py-1.5">{l.account}</td>
                <td className="px-2 py-1.5 text-center" dir="ltr">{l.net}</td>
                <td className="px-2 py-1.5 text-center" dir="ltr">{l.tax}</td>
                <td className="px-2 py-1.5 text-center font-bold" dir="ltr">{l.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="grid grid-cols-2 gap-6 pt-4 doc-keep">
        <div className="space-y-2 text-xs">
          <Row k={L.debited} v={d.settlement.debited} />
          <Row k={L.paid} v={d.settlement.paid} />
          {d.settlement.balance !== null && <Row k={L.balance} v={d.settlement.settled ? L.settled : d.settlement.balance} strong />}
          {d.settlement.payments.length > 0 && <div className="text-[11px] text-united-dark/60" dir="ltr"><span className="font-bold">{L.payments}: </span>{d.settlement.payments.map((p) => `${p.number} · ${p.date} · ${p.amount}`).join("  |  ")}</div>}
          {d.settlement.debitNotes.length > 0 && <div className="text-[11px] text-united-dark/60" dir="ltr"><span className="font-bold">{L.debitNotes}: </span>{d.settlement.debitNotes.map((p) => `${p.number} · ${p.date} · ${p.amount}`).join("  |  ")}</div>}
          <div className="pt-2">
            <span className="font-bold">{L.attachments}: </span>
            {d.attachments.length ? d.attachments.map((a) => a.fileName).join(" · ") : <span className="text-united-danger font-bold">{L.noAttachment}</span>}
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
          {d.totals.variance && <div className="mt-1 text-[11px] text-united-dark/60"><Row k={L.variance} v={d.totals.variance} /></div>}
        </div>
      </section>

      {d.notes && <p className="mt-4 text-xs text-united-dark/80"><span className="font-bold">{L.notes}: </span>{d.notes}</p>}

      <section className="mt-8 grid grid-cols-3 gap-6 text-xs doc-keep" data-testid="signatures">
        {people.map(([label, name], i) => (
          <div key={i}>
            <div className="h-10 border-b border-united-dark/40" />
            <div className="mt-1 font-bold text-united-dark/70">{label}</div>
            {name && <div className="text-united-dark/60">{name}</div>}
          </div>
        ))}
      </section>

      <footer className="mt-6 pt-3 border-t border-united-dark/15 flex justify-between text-[11px] text-united-dark/50">
        <span dir="ltr">{d.meta.supplierInvoiceNo}</span>
        <span dir="ltr">{d.meta.number}</span>
      </footer>
      <div className="no-print doc-screen-only mt-6 flex gap-2">
        <PrintButton lang={lang} />
        <a className="btn-secondary mt-6" href={`?lang=${lang === "ar" ? "en" : "ar"}`}>{lang === "ar" ? "English" : "عربي"}</a>
      </div>
    </main>
  );
}
