import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { localizeServerMessage, requestLocale } from "@/lib/locale/server-messages";

const ARABIC = /[؀-ۿ]/;
const en = (m: string) => localizeServerMessage(m, "en");

test("Arabic stays exactly as thrown; English is translated", () => {
  assert.equal(localizeServerMessage("المورد مش موجود", "ar"), "المورد مش موجود");
  assert.equal(en("المورد مش موجود"), "Supplier not found");
  assert.equal(en("Already English"), "Already English");
});

test("template slots keep their specific values and translate nested labels", () => {
  assert.equal(en('الرصيد مش كفاية: "Mango" في COLD-1 (L-7) فيه 3 بس، والمطلوب 5'), 'Insufficient stock: "Mango" in COLD-1 (L-7) has only 3, 5 is required');
  assert.equal(en("مدة التوريد مطلوب"), "Lead time is required");
  assert.equal(en("المورد اتغيّر من واحد تاني، حدّث الشاشة وحاول تاني (النسخة الحالية: 4)"), "Supplier was changed by someone else — refresh the screen and try again (current version: 4)");
  assert.equal(en("الأوردر ORD-1 ملغي"), "Order ORD-1 is cancelled");
  assert.equal(en("حقل name مطلوب"), "Field name is required");
  // An Arabic product name in a slot is data, carried through untouched.
  assert.equal(en('"مانجو" مش صنف بيتتبع مخزونه'), '"مانجو" is not a stock-tracked product');
});

test("an unknown message is never replaced by a generic one, and loose templates never half-translate", () => {
  const unknown = "رسالة جديدة مش في الكتالوج";
  assert.equal(en(unknown), unknown);
  // "{} مطلوب" would match, but the slot is unknown Arabic: keep the whole original.
  assert.equal(en("حقل غريب جدا مطلوب"), "حقل غريب جدا مطلوب");
});

test("only an explicit Accept-Language: en selects English", () => {
  const req = (v: string | null) => ({ headers: { get: () => v } });
  assert.equal(requestLocale(req("en")), "en");
  assert.equal(requestLocale(req("en-US,en;q=0.9")), "ar");
  assert.equal(requestLocale(req(null)), "ar");
  assert.equal(requestLocale(null), "ar");
});

// --- Coverage: every Arabic message the server can throw has an English entry. -------
const ROOT = path.resolve(__dirname, "../..");
function files(dir: string, acc: string[] = []): string[] {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) files(p, acc);
    else if (f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.includes("server-messages.data")) acc.push(p);
  }
  return acc;
}
const LABEL_BUILDERS = /^(text|optText|optDecimal|days)$/;
type Found = { text: string; slots: number; at: string };
function collect(): Found[] {
  const out: Found[] = [];
  for (const file of [...files(path.join(ROOT, "lib")), ...files(path.join(ROOT, "app/api"))]) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const take = (node: ts.Node): void => {
      if (ts.isConditionalExpression(node)) { take(node.whenTrue); take(node.whenFalse); return; }
      if (ts.isParenthesizedExpression(node)) { take(node.expression); return; }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) { take(node.left); take(node.right); return; }
      const at = `${path.relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { if (ARABIC.test(node.text)) out.push({ text: node.text, slots: 0, at }); }
      else if (ts.isTemplateExpression(node)) {
        const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
        if (parts.some((p) => ARABIC.test(p))) out.push({ text: parts.join("\u0000"), slots: node.templateSpans.length, at });
      }
    };
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) && n.expression.getText(sf) === "ApiError" && n.arguments?.[1]) take(n.arguments[1]);
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (LABEL_BUILDERS.test(callee) && n.arguments[0]) take(n.arguments[0]);
        if (/errors\.push$/.test(callee) && n.arguments[0]) take(n.arguments[0]);
        if (/^(versionConflict|assertVersion)$/.test(callee)) n.arguments.forEach(take);
        if (/\.(refine|min|max|regex|int|positive|nonnegative|length|email)$/.test(callee)) n.arguments.slice(-1).forEach(take);
      }
      // zod messages reach the user through parse() → ApiError.
      if (ts.isPropertyAssignment(n) && /^(message|required_error|invalid_type_error)$/.test(n.name.getText(sf))) take(n.initializer);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
// Templates whose Arabic also comes from inside a slot expression: checked by their
// real expansions instead of a placeholder value.
const EXPANSIONS: Record<string, string[]> = {
  "الأوردر \u0000 \u0000": ["الأوردر ORD-1 ملغي", "الأوردر ORD-1 خرج بالفعل"],
  "\u0000 لازم يكون رقم \u0000 بحد أقصى \u0000 خانات عشرية": ["الكمية لازم يكون رقم موجب بحد أقصى 3 خانات عشرية", "الكمية لازم يكون رقم أكبر من صفر بحد أقصى 3 خانات عشرية"],
};

test("every Arabic server/import message in lib/ and app/api has an English translation", () => {
  const missing: string[] = [];
  for (const f of collect()) {
    const samples = EXPANSIONS[f.text] ?? [f.text.split("\u0000").map((part, i) => (i === 0 ? part : `V${i}${part}`)).join("")];
    for (const sample of samples) if (ARABIC.test(en(sample))) missing.push(`${f.at}  ${sample}`);
  }
  assert.deepEqual([...new Set(missing)], [], `messages without English:\n${missing.join("\n")}`);
});
