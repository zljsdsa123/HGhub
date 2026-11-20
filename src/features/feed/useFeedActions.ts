import { useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { Detail, Episode, Post, User } from "../../shared/api/types";
import { detailEpisodeCount } from "../../shared/model/favoriteProgress";
import type { Toast } from "../../shared/model/store";
import type { VideoHandle } from "../playback";

export type FeedMeta = {
  title: string;
  cover: string;
  desc: string;
  author: string;
  authorId: number;
  tags: string[];
  score: number;
  like: number;
  comment: number;
  collect: number;
  episodes: Episode[];
};

type ActionContext = {
  accountScope: string;
  lineEpoch: number;
  id: number;
  ep: number;
  kind: "video" | "post";
};

type Args = {
  videoRef: RefObject<VideoHandle | null>;
  mounted: MutableRefObject<boolean>;
  actionContext: MutableRefObject<ActionContext>;
  accountScope: string;
  lineEpoch: number;
  curId: number;
  curEp: number;
  kind: "video" | "post";
  meta: FeedMeta;
  detail?: Detail;
  posts: Record<number, Post>;
  user: User | null;
  setLoginOpen: (open: boolean) => void;
  follows: number[];
  isLiked: (id: number, ep: number, kind?: "video" | "post") => boolean;
  isFav: (id: number, kind?: "video" | "post") => boolean;
  setLiked: (kind: "video" | "post", id: number, ep: number, on: boolean) => Promise<void>;
  setCollected: (kind: "video" | "post", id: number, on: boolean, knownEpisodes?: number) => Promise<void>;
  setFollowing: (uid: number, on: boolean) => Promise<void>;
  actionPending: (key: string) => boolean;
  toast: (msg: string, icon?: Toast["icon"]) => void;
};

export function useFeedActions({
  videoRef, mounted, actionContext, accountScope, lineEpoch, curId, curEp, kind, meta, detail, posts,
  user, setLoginOpen, follows, isLiked, isFav, setLiked, setCollected, setFollowing, actionPending, toast,
}: Args) {
  const [heartBurst, setHeartBurst] = useState(0);
  const pendingActions = useRef(new Set<string>());

  const liked = isLiked(curId, curEp, kind);
  const collected = isFav(curId, kind);
  const likeActionKey = `like:${kind}:${curId}:${curEp}`;
  const collectActionKey = `collect:${kind}:${curId}`;
  const followActionKey = `follow:${meta.authorId > 0 ? meta.authorId : 0}`;
  const likePending = actionPending(likeActionKey);
  const collectPending = actionPending(collectActionKey);
  const followPending = actionPending(followActionKey);

  const actionIsCurrent = () => mounted.current && actionContext.current.accountScope === accountScope && actionContext.current.lineEpoch === lineEpoch
    && actionContext.current.id === curId && actionContext.current.ep === curEp && actionContext.current.kind === kind;

  const onLike = async () => {
    const pendingKey = `${accountScope}:${likeActionKey}`;
    if (!curId || likePending || pendingActions.current.has(pendingKey)) return;
    pendingActions.current.add(pendingKey);
    const on = !liked;
    try {
      await setLiked(kind, curId, curEp, on);
      if (!actionIsCurrent()) return;
      if (on) setHeartBurst((n) => n + 1);
      toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "点赞失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const onFav = async () => {
    const pendingKey = `${accountScope}:${collectActionKey}`;
    if (!curId || collectPending || pendingActions.current.has(pendingKey)) return;
    pendingActions.current.add(pendingKey);
    const on = !collected;
    const knownEpisodes = kind === "video" ? (detail ? detailEpisodeCount(detail) : meta.episodes.length) : undefined;
    try {
      await setCollected(kind, curId, on, knownEpisodes);
      if (actionIsCurrent()) toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "收藏失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const onFollow = async () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    const pendingKey = `${accountScope}:${followActionKey}`;
    if (!uid || followPending || pendingActions.current.has(pendingKey)) return;
    if (!user) { setLoginOpen(true); return; }
    pendingActions.current.add(pendingKey);
    const on = !follows.includes(uid);
    try {
      await setFollowing(uid, on);
      if (actionIsCurrent()) toast(on ? `已关注 ${meta.author}` : "已取消关注", on ? "ok" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "关注失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    const loadedLiked = kind === "video" && detail?.interaction?.liked
      && (detail.interaction.liked_ep === undefined || detail.interaction.liked_ep === curEp);
    return Math.max(0, base + Number(liked) - Number(!!loadedLiked));
  }, [meta.like, liked, kind, detail?.interaction, curEp]);

  const collectCount = useMemo(() => {
    const loadedCollected = kind === "video" && detail?.interaction?.collected;
    return Math.max(0, meta.collect + Number(collected) - Number(!!loadedCollected));
  }, [meta.collect, collected, kind, detail?.interaction]);

  return {
    liked,
    collected,
    likePending,
    collectPending,
    followPending,
    heartBurst,
    likeCount,
    collectCount,
    onLike,
    onFav,
    onFollow,
    togglePip,
  };
}
