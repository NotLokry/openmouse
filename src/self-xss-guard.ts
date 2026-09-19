/**
 * Self-XSS deterrence for the deployed app.
 *
 * A web page cannot stop someone from running code in their own developer
 * tools — the browser exposes no such control — so this is deterrence, not a
 * security boundary. It prints the familiar "do not paste code here" banner,
 * and while developer tools appear to be open it shows a blocking notice.
 *
 * It deliberately avoids `debugger` loops and console overrides: those are
 * trivially bypassed, break legitimate debugging, and can trap users. The
 * developer-tools check is a heuristic (window vs. viewport size) and can be
 * wrong (e.g. extreme browser zoom), so the notice can be dismissed.
 *
 * Call only on production builds (see control.tsx).
 */

const WARNING_TITLE = "Stop!";
const WARNING_BODY =
  "This console is meant for developers. If someone told you to copy and paste " +
  "code here, it is a scam: pasting it can hand over your connected mouse and " +
  "your OpenMouse settings. Never paste code you do not fully understand.";
const NOTICE_HINT = "Developer tools detected. Close them to continue.";
const DISMISS_LABEL = "I understand the risk — continue";

const DETECT_THRESHOLD_PX = 160;
const CHECK_INTERVAL_MS = 1000;
const DISMISS_KEY = "openmouse.selfxss.dismissed";

let notice: HTMLElement | null = null;
let dismissed = false;

/**
 * Heuristic: when developer tools are docked, the outer window is much larger
 * than the viewport. Pure so it can be unit tested.
 */
export function devtoolsLikelyOpen(
  outerWidth: number,
  innerWidth: number,
  outerHeight: number,
  innerHeight: number,
  threshold: number = DETECT_THRESHOLD_PX,
): boolean {
  return outerWidth - innerWidth > threshold || outerHeight - innerHeight > threshold;
}

function warn(): void {
  console.log(
    `%c${WARNING_TITLE}`,
    "color:#fff;background:#b3261e;font-size:24px;font-weight:800;padding:6px 14px;border-radius:6px;",
  );
  console.log(`%c${WARNING_BODY}`, "color:inherit;font-size:15px;line-height:1.5;");
}

function showNotice(): void {
  if (notice) return;

  const root = document.createElement("div");
  root.id = "selfxss-notice";
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", WARNING_TITLE);

  const panel = document.createElement("div");
  panel.className = "selfxss-panel";

  const title = document.createElement("h2");
  title.textContent = WARNING_TITLE;

  const body = document.createElement("p");
  body.textContent = WARNING_BODY;

  const hint = document.createElement("p");
  hint.className = "selfxss-hint";
  hint.textContent = NOTICE_HINT;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "selfxss-dismiss";
  dismiss.textContent = DISMISS_LABEL;
  dismiss.addEventListener("click", () => {
    dismissed = true;
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* storage unavailable — the dismissal simply does not persist */
    }
    hideNotice();
  });

  panel.append(title, body, hint, dismiss);
  root.append(panel);
  document.body.append(root);
  notice = root;
}

function hideNotice(): void {
  notice?.remove();
  notice = null;
}

function storedDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Starts the production-only console/DevTools deterrence. Call once. */
export function startSelfXssGuard(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  dismissed = storedDismissed();
  warn();

  const check = (): void => {
    if (dismissed) return;
    if (
      devtoolsLikelyOpen(
        window.outerWidth,
        window.innerWidth,
        window.outerHeight,
        window.innerHeight,
      )
    ) {
      showNotice();
    } else {
      hideNotice();
    }
  };

  check();
  window.setInterval(check, CHECK_INTERVAL_MS);
  window.addEventListener("focus", check);
  window.addEventListener("resize", check);
}
