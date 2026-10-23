/** tests/browser-history.ts (installed by tests/setup.ts): history writes fire no `hashchange`, as in a browser. */
import { afterEach, expect, it } from "vitest";

const nextTimers = () => new Promise((resolve) => setTimeout(resolve, 20));
afterEach(() => window.history.replaceState(null, "", "/"));

it("pushState and replaceState that change the fragment fire no hashchange; assigning location.hash still does", async () => {
  const seen: string[] = [];
  const listen = (event: HashChangeEvent) => seen.push(new URL(event.newURL).hash);
  window.addEventListener("hashchange", listen);
  try {
    window.history.pushState(null, "", "/#explore/A");
    window.history.replaceState(null, "", "/#explore/B");
    await nextTimers();
    expect(seen).toEqual([]);
    window.location.hash = "#explore/C"; // the person edits the address
    await nextTimers();
    expect(seen).toEqual(["#explore/C"]);
  } finally {
    window.removeEventListener("hashchange", listen);
  }
});
