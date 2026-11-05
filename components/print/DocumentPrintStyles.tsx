/**
 * Print rules for commercial documents (invoices, supplier bills) on A4: page numbers and the
 * document number in the page margin, the line table's header repeated on every page, rows
 * and the totals block never split across pages, and nothing of the app's chrome printed.
 * Rendered by the page itself so the margin text can be in the document's own language.
 */
export function DocumentPrintStyles({ pageLabel, ofLabel, number }: { pageLabel: string; ofLabel: string; number: string }) {
  const q = (s: string) => JSON.stringify(s);
  return (
    <style
      // Static CSS built from the document's own labels; no user input reaches it unescaped.
      dangerouslySetInnerHTML={{
        __html: `
@media print {
  @page {
    size: A4;
    margin: 12mm 12mm 16mm 12mm;
    @bottom-center { content: ${q(pageLabel + " ")} counter(page) ${q(" " + ofLabel + " ")} counter(pages); font-size: 8pt; color: #555; }
    @bottom-right { content: ${q(number)}; font-size: 8pt; color: #555; }
  }
  .commercial-doc { max-width: none !important; margin: 0 !important; padding: 0 !important; font-size: 10pt; }
  .commercial-doc table.doc-lines { width: 100%; table-layout: auto; }
  .commercial-doc table.doc-lines thead { display: table-header-group; }
  .commercial-doc table.doc-lines tfoot { display: table-footer-group; }
  .commercial-doc table.doc-lines tr { break-inside: avoid; page-break-inside: avoid; }
  .commercial-doc .doc-keep { break-inside: avoid; page-break-inside: avoid; }
  .commercial-doc .doc-screen-only { display: none !important; }
}
`,
      }}
    />
  );
}
