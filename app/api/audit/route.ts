import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireOrderActor } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { Permission } from "@/lib/permissions";
import { visibleAuditRows } from "@/lib/security/audit-visibility";
import { isValidISODate } from "@/lib/dates";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

const MAX_PAGE = 200;
const KNOWN_ENTITY_TYPES = new Set([
  "order", "order_item", "purchase_order", "purchase_order_line",
  "approval_request", "sales_invoice", "credit_note", "supplier_bill",
  "debit_note", "journal_entry", "customer_receipt", "supplier_payment",
  "accounting_period", "bank_reconciliation", "stock_intake", "inventory_document",
  "stock_movement", "employee", "department", "expense", "employee_transaction", "rfq",
  "work_schedule", "public_holiday", "attendance_day", "attendance_correction", "attendance_source", "leave_type", "leave_policy", "leave_request", "pay_component", "employee_compensation", "statutory_rule_set", "payroll_run", "payroll_adjustment", "payroll_payment",
  "customer", "supplier", "product", "settings", "user",
]);

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get("orderId");
    const action = searchParams.get("action");       // e.g. "dispatch", "close"
    const entityType = searchParams.get("entity");   // e.g. "sales_invoice", "journal_entry"
    const from = searchParams.get("from");            // YYYY-MM-DD (ISO)
    const to = searchParams.get("to");                // YYYY-MM-DD
    const q = searchParams.get("q");                  // free-text search (description, reason, old/new value)
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 50), 1), MAX_PAGE);
    const offset = Math.max(Number(searchParams.get("offset") ?? 0), 0);

    // The timeline of one order is part of working that order, so anyone who can see
    // orders can see it. All other filtering requires the higher audit.view permission.
    const actor = await requireOrderActor(req, orderId ? "orders.view" : "audit.view");
    const can = (p: Permission) => actor.permissions.includes(p);

    // Build the where clause.
    const where: Prisma.AuditLogWhereInput = {};
    if (orderId) where.orderId = orderId;
    if (action) where.action = { contains: action };
    if (entityType) {
      if (!KNOWN_ENTITY_TYPES.has(entityType)) return NextResponse.json({ error: localizeServerMessage(`نوع الكيان "${entityType}" مش معروف`, requestLocale(req)) }, { status: 400 });
      where.entityType = entityType;
    }
    // Each bound is used only when it is a real date: a malformed one is ignored rather
    // than reaching Prisma as an Invalid Date (a 500).
    const fromOk = from && isValidISODate(from);
    const toOk = to && isValidISODate(to);
    if (fromOk || toOk) {
      where.timestamp = {
        ...(fromOk ? { gte: new Date(from + "T00:00:00Z") } : {}),
        ...(toOk ? { lte: new Date(to + "T23:59:59Z") } : {}),
      };
    }
    if (q) {
      const words = q.trim().split(/\s+/);
      where.AND = words.map((word) => ({
        OR: [
          { reason: { contains: word } },
          { oldValue: { contains: word } },
          { newValue: { contains: word } },
          { entityId: word },
          { id: word },
        ],
      }));
    }

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: orderId ? { timestamp: "desc" } : { timestamp: "desc" },
        skip: offset,
        take: limit,
        include: { order: { select: { orderNumber: true, customerName: true } } },
      }),
    ]);

    const logs = visibleAuditRows(rows, can);

    // Resolve item names for order_item events.
    const itemIds = [...new Set(logs.filter((l) => l.entityType === "order_item").map((l) => l.entityId))];
    const items = itemIds.length
      ? await prisma.orderItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, productName: true, unit: true } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    return NextResponse.json({
      total,
      offset,
      limit,
      logs: logs.map((l) => ({
        ...l,
        itemName: l.entityType === "order_item" ? itemById.get(l.entityId)?.productName ?? null : null,
        itemUnit: l.entityType === "order_item" ? itemById.get(l.entityId)?.unit ?? null : null,
      })),
    });
  } catch (err) {
    return handleApiError(err, req);
  }
}