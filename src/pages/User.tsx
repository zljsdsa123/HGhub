import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { UserProfile, VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry } from "../components/cards";
import { Avatar, Empty } from "../components/ui";
import { IBack, IGrid, ISearch, IUser } from "../icons";

/* ================= 关注流 ================= */
export function FollowingPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, user, setLoginOpen, toast, pop, setTab } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.following(next, 20);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      setErr((e as Error).message || "加载失败");
      toast((e as Error).message || "加载失败", "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [page, pages, toast]);

  useEffect(() => {
    if (!user) return;
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <span className="text-[17px] font-bold text-on">关注</span>
          <span className="text-[10.5px] text-mut">{items.length} 部</span>
          <button onClick={() => { pop(); setTab("search"); }} aria-label="搜索" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {!user ? (
          <Empty icon={<IUser size={26} />} title="登录后查看关注流" sub="关注喜欢的作者，第一时间看到他们的新作品"
            action="去登录" onAction={() => setLoginOpen(true)} />
        ) : loading && !items.length ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={loadMore} />
        ) : items.length ? (
          <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: "关注" })} />
        ) : (
          <Empty icon={<IGrid size={26} />} title="还没有关注内容" sub="去关注一些作者吧，这里会聚合他们的更新" />
        )}
        <div ref={sentinel} className="h-8" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><div className="w-6 h-6 spinner" /></div>}
        {!loading && items.length > 0 && page >= pages && <div className="text-center text-[10.5px] text-dim py-3">— 已经到底啦 —</div>}
      </div>
    </div>
  );
}

/* ================= 用户主页 ================= */
export function UserPage({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { push, toast, follows, toggleFollowLocal, user, setLoginOpen, pop, setTab } = useStore();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<{ followers?: number; video_count?: number; post_count?: number; like_count?: number }>({});
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.user(id).then((u) => { if (alive) setProfile(u); }).catch(() => {});
    api.userStats(id).then((s) => { if (alive) setStats(s); }).catch(() => {});
    return () => { alive = false; };
  }, [id]);

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.userVideos(id, next, 20);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      setErr((e as Error).message || "加载失败");
      toast((e as Error).message || "加载失败", "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [id, page, pages, toast]);

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  const following = follows.includes(id);
  const onFollow = () => {
    const on = toggleFollowLocal(id);
    toast(on ? `已关注 ${profile?.nickname || name || ""}` : "已取消关注", on ? "ok" : "info");
    if (!user) { setLoginOpen(true); return; }
    api.follow(id, on).catch(() => {});
  };

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <span className="text-[16px] font-bold text-on truncate">{profile?.nickname || name || "用户主页"}</span>
          <button onClick={() => { pop(); setTab("search"); }} aria-label="搜索" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {/* 资料卡 */}
        <div className="rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
          <Avatar size={56} name={profile?.nickname || name || "U"} hue={220} ring />
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on truncate">{profile?.nickname || name || "未知用户"}</div>
            {profile?.username && <div className="text-[11px] text-mut mt-0.5">@{profile.username} · ID {id}</div>}
            <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
              <span>作品 <b className="text-on">{fmt(stats.video_count)}</b></span>
              <span>粉丝 <b className="text-on">{fmt(stats.followers)}</b></span>
              <span>获赞 <b className="text-on">{fmt(stats.like_count)}</b></span>
            </div>
          </div>
          <button onClick={onFollow}
            className={`h-8 px-3.5 rounded-full text-[11.5px] font-semibold pressable shrink-0 ${following ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
            {following ? "已关注" : "+ 关注"}
          </button>
        </div>

        {profile?.sign && <div className="mt-3 text-[12px] text-mut leading-relaxed">{profile.sign}</div>}

        <div className="mt-4 mb-2.5 text-[13px] font-bold text-on">作品 {items.length ? `(${items.length})` : ""}</div>

        {loading && !items.length ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={loadMore} />
        ) : items.length ? (
          <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: profile?.nickname || name || "用户作品" })} />
        ) : (
          <Empty icon={<IGrid size={26} />} title="暂无作品" />
        )}
        <div ref={sentinel} className="h-8" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><div className="w-6 h-6 spinner" /></div>}
        {!loading && items.length > 0 && page >= pages && <div className="text-center text-[10.5px] text-dim py-3">— 已经到底啦 —</div>}
      </div>
    </div>
  );
}