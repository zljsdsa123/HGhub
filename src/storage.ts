export const STORAGE_KEYS = {
  app: "hghubx_app_v1",
  swipeEp: "hghubx_swipe_ep_v2",
  theme: "hghubx_theme",
  autoLine: "hghubx_auto_line",
} as const;

type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];

// 旧名称仅用于升级迁移，运行期始终向 HGhubX 的键写入。
const LEGACY_KEYS: Record<StorageKey, string> = {
  hghubx_app_v1: "hghub_app_v1",
  hghubx_swipe_ep_v2: "hghub_swipe_ep_v2",
  hghubx_theme: "hghub_theme",
  hghubx_auto_line: "hg.autoLine",
};

/** 新键优先；确认旧数据已写入新键后才删除旧键。存储写入失败仍可读取旧数据。 */
export function readStorage(key: StorageKey): string | null {
  try {
    const legacyKey = LEGACY_KEYS[key];
    const current = localStorage.getItem(key);
    if (current !== null) {
      try { localStorage.removeItem(legacyKey); } catch { /* 下次启动重试清理 */ }
      return current;
    }
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      localStorage.setItem(key, legacy);
      if (localStorage.getItem(key) === legacy) localStorage.removeItem(legacyKey);
    } catch { /* 配额不足或禁止写入时保留旧数据，下次启动重试 */ }
    return legacy;
  } catch {
    return null;
  }
}
