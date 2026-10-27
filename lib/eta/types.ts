/**
 * ETA Invoice v1.0 document, as submitted (JSON). Field names follow the published
 * v1.0 structure; see docs/erp/ETA_EINVOICE.md for the fields still to be verified
 * against the SDK pages before the first pre-production submission.
 *
 * Amounts are JSON numbers (ETA allows up to 5 decimals).
 */

export type EtaAddress = {
  branchID?: string;
  country: string;
  governate: string;
  regionCity: string;
  street: string;
  buildingNumber: string;
  postalCode?: string;
  floor?: string;
  room?: string;
  landmark?: string;
  additionalInformation?: string;
};

export type EtaParty = { type: "B" | "P" | "F"; id: string; name: string; address: EtaAddress };

export type EtaTaxableItem = { taxType: string; amount: number; subType: string; rate: number };

export type EtaInvoiceLine = {
  description: string;
  itemType: "GS1" | "EGS";
  itemCode: string;
  unitType: string;
  quantity: number;
  internalCode: string;
  salesTotal: number;
  total: number;
  valueDifference: number;
  totalTaxableFees: number;
  netTotal: number;
  itemsDiscount: number;
  unitValue: { currencySold: string; amountEGP: number; amountSold?: number; currencyExchangeRate?: number };
  discount: { rate: number; amount: number };
  taxableItems: EtaTaxableItem[];
};

export type EtaDocumentV1 = {
  issuer: EtaParty;
  receiver: EtaParty;
  documentType: "i" | "c" | "d";
  documentTypeVersion: "1.0";
  dateTimeIssued: string;
  taxpayerActivityCode: string;
  internalID: string;
  purchaseOrderReference?: string;
  salesOrderReference?: string;
  invoiceLines: EtaInvoiceLine[];
  totalDiscountAmount: number;
  totalSalesAmount: number;
  netAmount: number;
  taxTotals: { taxType: string; amount: number }[];
  totalAmount: number;
  extraDiscountAmount: number;
  totalItemsDiscountAmount: number;
  signatures?: { signatureType: "I" | "S"; value: string }[];
  /** Credit / debit notes: the ETA UUIDs of the invoices they adjust. */
  references?: string[];
};

/**
 * Everything the mapper needs, already read from UNITED's own models. Strings for money
 * and quantities so nothing is lost before the mapper decides how to send it. `null`
 * means "UNITED does not have this yet" — the validator reports it, nothing is invented.
 */
export type EtaSource = {
  /** A sales invoice, or a credit note against one (its lines are the credited part). */
  kind: "sales_invoice" | "credit_note";
  /** Credit note: the ETA UUID of the invoice it credits, once ETA accepted that invoice. */
  references?: string[];
  invoice: {
    id: string;
    number: string | null;
    status: string;
    issuedAt: string | null; // ISO
    currencyCode: string;
    buyerName: string | null;
    buyerTaxId: string | null;
    gross: string;
    discountTotal: string;
    net: string;
    taxTotal: string;
    total: string;
    orderNumber: string | null;
  };
  issuer: {
    name: string | null;
    registrationNumber: string | null;
    etaBranchId: string | null;
    activityCode: string | null;
    address: AddressSource;
  };
  receiver: {
    /** Explicit profile type, if one was set. */
    type: "B" | "P" | "F" | null;
    /** National id / passport for P or F. */
    personalId: string | null;
    address: AddressSource;
  };
  lines: {
    lineNo: number;
    description: string;
    productId: string | null;
    internalCode: string | null;
    itemType: string | null;
    itemCode: string | null;
    uomCode: string;
    etaUnitType: string | null;
    quantity: string;
    unitPrice: string;
    discountPct: string;
    gross: string;
    discount: string;
    net: string;
    taxCode: string;
    taxRate: string;
    etaTaxType: string | null;
    etaTaxSubtype: string | null;
    tax: string;
    total: string;
  }[];
  /** Receiver person-id threshold (EGP), from settings. */
  personIdThreshold: number;
};

export type AddressSource = {
  country: string | null;
  governate: string | null;
  regionCity: string | null;
  street: string | null;
  buildingNumber: string | null;
  postalCode: string | null;
  floor: string | null;
  room: string | null;
  landmark: string | null;
  additionalInformation: string | null;
};

export type EtaIssue = { level: "error" | "warning"; field: string; message: string };

export const ETA_STATUSES = ["pending", "submitting", "submitted", "valid", "invalid", "rejected", "failed", "unknown", "cancelled"] as const;
export type EtaStatus = (typeof ETA_STATUSES)[number];
