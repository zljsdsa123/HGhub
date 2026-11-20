export type PostHotSource = {
  hot?: number | null;
  counts?: { hot?: number | null } | null;
} | null | undefined;

/** 详情接口有时把 hot 置空，只把实际热度放在 counts.hot。 */
export function postHot(post: PostHotSource): number {
  return post?.hot ?? post?.counts?.hot ?? 0;
}
