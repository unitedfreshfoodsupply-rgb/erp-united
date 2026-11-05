import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceQuery, withListPatch, withParams } from "@/lib/hooks/urlQuery";

test("withParams: sets values, removes null / undefined / empty, keeps everything else", () => {
  const next = withParams("?tab=invoices&q=old&page=3", { q: "فندق النيل", page: null, status: "", from: undefined, limit: 50 });
  assert.equal(next.get("tab"), "invoices");
  assert.equal(next.get("q"), "فندق النيل");
  assert.equal(next.has("page"), false);
  assert.equal(next.has("status"), false);
  assert.equal(next.get("limit"), "50");
});

test("withListPatch: prefixed keys, and any change but paging goes back to page 1", () => {
  const search = "?tab=journals&j_q=cash&j_page=4&i_page=2";
  const filtered = withListPatch(search, { status: "posted" }, "j_");
  assert.equal(filtered.get("j_status"), "posted");
  assert.equal(filtered.get("j_q"), "cash", "the search stays");
  assert.equal(filtered.has("j_page"), false, "a filter change starts again at page 1");
  assert.equal(filtered.get("i_page"), "2", "another list on the page keeps its page");
  assert.equal(filtered.get("tab"), "journals");
  const paged = withListPatch(search, { page: 5 }, "j_");
  assert.equal(paged.get("j_page"), "5");
  assert.equal(withListPatch("?q=x&page=2", { q: null, page: null }).toString(), "");
});

test("two quick changes both stick: each builds on the address as it is, not on a stale copy", () => {
  const location = { pathname: "/sales/invoices", search: "", hash: "" };
  const calls: string[] = [];
  const g = globalThis as unknown as { window?: unknown };
  const before = g.window;
  g.window = {
    location,
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        calls.push(url);
        const u = new URL(url, "http://x");
        location.search = u.search;
      },
    },
  };
  try {
    replaceQuery(withListPatch((g.window as { location: typeof location }).location.search, { q: "hotel" }));
    replaceQuery(withListPatch((g.window as { location: typeof location }).location.search, { status: "open" }));
    assert.deepEqual(calls, ["/sales/invoices?q=hotel", "/sales/invoices?q=hotel&status=open"]);
    replaceQuery(withListPatch(location.search, { q: null, status: null }));
    assert.equal(calls.at(-1), "/sales/invoices", "an empty query string leaves no bare '?'");
  } finally {
    g.window = before;
  }
});
