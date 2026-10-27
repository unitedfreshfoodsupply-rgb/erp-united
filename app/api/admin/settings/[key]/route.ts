import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/rbac";
import { readJson } from "@/lib/http";
import { requireServiceActor } from "@/lib/core/actor";
import { updateSetting } from "@/lib/core/settings-service";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

/** Body: { value, reason, expected_version }. `value: null` resets to the default. */
export async function PATCH(req: NextRequest, { params }: { params: { key: string } }) {
  try {
    const actor = await requireServiceActor(req, "settings.manage");
    const body = await readJson(req);
    if (!("value" in body)) {
      return NextResponse.json({ error: localizeServerMessage("القيمة مطلوبة (أو null للرجوع للافتراضي)", requestLocale(req)) }, { status: 400 });
    }
    const result = await updateSetting(params.key, body.value, actor, {
      reason: body.reason,
      expectedVersion: body.expected_version,
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleApiError(err, req);
  }
}
