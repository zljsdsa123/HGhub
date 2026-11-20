import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import type { Detail, Post } from "../../shared/api/types";

type Args = {
  videoIds: number[];
  mode: "home" | "context";
  kind: "video" | "post";
  accountScope: string;
  lineEpoch: number;
  originEpoch?: number;
  filtering: boolean;
  revision: number;
  blockReason: (tags: readonly string[] | undefined) => string | null;
  checked: Record<string, boolean>;
  tagErrors: Record<string, string>;
};

/**
 * Detail/post reads shared by the feed and its panels.
 *
 * The cache key includes account scope and line epoch so a response from a
 * previous login or line can never be published into the current one.
 */
export function useFeedDetails({
  videoIds, mode, kind, accountScope, lineEpoch, originEpoch = 0, filtering, revision,
  blockReason, checked, tagErrors,
}: Args) {
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const [posts, setPosts] = useState<Record<number, Post>>({});
  const detailRequests = useRef(new Map<string, Promise<Detail>>());
  const cacheScope = `${accountScope}:${originEpoch}`;
  const prevScopeRef = useRef(cacheScope);
  if (prevScopeRef.current !== cacheScope) {
    prevScopeRef.current = cacheScope;
    detailsRef.current = {};
    setDetails({});
    setPosts({});
  }

  const requestDetail = useCallback((id: number) => {
    const key = `${accountScope}:${lineEpoch}:${id}`;
    let request = detailRequests.current.get(key);
    if (!request) {
      request = api.video(id).finally(() => {
        if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
      });
      detailRequests.current.set(key, request);
      if (detailRequests.current.size > 12) {
        detailRequests.current.delete(detailRequests.current.keys().next().value!);
      }
    }
    return request;
  }, [accountScope, lineEpoch]);

  const effectiveVideoIds = useMemo(
    () => mode === "context" && filtering ? videoIds.filter(id => {
      const key = `${accountScope}:${lineEpoch}:${kind}:${id}`;
      if (!checked[key]) return true;
      if (tagErrors[key]) return true;
      return !blockReason(kind === "post" ? posts[id]?.tags : details[id]?.tags);
    }) : videoIds,
    [mode, filtering, revision, videoIds, accountScope, lineEpoch, kind, checked, tagErrors, posts, details, blockReason],
  );

  return {
    details,
    setDetails,
    detailsRef,
    posts,
    setPosts,
    requestDetail,
    effectiveVideoIds,
  };
}
