import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileInfo } from "../api/types";
import { adminSession, fakeApi, renderWithChat } from "../test/render";
import { Attachments, Lightbox } from "./Attachments";

const doc: FileInfo = { id: "file1234567890abcd", name: "plan.md", mime: "text/markdown", size: 60_000 };
const pic: FileInfo = { id: "pic1234567890abcdef", name: "dot.png", mime: "image/png", size: 4 };

function linkClicks() {
  const hrefs: { href: string; download: string }[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    hrefs.push({ href: this.getAttribute("href")!, download: this.download });
  });
  return { hrefs, click };
}

describe("saving attachments (issue #61)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("saves a file through a download link from the broker, not a blob:", async () => {
    const { hrefs, click } = linkClicks();
    const send = vi.fn(async () => ({ url: "/dl/files/file1234567890abcd?exp=1&sig=s" }));
    renderWithChat(<Attachments files={[doc]} />, { api: fakeApi({ send }) });
    await userEvent.click(screen.getByRole("button", { name: /plan\.md/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith("POST", "/api/files/file1234567890abcd/link");
    expect(hrefs).toEqual([{ href: "/dl/files/file1234567890abcd?exp=1&sig=s", download: "plan.md" }]);
  });

  it("asks the admin API for the link in the admin view, also from the image viewer", async () => {
    const { hrefs, click } = linkClicks();
    const send = vi.fn(async () => ({ url: "/dl/files/pic1234567890abcdef?exp=1&sig=s" }));
    renderWithChat(<Lightbox url="blob:shown" file={pic} onClose={() => {}} />, { api: fakeApi({ send }), session: adminSession });
    await userEvent.click(screen.getByRole("button", { name: "Зберегти" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith("POST", "/admin/api/files/pic1234567890abcdef/link");
    expect(hrefs[0].href).toBe("/dl/files/pic1234567890abcdef?exp=1&sig=s");
  });
});
