import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFile } from "../hooks/useFileUrl";
import { fakeApi } from "../test/render";
import { downloadText } from "./exportRoom";
import { KEEP_BLOB_MS, saveBlob } from "./saveFile";

describe("saving a file (issue #61)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function watch() {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return click;
  }

  it("keeps the blob while a save dialog may still be open, then frees it", () => {
    const click = watch();
    saveBlob(new Blob(["x"]), "a.md");
    expect(click).toHaveBeenCalled();
    vi.advanceTimersByTime(60_000); // a minute in the save dialog
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(KEEP_BLOB_MS);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("is how both the room export and attachments are saved", async () => {
    watch();
    downloadText("# #lobby", "x.md");
    await downloadFile(fakeApi({ blob: vi.fn(async () => new Blob(["y"])) }), "/api/files/f1", "plan.md");
    vi.advanceTimersByTime(30_000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
