/**
 * Shared "Outrun" chrome for the platform's user-facing auth/interstitial pages
 * — the shared-password login wall, sign-in errors, the archived-app notice.
 *
 * These are the only HTML the edge renders to untrusted app users, and they run
 * under a `default-src 'none'` CSP (no scripts, no external fonts or images), so
 * everything here is hand-written: the synthwave grid floor and duotone glow are
 * pure CSS, and the azx wordmark is inlined SVG. Tokens mirror the portal's
 * "Outrun" theme — cyan #2de2e6 ↔ magenta #ff2bd6 on near-black #08090b, bridged
 * by the logo's slate #8f99ac.
 *
 * The edge stays dependency-minimal (project plan §6): no CSS framework, no JS.
 */

/** Base CSP for these pages. The password page appends `form-action 'self'`. */
export const AUTH_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Escape the five HTML-significant characters for safe attribute/text interpolation. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The azx wordmark — inlined so it tints via CSS (letterforms ink, x-chevron slate). */
const LOGO_SVG = `<svg class="logo" viewBox="0 0 800 288" role="img" aria-label="azx">
<path class="ink" d="M348.35 273.006L315.288 251.289L502.29 10.8581L531.219 35.6768L348.35 273.006ZM331.302 285.415C317.871 285.415 311.156 278.693 311.156 265.25C311.156 252.151 317.871 245.602 331.302 245.602H517.788C531.219 245.602 537.934 252.151 537.934 265.25C537.934 278.693 531.219 285.415 517.788 285.415H331.302ZM328.203 42.3985C314.772 42.3985 308.056 35.8492 308.056 22.7504C308.056 9.30694 314.772 2.58521 328.203 2.58521H515.205C528.291 2.58521 534.835 9.30694 534.835 22.7504C534.835 35.8492 528.291 42.3985 515.205 42.3985H328.203Z"/>
<path class="ink" d="M137.41 288C111.237 288 87.8185 281.796 67.1553 269.386C46.4922 256.632 30.1338 239.397 18.0803 217.681C6.02676 195.964 0 171.49 0 144.259C0 116.682 6.19896 92.036 18.5969 70.3197C31.3392 48.6033 48.5585 31.5404 70.2548 19.1311C91.9512 6.37703 116.403 0 143.609 0C170.471 0 194.578 6.37703 215.93 19.1311C237.627 31.5404 254.674 48.6033 267.072 70.3197C279.814 92.036 286.357 116.682 286.702 144.259L269.138 153.049C269.138 178.557 263.283 201.48 251.574 221.817C240.21 242.155 224.54 258.356 204.566 270.42C184.936 282.14 162.55 288 137.41 288ZM143.609 248.704C162.895 248.704 179.942 244.223 194.751 235.261C209.904 225.954 221.785 213.372 230.395 197.515C239.349 181.659 243.826 163.907 243.826 144.259C243.826 124.266 239.349 106.514 230.395 91.0019C221.785 75.1455 209.904 62.5638 194.751 53.2568C179.942 43.9498 162.895 39.2963 143.609 39.2963C124.668 39.2963 107.449 43.9498 91.9512 53.2568C76.7982 62.5638 64.7447 75.1455 55.7906 91.0019C46.8366 106.514 42.3595 124.266 42.3595 144.259C42.3595 163.907 46.8366 181.659 55.7906 197.515C64.7447 213.372 76.7982 225.954 91.9512 235.261C107.449 244.223 124.668 248.704 143.609 248.704ZM264.489 285.415C258.29 285.415 252.952 283.519 248.475 279.727C244.342 275.591 242.276 270.248 242.276 263.699V178.384L252.091 133.401L286.702 144.259V263.699C286.702 270.248 284.635 275.591 280.503 279.727C276.37 283.519 271.032 285.415 264.489 285.415Z"/>
<path class="ink" d="M770.426 283.864C773.181 284.898 776.625 285.415 780.758 285.415C785.235 285.415 789.367 283.864 793.155 280.762C797.288 277.659 799.527 273.523 799.871 268.352C800.56 262.837 798.493 257.322 793.672 251.806L721.724 161.692L695.432 192.847L762.161 276.625C764.916 280.072 767.671 282.485 770.426 283.864Z"/>
<path class="ink" d="M698.678 90.8252L760.094 11.8923C762.505 8.4453 765.26 6.03237 768.36 4.65356C771.459 3.27474 774.559 2.58533 777.658 2.58533C784.201 2.58533 789.023 4.65356 792.122 8.79001C795.566 12.5818 797.116 17.2353 796.771 22.7505C796.771 28.2658 794.877 33.4364 791.089 38.2622L725.048 121.46L698.678 90.8252Z"/>
<path class="chev" d="M678.729 171.877L704.375 141.653L680.356 114.373L680.18 114.599L596.338 9.82411C591.861 4.99825 586.351 2.58533 579.808 2.58533C573.609 2.58533 568.788 4.65356 565.344 8.79001C561.9 12.5818 560.178 17.0629 560.178 22.2335C560.178 27.404 562.244 32.4022 566.377 37.2281L650.99 142.849L564.827 250.772C560.695 255.943 558.628 261.113 558.628 266.284C558.628 271.455 560.35 275.936 563.794 279.727C567.582 283.519 572.404 285.415 578.258 285.415C584.802 285.415 589.967 283.174 593.756 278.693L678.432 171.504L678.729 171.877Z"/>
</svg>`;

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
       font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
       background: #08090b; color: #eef1f0; position: relative; overflow: hidden; }
.bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.bg::before { content: ""; position: absolute; left: 50%; bottom: -22%; width: 260%; height: 78%;
              transform: translateX(-50%) perspective(45vh) rotateX(64deg);
              background-image:
                linear-gradient(to right, rgba(45,226,230,.30) 1px, transparent 1px),
                linear-gradient(to bottom, rgba(255,43,214,.22) 1px, transparent 1px);
              background-size: 46px 46px;
              -webkit-mask-image: linear-gradient(to top, #000 0%, transparent 72%);
              mask-image: linear-gradient(to top, #000 0%, transparent 72%); }
.bg::after { content: ""; position: absolute; inset: 0; filter: blur(8px);
             background:
               radial-gradient(46vw 40vh at 84% -6%, rgba(45,226,230,.16), transparent 60%),
               radial-gradient(42vw 40vh at 8% 110%, rgba(255,43,214,.16), transparent 60%); }
.card { position: relative; z-index: 1; width: min(92vw, 372px); padding: 34px 30px;
        border-radius: 16px; background: rgba(13,15,18,.86); -webkit-backdrop-filter: blur(6px);
        backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,.10);
        box-shadow: 0 20px 60px rgba(0,0,0,.5), 0 0 0 1px rgba(45,226,230,.06); text-align: center; }
.logo { height: 28px; width: auto; display: block; margin: 0 auto 22px; }
.logo .ink { fill: #eef1f0; } .logo .chev { fill: #8f99ac; }
h1 { margin: 0 0 8px; font-size: 19px; font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }
p.sub { margin: 0 0 22px; color: #a4abad; font-size: 13.5px; }
p.note { margin: 16px 0 0; color: #6a7176; font-size: 12.5px; }
form { text-align: left; }
label { display: block; margin: 0 0 6px; font-size: 11px; color: #a4abad; letter-spacing: .12em;
        text-transform: uppercase; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
input { width: 100%; padding: 11px 13px; border-radius: 10px; border: 1px solid rgba(255,255,255,.12);
        background: #08090b; color: #eef1f0; font-size: 15px;
        font-family: ui-monospace, "SF Mono", Menlo, monospace; }
input:focus-visible { outline: 2px solid #2de2e6; outline-offset: 1px; border-color: transparent; }
button { width: 100%; margin-top: 18px; padding: 12px; border: 0; border-radius: 10px; cursor: pointer;
         background: #2de2e6; color: #04201f; font-size: 15px; font-weight: 700;
         display: inline-flex; align-items: center; justify-content: center; gap: 8px;
         box-shadow: 0 0 0 1px rgba(45,226,230,.4), 0 0 16px rgba(45,226,230,.30); }
button:hover { filter: brightness(1.06); }
.chevg { width: 14px; height: 14px; }
.chevg path { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
p.err { margin: 0 0 18px; padding: 10px 13px; border-radius: 10px; text-align: left; font-size: 13px;
        background: rgba(255,106,85,.12); color: #ff8d7a; border: 1px solid rgba(255,106,85,.28); }
.alt { margin: 20px 0 0; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.08);
       text-align: center; font-size: 13px; color: #a4abad; }
.alt a { color: #2de2e6; text-decoration: none; }
.alt a:hover { text-decoration: underline; }
p.foot { margin: 18px 0 0; font-size: 11px; color: #6a7176; text-align: center;
         font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .12em; }
.vh { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

/**
 * Wrap page-specific content in the shared chrome. `title`/`heading`/`sub` are
 * escaped as text; `bodyHtml`/`footHtml` are caller-built raw HTML (escape your
 * own interpolations there). Defaults to a "Protected by AZX" footer.
 */
export function renderAuthPage(opts: {
  title: string;
  heading: string;
  sub?: string;
  bodyHtml?: string;
  footHtml?: string;
}): string {
  const sub = opts.sub ? `<p class="sub">${escapeHtml(opts.sub)}</p>` : "";
  const body = opts.bodyHtml ?? "";
  const foot = opts.footHtml ?? `<p class="foot">Protected by AZX</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="bg" aria-hidden="true"></div>
<main class="card">
${LOGO_SVG}
<h1>${escapeHtml(opts.heading)}</h1>
${sub}
${body}
${foot}
</main>
</body>
</html>
`;
}
