import "./style.css";

// The bare minimum of a hosted AZX app: static HTML/CSS plus a little JS that
// runs in the browser. Setting this text from script proves the bundle's
// JavaScript actually executed after the edge served it.
const status = document.querySelector<HTMLParagraphElement>("#status");
if (status) {
  status.textContent = "This page is served from a deployed AZX bundle.";
}
