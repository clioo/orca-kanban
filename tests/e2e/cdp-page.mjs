// A small CDP client for one page target (Orca's board tab is a <webview>,
// which Playwright's connectOverCDP does not list): evaluate, wait, real
// mouse clicks and typing through Input.*, screenshots. Never focuses or
// shows a window.
export async function attachToPage(cdpPort, match) {
  const deadline = Date.now() + 20_000;
  let target;
  while (!target) {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = list.find((t) => (t.type === "webview" || t.type === "page") && match(t.url));
    if (!target) {
      if (Date.now() > deadline) throw new Error(`no page matching in ${JSON.stringify(list.map((t) => t.url))}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");

  const page = {
    url: target.url,
    send,
    async evaluate(fn, ...args) {
      const expression = `(${fn})(...${JSON.stringify(args)})`;
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async waitFor(fn, args = [], { timeout = 20_000, what = "condition" } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await page.evaluate(fn, ...args);
          if (last) return last;
        } catch (error) {
          last = error.message;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    },
    /** The center of the first visible element matching a CSS selector and,
     *  optionally, containing text (or with that aria-label). */
    async locate(selector, text) {
      return page.waitFor(
        (sel, txt) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
          };
          const els = [...document.querySelectorAll(sel)].filter(visible).filter((el) =>
            txt == null ? true : (el.getAttribute("aria-label") ?? "").includes(txt) || el.textContent.includes(txt),
          );
          const el = els[0];
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        [selector, text ?? null],
        { what: `${selector}${text ? ` "${text}"` : ""}` },
      );
    },
    async click(selector, text) {
      const { x, y } = await page.locate(selector, text);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    /** Real pointer drag from one element to another. */
    async drag(from, to) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        await new Promise((r) => setTimeout(r, 30));
      }
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
    },
    async type(selector, text, label) {
      await page.click(selector, label);
      await page.evaluate(() => {
        const el = document.activeElement;
        if (el && "select" in el) el.select();
      });
      await send("Input.insertText", { text });
    },
    async press(key) {
      const codes = { Enter: 13, Escape: 27, Tab: 9 };
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: codes[key] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: codes[key] });
    },
    async text() {
      return page.evaluate(() => document.body.innerText);
    },
    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    async reload() {
      await send("Page.reload", { ignoreCache: true });
    },
    close() {
      ws.close();
    },
  };
  return page;
}
