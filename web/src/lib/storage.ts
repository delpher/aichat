// localStorage that never throws (private windows, blocked storage).
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

export const KEYS = {
  token: "aichat.token",
  oldToken: "aichat.adminToken", // pre-multi-user key, read once for migration
  projectDir: "aichat.projectDir",
  theme: "aichat.theme",
  navCollapsed: "aichat.navCollapsed",
};
