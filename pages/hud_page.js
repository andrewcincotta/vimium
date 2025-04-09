import "../lib/chrome_api_stubs.js";
import "../lib/utils.js";
import "../lib/dom_utils.js";
import "../lib/settings.js";
import "../lib/keyboard_utils.js";
import "../lib/find_mode_history.js";
import * as UIComponentMessenger from "./ui_component_messenger.js";

let findMode = null;

// Chrome creates a unique port for each MessageChannel, so there's a race condition between
// JavaScript messages of Vimium and browser messages during style recomputation. This duration was
// determined empirically. See https://github.com/philc/vimium/pull/3277#discussion_r283080348
const TIME_TO_WAIT_FOR_IPC_MESSAGES = 17;

// Set the input element's text, and move the cursor to the end.
function setTextInInputElement(inputElement, text) {
  inputElement.textContent = text;
  // Move the cursor to the end. Based on one of the solutions here:
  // http://stackoverflow.com/questions/1125292/how-to-move-cursor-to-end-of-contenteditable-entity
  const range = document.createRange();
  range.selectNodeContents(inputElement);
  range.collapse(false);
  const selection = globalThis.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function onKeyEvent(event) {
  // Handle <Enter> on "keypress", and other events on "keydown"; this avoids interence with CJK
  // translation (see #2915 and #2934).
  let rawQuery;
  if ((event.type === "keypress") && (event.key !== "Enter")) {
    return null;
  }
  if ((event.type === "keydown") && (event.key === "Enter")) {
    return null;
  }

  const inputElement = document.getElementById("hud-find-input");
  if (inputElement == null) { // Don't do anything if we're not in find mode.
    return;
  }

  if (
    (KeyboardUtils.isBackspace(event) && (inputElement.textContent.length === 0)) ||
    (event.key === "Enter") || KeyboardUtils.isEscape(event)
  ) {
    inputElement.blur();
    UIComponentMessenger.postMessage({
      name: "hideFindMode",
      exitEventIsEnter: event.key === "Enter",
      exitEventIsEscape: KeyboardUtils.isEscape(event),
    });
  } else if (event.key === "ArrowUp") {
    if (rawQuery = FindModeHistory.getQuery(findMode.historyIndex + 1)) {
      findMode.historyIndex += 1;
      if (findMode.historyIndex === 0) {
        findMode.partialQuery = findMode.rawQuery;
      }
      setTextInInputElement(inputElement, rawQuery);
      findMode.executeQuery();
    }
  } else if (event.key === "ArrowDown") {
    findMode.historyIndex = Math.max(-1, findMode.historyIndex - 1);
    rawQuery = 0 <= findMode.historyIndex
      ? FindModeHistory.getQuery(findMode.historyIndex)
      : findMode.partialQuery;
    setTextInInputElement(inputElement, rawQuery);
    findMode.executeQuery();
  } else {
    return;
  }

  DomUtils.suppressEvent(event);
  return false;
}

// Navigator.clipboard is only available in secure contexts. Show a warning when clipboard actions
// fail on non-HTTPS sites. See #4572.
function ensureClipboardIsAvailable() {
  if (!navigator.clipboard) {
    UIComponentMessenger.postMessage({ name: "showClipboardUnavailableMessage" });
    return false;
  }
  return true;
}

const handlers = {
  show(data) {
    document.getElementById("hud").textContent = data.text;
    document.getElementById("hud").classList.add("vimium-ui-component-visible");
    document.getElementById("hud").classList.remove("vimium-ui-component-hidden");
    document.getElementById("hud").classList.remove("hud-find");
  },
  hidden() {
    // We get a flicker when the HUD later becomes visible again (with new text) unless we reset its
    // contents here.
    document.getElementById("hud").textContent = "";
    document.getElementById("hud").classList.add("vimium-ui-component-hidden");
    document.getElementById("hud").classList.remove("vimium-ui-component-visible");
  },

  showFindMode(data) {
    let executeQuery;
    const hud = document.getElementById("hud");
    hud.classList.add("hud-find");

    const inputElement = document.createElement("span");
    // NOTE(mrmr1993): Chrome supports non-standard "plaintext-only", which is what we *really*
    // want.
    try {
      inputElement.contentEditable = "plaintext-only";
    } catch (error) { // Fallback to standard-compliant version.
      inputElement.contentEditable = "true";
    }
    inputElement.id = "hud-find-input";
    hud.appendChild(inputElement);

    inputElement.addEventListener(
      "input",
      executeQuery = function (event) {
        // On Chrome when IME is on, the order of events is:
        //   keydown, input.isComposing=true, keydown, input.true, ..., keydown, input.true, compositionend;
        // while on Firefox, the order is: keydown, input.true, ..., input.true, keydown, compositionend, input.false.
        // Therefore, check event.isComposing here, to avoid window focus changes during typing with
        // IME, since such changes will prevent normal typing on Firefox (see #3480)
        if (Utils.isFirefox() && event.isComposing) {
          return;
        }
        // Replace \u00A0 (&nbsp;) with a normal space.
        findMode.rawQuery = inputElement.textContent.replace("\u00A0", " ");
        UIComponentMessenger.postMessage({ name: "search", query: findMode.rawQuery });
      },
    );

    const countElement = document.createElement("span");
    countElement.id = "hud-match-count";
    countElement.style.float = "right";
    hud.appendChild(countElement);
    Utils.setTimeout(TIME_TO_WAIT_FOR_IPC_MESSAGES, function () {
      // On Firefox, the page must first be focused before the HUD input element can be focused.
      // #3460.
      if (Utils.isFirefox()) {
        globalThis.focus();
      }
      inputElement.focus();
    });

    findMode = {
      historyIndex: -1,
      partialQuery: "",
      rawQuery: "",
      executeQuery,
    };
  },

  updateMatchesCount({ matchCount, showMatchText }) {
    const countElement = document.getElementById("hud-match-count");
    // Don't do anything if we're not in find mode.
    if (countElement == null) return;

    if (Utils.isFirefox()) {
      document.getElementById("hud-find-input").focus();
    }
    const countText = matchCount > 0
      ? ` (${matchCount} Match${matchCount === 1 ? "" : "es"})`
      : " (No matches)";
    countElement.textContent = showMatchText ? countText : "";
  },

  copyToClipboard(message) {
    if (!this.ensureClipboardIsAvailable()) return;
    Utils.setTimeout(TIME_TO_WAIT_FOR_IPC_MESSAGES, async function () {
      const focusedElement = document.activeElement;
      // In Chrome, if we do not focus the current window before invoking navigator.clipboard APIs,
      // the error "DOMException: Document is not focused." is thrown.
      globalThis.focus();

      // Replace nbsp; characters with space. See #2217.
      const value = message.data.replace(/\xa0/g, " ");
      await navigator.clipboard.writeText(value);

      if (focusedElement != null) focusedElement.focus();
      globalThis.parent.focus();
      UIComponentMessenger.postMessage({ name: "unfocusIfFocused" });
    });
  },

  pasteFromClipboard() {
    if (!this.ensureClipboardIsAvailable()) return;
    Utils.setTimeout(TIME_TO_WAIT_FOR_IPC_MESSAGES, async function () {
      const focusedElement = document.activeElement;
      // In Chrome, if we do not focus the current window before invoking navigator.clipboard APIs,
      // the error "DOMException: Document is not focused." is thrown.
      globalThis.focus();

      let value = await navigator.clipboard.readText();
      // Replace nbsp; characters with space. See #2217.
      value = value.replace(/\xa0/g, " ");

      if (focusedElement != null) focusedElement.focus();
      globalThis.parent.focus();
      UIComponentMessenger.postMessage({ name: "pasteResponse", data: value });
    });
  },
};

function init() {
  // Manually inject custom user styles.
  document.addEventListener("DOMContentLoaded", async () => {
    await Settings.onLoaded();
    DomUtils.injectUserCss();
  });

  document.addEventListener("keydown", onKeyEvent);
  document.addEventListener("keypress", onKeyEvent);

  UIComponentMessenger.init();
  UIComponentMessenger.registerHandler(async function (event) {
    await Utils.populateBrowserInfo();
    const handler = handlers[event.data.name];
    Utils.assert(handler != null, "Unrecognized message type.", event.data);
    return handler(event.data);
  });

  FindModeHistory.init();
}

const testEnv = globalThis.window == null;
if (!testEnv) {
  init();
}
