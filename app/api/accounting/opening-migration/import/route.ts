import { importPartyRows } from "@/lib/accounting/opening-migration";
import { postHandler } from "@/lib/route-handlers";

/** A supplier or customer sheet: preview what each row becomes, or commit it into a draft phase batch (unmatched rows go to the exception register). */
export const POST = postHandler("accounting.manage", async (body, actor) => ({ result: await importPartyRows(body, actor) }), (r) => ((r as { result: { mode: string } }).result.mode === "commit" ? 201 : 200));
