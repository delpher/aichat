import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// jsdom lacks these
URL.createObjectURL ??= () => "blob:test";
URL.revokeObjectURL ??= () => {};
Element.prototype.scrollIntoView ??= function () {};
