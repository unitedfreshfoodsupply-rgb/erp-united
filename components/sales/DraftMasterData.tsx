"use client";

import Link from "next/link";
import { useLocale } from "@/lib/locale";
import { usePermissions } from "@/lib/use-session";
import { PartyLink } from "@/components/profiles/EntityLink";
import type { CompanyDocumentGap, CompanySnapshot, PartySnapshot } from "@/lib/core/document-snapshot";

export type DraftParties = {
  seller: CompanySnapshot | null;
  sellerGaps: CompanyDocumentGap[];
  buyer: PartySnapshot | null;
  buyerIdentity: { ok: true; name: string; taxId: string | null; address: string | null; source: string } | { ok: false; error: string } | null;
};

/**
 * On a draft invoice: the seller and buyer exactly as issue will freeze them, read live from
 * the company and customer records, and what is missing. Nothing here is edited on the invoice —
 * the record is corrected where it lives (the customer's profile, Admin → Company & stores),
 * and the draft shows the change at once.
 */
export function DraftMasterData({ parties, customerId }: { parties: DraftParties; customerId: string }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const id = parties.buyerIdentity;
  return (
    <section className="card p-4 grid gap-3 sm:grid-cols-2" data-testid="draft-master-data">
      <div>
        <h3 className="font-extrabold">{t("doc.seller")}</h3>
        <p className="text-sm font-bold">{parties.seller?.legalName ?? "—"}</p>
        {parties.seller?.taxRegistrationNumber && <p className="text-xs text-united-muted">{t("doc.tax-id")} <bdi dir="ltr">{parties.seller.taxRegistrationNumber}</bdi></p>}
        {parties.sellerGaps.length > 0 && (
          <p role="status" className="mt-1 rounded-lg bg-united-warn/10 px-2 py-1 text-xs font-bold text-united-dark">
            {t("doc.gaps-company", { fields: parties.sellerGaps.map((g) => t(`doc.gap.${g}`)).join(" · ") })}
            {can("users.view") && can("core.masterdata.view") && <> · <Link href="/admin?tab=master" className="text-united-green hover:underline">{t("doc.fix-company")}</Link></>}
          </p>
        )}
      </div>
      <div>
        <h3 className="font-extrabold">{t("doc.buyer")}</h3>
        {id?.ok ? (
          <>
            <p className="text-sm font-bold">{id.name}</p>
            {id.taxId && <p className="text-xs text-united-muted">{t("doc.tax-id")} <bdi dir="ltr">{id.taxId}</bdi></p>}
            {id.address && <p className="text-xs text-united-muted">{id.address}</p>}
          </>
        ) : (
          <p role="alert" className="text-sm font-bold text-united-danger">{id?.error ?? "—"}</p>
        )}
        {parties.buyer?.phone && <p className="text-xs text-united-muted">{t("doc.phone")} <bdi dir="ltr">{parties.buyer.phone}</bdi></p>}
        <p className="mt-1 text-xs">
          {t("doc.fix-customer")} <PartyLink kind="customer" id={customerId} name={parties.buyer?.code ?? t("doc.customer-card")} />
        </p>
      </div>
      <p className="sm:col-span-2 text-xs text-united-muted">{t("doc.draft-live-note")}</p>
    </section>
  );
}
