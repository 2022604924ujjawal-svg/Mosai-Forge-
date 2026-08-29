import { renderMarkdown } from './markdown.js';
import { showToast } from './utils.js';

// Rich-text clipboards use HTML as their transport, but this payload contains
// only Markdown semantics. Clay's rendered DOM, theme, syntax highlighting,
// spacing, and typography never enter the clipboard.
export function buildMarkdownClipboardContent(markdown) {
  var container = document.createElement("div");
  container.innerHTML = renderMarkdown(markdown || "");

  var elements = container.querySelectorAll("*");
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    el.removeAttribute("class");
    el.removeAttribute("style");
    el.removeAttribute("id");
    el.removeAttribute("contenteditable");
    el.removeAttribute("target");
    el.removeAttribute("rel");
    var dataNames = [];
    for (var ai = 0; ai < el.attributes.length; ai++) {
      if (el.attributes[ai].name.indexOf("data-") === 0) dataNames.push(el.attributes[ai].name);
    }
    for (var di = 0; di < dataNames.length; di++) el.removeAttribute(dataNames[di]);
  }

  return {
    html: '<meta charset="utf-8">' + container.innerHTML,
    text: container.innerText || container.textContent || "",
  };
}

function legacyCopyHtml(html) {
  var container = document.createElement("div");
  container.contentEditable = "true";
  container.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden";
  container.innerHTML = html;
  document.body.appendChild(container);

  var selection = window.getSelection();
  var savedRanges = [];
  for (var i = 0; selection && i < selection.rangeCount; i++) {
    savedRanges.push(selection.getRangeAt(i).cloneRange());
  }
  var range = document.createRange();
  range.selectNodeContents(container);
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  var copied = document.execCommand("copy");
  if (selection) {
    selection.removeAllRanges();
    for (var ri = 0; ri < savedRanges.length; ri++) selection.addRange(savedRanges[ri]);
  }
  container.remove();
  if (!copied) return Promise.reject(new Error("Formatted copy is not supported by this browser"));
  return Promise.resolve();
}

export function copyMarkdownFormatting(markdown) {
  var content = buildMarkdownClipboardContent(markdown);
  var copyPromise;

  if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
    var item = new ClipboardItem({
      "text/html": new Blob([content.html], { type: "text/html" }),
      "text/plain": new Blob([content.text], { type: "text/plain" }),
    });
    copyPromise = navigator.clipboard.write([item]).catch(function () {
      return legacyCopyHtml(content.html);
    });
  } else {
    copyPromise = legacyCopyHtml(content.html);
  }

  return copyPromise.then(function () {
    showToast("Copied Markdown formatting");
  }).catch(function (err) {
    showToast("Could not copy Markdown formatting", "warn");
    throw err;
  });
}
