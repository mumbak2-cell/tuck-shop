/** Escape user-controlled strings before embedding in HTML templates. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

/**
 * Open a print window and populate it by cloning a DOM element's subtree.
 * Avoids innerHTML → document.write, which is an XSS vector if any child
 * contains unsanitized user data.
 */
export function printElement(
  el: HTMLElement,
  title: string,
  extraStyles = "",
) {
  const w = window.open("", "_blank", "width=350,height=600");
  if (!w) return;

  w.document.write(
    "<!DOCTYPE html><html><head><title>" + escapeHtml(title) + "</title>" +
    "<style>body{margin:0;padding:0}@page{size:80mm auto;margin:0}" + extraStyles + "</style>" +
    "</head><body></body></html>"
  );
  w.document.close();

  const clone = el.cloneNode(true) as HTMLElement;
  w.document.body.appendChild(w.document.adoptNode(clone));

  setTimeout(() => {
    w.print();
    w.close();
  }, 300);
}
