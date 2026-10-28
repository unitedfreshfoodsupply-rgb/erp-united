import { inflateRawSync } from "node:zlib";
import { ApiError } from "@/lib/rbac";

const MAX_ZIP_BYTES = 2_000_000;
const MAX_EXPANDED_BYTES = 8_000_000;
const MAX_ENTRIES = 1_000;
const MAX_ROWS = 1_000;
const MAX_COLUMNS = 80;
const DATE_HEADERS = new Set(["date", "due_date", "expiry_date", "valid_from", "valid_to"]);

type ZipEntry = { method: number; compressedSize: number; size: number; crc32: number; localOffset: number };

function fail(message: string): never { throw new ApiError(400, message); }

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function unzip(input: Uint8Array): Map<string, Uint8Array> {
  if (input.byteLength > MAX_ZIP_BYTES) fail("حجم ملف Excel لازم يكون أقل من 2 ميجابايت");
  if (input.byteLength < 22) fail("الملف مش Excel XLSX صالح");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const min = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let i = bytes.length - 22; i >= min; i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) fail("الملف مش Excel XLSX صالح");
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail("ملفات Excel متعددة الأجزاء غير مدعومة");
  const entries = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (!entries || entries > MAX_ENTRIES || centralOffset + centralSize > end) fail("محتويات ملف Excel غير صالحة");

  const directory = new Map<string, ZipEntry>();
  let offset = centralOffset;
  let expanded = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) fail("دليل ملف Excel غير صالح");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > bytes.length) fail("دليل ملف Excel غير مكتمل");
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength).replace(/\\/g, "/");
    if (!name || name.startsWith("/") || name.split("/").includes("..") || directory.has(name)) fail("مسار ملف داخل Excel غير آمن أو مكرر");
    if (flags & 1) fail("ملفات Excel المشفرة بكلمة مرور غير مدعومة");
    if (method !== 0 && method !== 8) fail("طريقة ضغط ملف Excel غير مدعومة");
    if (size > MAX_EXPANDED_BYTES || compressedSize > MAX_ZIP_BYTES) fail("ملف Excel أكبر من الحد المسموح");
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) fail("حجم البيانات بعد فك ضغط Excel أكبر من 8 ميجابايت");
    directory.set(name, { method, compressedSize, size, crc32: expectedCrc, localOffset });
    offset = entryEnd;
  }

  const files = new Map<string, Uint8Array>();
  for (const [name, entry] of directory) {
    if (name.endsWith("/")) continue;
    const local = entry.localOffset;
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) fail("بيانات ملف Excel غير مكتملة");
    const nameLength = bytes.readUInt16LE(local + 26);
    const extraLength = bytes.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + extraLength;
    const finish = start + entry.compressedSize;
    if (finish > bytes.length) fail("بيانات ملف Excel غير مكتملة");
    const compressed = bytes.subarray(start, finish);
    let content: Buffer;
    try { content = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES }); }
    catch { return fail("تعذر فك ضغط ملف Excel"); }
    if (content.byteLength !== entry.size) fail("حجم أحد أجزاء ملف Excel غير متطابق");
    if (crc32(content) !== entry.crc32) fail("أحد أجزاء ملف Excel تالف");
    files.set(name, content);
  }
  return files;
}

function xmlText(raw: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) fail("ملف Excel يحتوي على تعليمات XML غير مسموح بها");
  return raw;
}

function decodeXml(raw: string): string {
  const numericReference = (digits: string, radix: number) => {
    const codePoint = Number.parseInt(digits, radix);
    // XML 1.0 excludes surrogate code points, NUL, and values beyond Unicode.
    // Reject malformed workbook text as a client error instead of leaking a
    // RangeError (HTTP 500) from String.fromCodePoint.
    if (!Number.isInteger(codePoint) || codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint)
      || codePoint > 0xd7ff && codePoint < 0xe000
      || codePoint > 0xfffd && codePoint < 0x10000
      || codePoint > 0x10ffff) fail("ملف Excel يحتوي على مرجع حرف غير صالح");
    return String.fromCodePoint(codePoint);
  };
  return raw.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => numericReference(n, 16))
    .replace(/&#(\d+);/g, (_, n: string) => numericReference(n, 10))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function tagContent(xml: string, localName: string): string | null {
  const match = xml.match(new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\s*>`));
  return match?.[1] ?? null;
}

function hasFormula(xml: string): boolean {
  return /<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*(?:\/\s*>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?f\s*>)/.test(xml);
}

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) out[match[1]] = decodeXml(match[2]);
  return out;
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^([A-Z]+)/i)?.[1]?.toUpperCase();
  if (!letters) fail("عنوان خلية Excel غير صالح");
  let n = 0;
  for (const char of letters) n = n * 26 + char.charCodeAt(0) - 64;
  if (n < 1 || n > MAX_COLUMNS) fail("ملف Excel يتجاوز 80 عمودًا");
  return n - 1;
}

function excelDate(value: string, date1904: boolean): string {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return value;
  const wholeDays = Math.floor(serial);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + wholeDays * 86_400_000).toISOString().slice(0, 10);
}

function quoteCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Read literal values from the first worksheet of a bounded, unencrypted .xlsx file.
 * Formulas are refused so a stale cached value can never be silently imported. */
export function xlsxToCsv(input: Uint8Array): string {
  const files = unzip(input);
  const getXml = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) fail("ملف Excel ناقص؛ احفظه بصيغة XLSX سليمة");
    return xmlText(Buffer.from(bytes).toString("utf8"));
  };
  const workbook = getXml("xl/workbook.xml");
  const sheetTag = workbook.match(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?\s*>/);
  if (!sheetTag) fail("ملف Excel لا يحتوي على ورقة عمل");
  const sheetId = attrs(sheetTag[1])["r:id"];
  if (!sheetId) fail("تعذر تحديد ورقة العمل داخل Excel");
  const rels = getXml("xl/_rels/workbook.xml.rels");
  let target: string | null = null;
  for (const match of rels.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?\s*>/g)) {
    const a = attrs(match[1]);
    if (a.Id !== sheetId) continue;
    if (a.TargetMode === "External") fail("ورقة العمل الخارجية غير مدعومة");
    target = a.Target;
    break;
  }
  if (!target) fail("تعذر فتح ورقة العمل في Excel");
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  if (!sheetPath.startsWith("xl/") || sheetPath.split("/").includes("..")) fail("مسار ورقة العمل غير صالح");
  const sheet = getXml(sheetPath);
  const sharedXml = files.has("xl/sharedStrings.xml") ? getXml("xl/sharedStrings.xml") : "";
  const sharedStrings = [...sharedXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si\s*>/g)].map((si) =>
    [...si[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t\s*>/g)].map((t) => decodeXml(t[1])).join("")
  );
  const sheetData = tagContent(sheet, "sheetData");
  if (sheetData === null) fail("ورقة Excel لا تحتوي على بيانات");
  const rows: string[][] = [];
  for (const rowMatch of sheetData.matchAll(/<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row\s*>/g)) {
    const row = new Array<string>(0);
    for (const cellMatch of rowMatch[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\s*\/\s*>|\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c\s*>)/g)) {
      const a = attrs(cellMatch[1]);
      if (!a.r) fail("خلية Excel بدون عنوان");
      const col = columnIndex(a.r);
      const cell = cellMatch[2] ?? "";
      if (hasFormula(cell)) fail("احذف المعادلات من ملف الاستيراد واستخدم قيمًا ثابتة قبل الرفع");
      const rawValue = tagContent(cell, "v");
      let value = "";
      if (a.t === "inlineStr") {
        value = [...cell.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t\s*>/g)].map((t) => decodeXml(t[1])).join("");
      } else if (a.t === "s" && rawValue !== null) {
        const index = Number(rawValue);
        if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) fail("مرجع نص غير صالح داخل ملف Excel");
        value = sharedStrings[index];
      } else if (a.t === "e") fail("صحح خلية الخطأ في ملف Excel قبل رفعه");
      else if (a.t === "b" && rawValue !== null) value = rawValue === "1" ? "TRUE" : "FALSE";
      else if (rawValue !== null) value = decodeXml(rawValue);
      row[col] = value;
    }
    if (row.some((value) => value !== undefined && value !== "")) rows.push(row);
    if (rows.length > MAX_ROWS + 1) fail(`الحد الأقصى ${MAX_ROWS} صف في الملف الواحد`);
  }
  if (!rows.length) fail("ملف Excel مفيهوش صفوف بيانات");
  const headers = rows[0].map((v) => (v ?? "").trim().toLowerCase());
  if (headers.length > MAX_COLUMNS || headers.some((header) => !header)) fail("صف العناوين فاضي أو فيه عمود غير صالح");
  if (new Set(headers).size !== headers.length) fail("فيه عنوان عمود مكرر في الملف");
  const date1904 = /<(?:(?:[A-Za-z_][\w.-]*):)?workbookPr\b[^>]*date1904\s*=\s*"(?:1|true)"/i.test(workbook);
  const normalized = rows.map((row) => {
    const values = headers.map((header, i) => {
      const value = row[i] ?? "";
      return DATE_HEADERS.has(header) && /^\d+(?:\.\d+)?$/.test(value) ? excelDate(value, date1904) : value;
    });
    return values.map(quoteCsv).join(",");
  });
  return normalized.join("\r\n") + "\r\n";
}
