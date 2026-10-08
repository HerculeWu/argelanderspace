// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MailHeader } from "@argelanderspace/contracts";
import i18n from "../src/i18n";
import { type MailActionsEnv, useMailActions } from "../src/mail/useMailActions";

const ref = { accountId: "acc-aaaaaaaaaaaa", folder: "Trash", uid: 9 };
const header = { uid: 9, subject: "Old", unread: false, starred: false } as MailHeader;
let requests = 0;
let release: () => void = () => {};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      requests++;
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response(JSON.stringify({ outcome: "deleted", destination: null, uid: null, uidValidity: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const env: MailActionsEnv = {
  find: () => header,
  patch: () => {},
  remove: () => () => {},
  bumpUnread: () => {},
  uidValidity: () => 7,
  folderRole: () => "trash",
  folderName: (_a, f) => f,
  closeIfOpen: () => () => {},
  refreshLoaded: async () => true,
  refreshFolders: async () => true,
  refreshSearch: () => false,
  trashFolder: () => "Trash",
};

test("confirming a permanent delete twice from the same render sends ONE request (a synchronous guard, not just busy)", async () => {
  const { result } = renderHook(() => useMailActions(env));
  act(() => result.current.requestDelete(ref));
  expect(result.current.confirm?.busy).toBe(false);
  // Both calls come from the same closure: neither can see busy=true, only a ref can stop the second.
  const confirm = result.current.confirmPermanent;
  await act(async () => {
    void confirm();
    void confirm();
    void confirm();
  });
  expect(requests).toBe(1);
  await act(async () => release());
});
