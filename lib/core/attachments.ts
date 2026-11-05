import { createHash, randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { inTx } from "@/lib/tx";
import { getSetting } from "@/lib/core/settings-service";
import { cleanFileName, detectFileType } from "@/lib/core/file-types";
import { storageProvider, StorageUnavailableError } from "@/lib/core/storage";
import { ATTACHMENT_CATEGORIES, ATTACHMENT_ENTITIES, type AttachmentCategory } from "@/lib/core/attachment-entities";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * Document attachments.
 *
 * Upload order, and why: the bytes are stored first, then the metadata row is
 * written (with its audit row) in one transaction. If the row fails, the blob is
 * removed again; a blob without a row is invisible and harmless, a row without a blob
 * would be a broken document. Re-uploading the same file to the same record is
 * idempotent — the content hash finds the existing attachment and nothing is stored
 * twice (also enforced by a partial unique index, for two uploads racing).
 */

function entityDef(entityType: unknown) {
  if (typeof entityType !== "string" || !Object.prototype.hasOwnProperty.call(ATTACHMENT_ENTITIES, entityType)) {
    throw new ApiError(400, "نوع السجل ده مبيقبلش مرفقات");
  }
  return ATTACHMENT_ENTITIES[entityType];
}

function assertAny(actor: { permissions: readonly string[] }, perms: string[], message: string) {
  if (!perms.some((p) => actor.permissions.includes(p))) throw new ApiError(403, message);
}

function provider() {
  try {
    return storageProvider();
  } catch (err) {
    if (err instanceof StorageUnavailableError) {
      // What is missing (setting names) is for the operator's log; staff are told whom to tell.
      console.error("[storage]", err.message);
      throw new ApiError(503, "تخزين الملفات مش متاح — بلّغ المسؤول");
    }
    throw err;
  }
}

const PUBLIC_SELECT = {
  id: true,
  entityType: true,
  entityId: true,
  category: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  description: true,
  uploadedBy: true,
  createdAt: true,
  deletedAt: true,
  deletedBy: true,
  deleteReason: true,
} as const;

export async function listAttachments(entityType: unknown, entityId: unknown, actor: ServiceActor, opts: { includeDeleted?: boolean } = {}) {
  const def = entityDef(entityType);
  assertAny(actor, def.view, "مالكش صلاحية تشوف مرفقات السجل ده");
  if (typeof entityId !== "string" || !entityId) throw new ApiError(400, "حدد السجل");
  return prisma.attachment.findMany({
    where: { entityType: entityType as string, entityId, ...(opts.includeDeleted ? {} : { deletedAt: null }) },
    orderBy: { createdAt: "desc" },
    select: PUBLIC_SELECT,
  });
}

export async function uploadAttachment(
  input: { entityType: unknown; entityId: unknown; category: unknown; description?: unknown; file: File | null },
  actor: ServiceActor
) {
  const def = entityDef(input.entityType);
  assertAny(actor, def.manage, "مالكش صلاحية ترفع مرفقات على السجل ده");
  const entityType = input.entityType as string;
  if (typeof input.entityId !== "string" || !input.entityId) throw new ApiError(400, "حدد السجل");
  const entityId = input.entityId;
  const category = (input.category ?? "other") as AttachmentCategory;
  if (!ATTACHMENT_CATEGORIES.includes(category)) throw new ApiError(400, "نوع المستند غير معروف");
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null;

  const file = input.file;
  if (!file || typeof file === "string") throw new ApiError(400, "مفيش ملف");
  const maxMb = await getSetting("documents.max_upload_mb");
  // The route already refused a request body over this limit before reading it
  // (app/api/attachments); this is the file's own size.
  if (file.size > maxMb * 1024 * 1024) throw new ApiError(413, `الملف أكبر من ${maxMb} ميجا`);
  if (file.size === 0) throw new ApiError(400, "الملف فاضي");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > maxMb * 1024 * 1024) throw new ApiError(413, `الملف أكبر من ${maxMb} ميجا`);

  const fileName = cleanFileName(file.name || "file");
  const detected = detectFileType(bytes, fileName);
  if (!detected) throw new ApiError(415, "نوع الملف مش مسموح — المسموح: PDF، صور، Excel، Word، CSV");

  if (!(await def.exists(prisma as never, entityId))) throw new ApiError(404, "السجل مش موجود");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = await prisma.attachment.findFirst({
    where: { entityType, entityId, sha256, deletedAt: null },
    select: PUBLIC_SELECT,
  });
  if (existing) return { attachment: existing, duplicate: true };

  const store = provider();
  // The key is ours: record type / record id / random id. The user's file name never
  // reaches the storage layer.
  const storageKey = `${entityType}/${entityId.replace(/[^A-Za-z0-9_-]/g, "")}/${randomUUID()}.${detected.ext}`;
  await store.put(storageKey, bytes, detected.mime);

  try {
    const attachment = await inTx(async (tx) => {
      const row = await tx.attachment.create({
        data: {
          entityType,
          entityId,
          category,
          fileName,
          contentType: detected.mime,
          sizeBytes: bytes.length,
          sha256,
          storageProvider: store.name,
          storageKey,
          description,
          uploadedById: actor.id,
          uploadedBy: actor.name,
        },
        select: PUBLIC_SELECT,
      });
      await writeAudit(
        {
          userId: actor.id,
          userName: actor.name,
          role: actor.role,
          action: "attachment_added",
          entityType: "attachment",
          entityId: row.id,
          orderId: entityType === "order" ? entityId : null,
          fieldChanged: `${entityType}:${entityId}`,
          newValue: `${fileName} · ${category} · ${bytes.length} bytes`,
          source: "user",
          deviceId: actor.deviceId,
        },
        tx
      );
      return row;
    });
    return { attachment, duplicate: false };
  } catch (err) {
    await store.remove(storageKey).catch(() => undefined); // compensate: no orphaned blob
    if ((err as { code?: string })?.code === "P2002") {
      // Same file uploaded concurrently to the same record: the other upload won.
      const winner = await prisma.attachment.findFirst({ where: { entityType, entityId, sha256, deletedAt: null }, select: PUBLIC_SELECT });
      if (winner) return { attachment: winner, duplicate: true };
    }
    throw err;
  }
}

/** Bytes + headers for a download, after the record-level permission check. */
export async function readAttachment(id: string, actor: ServiceActor) {
  const row = await prisma.attachment.findUnique({ where: { id } });
  if (!row || row.deletedAt) throw new ApiError(404, "المرفق مش موجود");
  assertAny(actor, entityDef(row.entityType).view, "مالكش صلاحية تشوف المرفق ده");
  const store = provider();
  if (store.name !== row.storageProvider) {
    throw new ApiError(503, "المرفق ده متخزن في مكان تاني غير المتظبط حاليًا");
  }
  const bytes = await store.get(row.storageKey);
  const inlineSafe = detectFileType(bytes.subarray(0, 4096), row.fileName)?.inlineSafe ?? false;
  return { row, bytes, inlineSafe };
}

/** Soft delete: the record stays (with who, when and why), so does the blob. */
export async function deleteAttachment(id: string, reason: unknown, actor: ServiceActor) {
  const row = await prisma.attachment.findUnique({ where: { id } });
  if (!row || row.deletedAt) throw new ApiError(404, "المرفق مش موجود");
  assertAny(actor, entityDef(row.entityType).manage, "مالكش صلاحية تشيل المرفق ده");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new ApiError(400, "اكتب سبب الحذف");
  return inTx(async (tx) => {
    const updated = await tx.attachment.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: actor.id, deletedBy: actor.name, deleteReason: why },
    });
    if (updated.count === 0) throw new ApiError(409, "المرفق اتشال بالفعل");
    await writeAudit(
      {
        userId: actor.id,
        userName: actor.name,
        role: actor.role,
        action: "attachment_removed",
        entityType: "attachment",
        entityId: id,
        orderId: row.entityType === "order" ? row.entityId : null,
        fieldChanged: `${row.entityType}:${row.entityId}`,
        oldValue: row.fileName,
        reason: why,
        source: "user",
        deviceId: actor.deviceId,
      },
      tx
    );
    return { removed: true };
  });
}
