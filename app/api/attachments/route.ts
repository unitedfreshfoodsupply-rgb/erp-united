import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { requireAuth } from "@/lib/authz";
import { serviceActorFromContext } from "@/lib/core/actor";
import { listAttachments, uploadAttachment } from "@/lib/core/attachments";
import { getSetting } from "@/lib/core/settings-service";
import { readFormLimited } from "@/lib/http";

/** Room for the form's other fields and the multipart framing around the file. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

/** GET ?entity_type=order&entity_id=… — the record's attachments, and the upload size limit
 * (documents.max_upload_mb) so the screen refuses a larger file before sending it. */
export async function GET(req: NextRequest) {
  try {
    const actor = serviceActorFromContext(await requireAuth(req));
    const sp = new URL(req.url).searchParams;
    const attachments = await listAttachments(sp.get("entity_type"), sp.get("entity_id"), actor, {
      includeDeleted: sp.get("include_deleted") === "1",
    });
    return NextResponse.json({ attachments, maxUploadMb: await getSetting("documents.max_upload_mb") });
  } catch (err) {
    return handleApiError(err, req);
  }
}

/**
 * multipart/form-data: entity_type, entity_id, category, description?, file.
 *
 * The body is read against documents.max_upload_mb before it is parsed: a declared size
 * over the limit is refused without reading it, and an undeclared one stops at the limit
 * (req.formData() buffered the whole upload first). uploadAttachment then checks the file
 * itself, its type and who may attach it.
 */
export async function POST(req: NextRequest) {
  try {
    const actor = serviceActorFromContext(await requireAuth(req));
    const maxMb = await getSetting("documents.max_upload_mb");
    const form = await readFormLimited(req, maxMb * 1024 * 1024 + FORM_OVERHEAD_BYTES, `الملف أكبر من ${maxMb} ميجا`, "الطلب لازم يكون multipart/form-data فيه ملف");
    const file = form.get("file");
    const result = await uploadAttachment(
      {
        entityType: form.get("entity_type"),
        entityId: form.get("entity_id"),
        category: form.get("category") ?? undefined,
        description: form.get("description") ?? undefined,
        file: file instanceof File ? file : null,
      },
      actor
    );
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    return handleApiError(err, req);
  }
}
