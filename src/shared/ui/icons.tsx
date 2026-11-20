import React from "react";

type P = { size?: number; className?: string; style?: React.CSSProperties; strokeWidth?: number };
const S = (d: React.ReactNode, fill = false) =>
  function Icon({ size = 24, className = "", style, strokeWidth = 2 }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style}
        fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"}
        strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {d}
      </svg>
    );
  };

export const IVertSwap = S(<><path d="M7 8 12 4l5 4" /><path d="M7 16l5 4 5-4" /><path d="M12 8v8" /></>);
export const IHome = S(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h5v-6h4v6h5V9.5" /></>);
export const IHomeF = S(<path d="M12 2.6 2.8 10.2a1 1 0 0 0 .64 1.77H4v8.2A1.8 1.8 0 0 0 5.8 22H9.4v-5.6a2.6 2.6 0 0 1 5.2 0V22h3.6a1.8 1.8 0 0 0 1.8-1.8V12h.56a1 1 0 0 0 .64-1.77Z" />, true);
export const ISearch = S(<><circle cx="11" cy="11" r="7" /><path d="m20.4 20.4-3.2-3.2" /></>);
const grid = <><rect x="3.5" y="3.5" width="7.2" height="7.2" rx="2.2" /><rect x="13.3" y="3.5" width="7.2" height="7.2" rx="2.2" /><rect x="3.5" y="13.3" width="7.2" height="7.2" rx="2.2" /><rect x="13.3" y="13.3" width="7.2" height="7.2" rx="2.2" /></>;
export const IGrid = S(grid);
export const IGridF = S(<><rect x="3" y="3" width="8" height="8" rx="2.4" /><rect x="13" y="3" width="8" height="8" rx="2.4" /><rect x="3" y="13" width="8" height="8" rx="2.4" /><rect x="13" y="13" width="8" height="8" rx="2.4" /></>, true);
export const IUser = S(<><circle cx="12" cy="8" r="4.2" /><path d="M4.5 20.4c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4" /></>);
export const IUserF = S(<><circle cx="12" cy="7.6" r="4.8" /><path d="M12 14.6c-4 0-7.1 2.2-8.3 5.7-.3.9.4 1.7 1.3 1.7h14c.9 0 1.6-.8 1.3-1.7-1.2-3.5-4.3-5.7-8.3-5.7Z" /></>, true);
export const IHeart = S(<path d="M12 20.6C6.4 16.9 3 13.6 3 9.9 3 7.2 5.1 5 7.8 5c1.7 0 3.2.8 4.2 2.2C13 5.8 14.5 5 16.2 5 18.9 5 21 7.2 21 9.9c0 3.7-3.4 7-9 10.7Z" />);
export const IHeartF = S(<path d="M12 21.1C6.1 17.2 2.5 13.7 2.5 9.8c0-3 2.3-5.3 5.2-5.3 1.7 0 3.3.8 4.3 2.2 1-1.4 2.6-2.2 4.3-2.2 2.9 0 5.2 2.3 5.2 5.3 0 3.9-3.6 7.4-9.5 11.3Z" />, true);
export const IStar = S(<path d="m12 3.4 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.6l5.9-.8Z" />);
export const IStarF = S(<path d="m12 2.8 2.8 5.7 6.3.9c.6.1.9.9.4 1.3l-4.5 4.4 1 6.2c.1.6-.5 1.1-1.1.8L11.3 19l-5.6 3c-.6.3-1.2-.2-1.1-.8l1-6.2L1.1 10.7c-.5-.4-.2-1.2.4-1.3l6.3-.9L10.6 2.8c.3-.6 1.1-.6 1.4 0Z" />, true);
export const ICommentF = S(<path d="M12 2.8c5.4 0 9.8 3.9 9.8 8.8s-4.4 8.8-9.8 8.8c-.9 0-1.8-.1-2.6-.3-1.2 1-2.9 1.8-5 1.9-.5 0-.8-.5-.5-.9.8-1.1 1.3-2.3 1.4-3.5C3.4 16 2.2 13.9 2.2 11.6c0-4.9 4.4-8.8 9.8-8.8Z" />, true);
export const IExpand = S(<><path d="M8.5 3.5H3.5v5" /><path d="M15.5 3.5h5v5" /><path d="M8.5 20.5h-5v-5" /><path d="M15.5 20.5h5v-5" /></>);
export const ICompress = S(<><path d="M3.5 8.5h5v-5" /><path d="M20.5 8.5h-5v-5" /><path d="M3.5 15.5h5v5" /><path d="M20.5 15.5h-5v5" /></>);
export const IBack = S(<path d="m14.5 5-7 7 7 7" strokeWidth={2.4} />);
export const IChevR = S(<path d="m9.5 5 7 7-7 7" />);
export const IPlayF = S(<path d="M7.5 4.3c0-1 1.1-1.6 2-1.1l11 6.7c.9.5.9 1.7 0 2.2l-11 6.7c-.9.5-2-.1-2-1.1Z" />, true);
export const IPauseF = S(<><rect x="5.5" y="3.5" width="4.6" height="17" rx="1.6" /><rect x="13.9" y="3.5" width="4.6" height="17" rx="1.6" /></>, true);
export const ICheck = S(<path d="m4.5 12.5 5 5 10-11" />);
export const IClose = S(<><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>);
export const ITrophy = S(<><path d="M8 4h8v6a4 4 0 0 1-8 0Z" /><path d="M8 5H4.5v1.5A3.5 3.5 0 0 0 8 10" /><path d="M16 5h3.5v1.5A3.5 3.5 0 0 1 16 10" /><path d="M12 14v3.5" /><path d="M8 20.5h8" /><path d="M9.5 17.5h5v3h-5Z" /></>);
export const IFireF = S(<path d="M12.6 2.6c.3-.3.9-.1.9.4.1 1.7.6 3.4 2 4.9 1.7 1.8 3.5 3.7 3.5 6.6 0 4-3.1 7-7 7s-7-3-7-7c0-2.3 1.1-4.2 2.4-5.6.3-.3.9-.1 1 .3.2.8.5 1.5 1.1 2 .1-3.1 1.2-6.5 3.1-8.6Z" />, true);
export const IMore = S(<><circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none" /></>);
export const IEye = S(<><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></>);
export const IEyeOff = S(<><path d="M4 4.5 20 19.5" /><path d="M9.9 6.2A9.4 9.4 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17.5 17.5 0 0 1-3 3.5M6.6 7.4A16.6 16.6 0 0 0 2.5 12S6 18.2 12 18.2c1.2 0 2.3-.2 3.3-.6" /></>);
export const ILockF = S(<><rect x="5" y="10.5" width="14" height="10" rx="2.6" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" strokeWidth="2.2" /></>, true);
export const IBoltF = S(<path d="M13.4 2.3 4.8 13.1c-.4.5 0 1.2.6 1.2h5l-1.7 7.2c-.2.7.7 1.1 1.2.6l8.6-10.8c.4-.5 0-1.2-.6-1.2h-5l1.7-7.2c.2-.7-.7-1.1-1.2-.6Z" />, true);
export const IVol = S(<><path d="M4 9.5v5h3.2L12 18.8V5.2L7.2 9.5Z" fill="currentColor" stroke="none" /><path d="M15.5 9a4.3 4.3 0 0 1 0 6" /><path d="M18 6.5a8 8 0 0 1 0 11" /></>);
export const IVolMute = S(<><path d="M4 9.5v5h3.2L12 18.8V5.2L7.2 9.5Z" fill="currentColor" stroke="none" /><path d="m15.5 9.5 5 5" /><path d="m20.5 9.5-5 5" /></>);
export const ISettings = S(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8 13.6 5h2.7l.9 2.5 2.4 1.2-.5 2.7 1.7 2.1-1.7 2.1.5 2.7-2.4 1.2-.9 2.5h-2.7L12 21.2 10.4 19H7.7l-.9-2.5-2.4-1.2.5-2.7L3.2 10.5l1.7-2.1-.5-2.7L6.8 4.5 7.7 2h2.7Z" strokeWidth={1.6} /></>);
export const ILogout = S(<><path d="M14 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h7" /><path d="m16 8 4 4-4 4" /><path d="M20 12H9.5" /></>);
export const ILogin = S(<><path d="M10 4.5h7A2.5 2.5 0 0 1 19.5 7v10a2.5 2.5 0 0 1-2.5 2.5h-7" /><path d="m12 8 4 4-4 4" /><path d="M16 12H4.5" /></>);
export const ILink = S(<><path d="M9.5 14.5 14.5 9.5" /><path d="M11 6.5 13 4.5a4 4 0 0 1 6.5 6.5l-2 2" /><path d="M13 17.5 11 19.5A4 4 0 0 1 4.5 13l2-2" /></>);
export const IClock = S(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.2l3.4 2" /></>);
export const ISendF = S(<path d="M3.6 11 19.4 3.6c.8-.4 1.6.4 1.3 1.2L14.4 20.7c-.3.8-1.5.8-1.8 0l-2-5.4a1 1 0 0 0-.6-.6l-6.3-1.9c-.9-.2-.9-1.4-.1-1.8Z" />, true);
export const IRefresh = S(<><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 3.5V7h-3.5" /></>);
export const ISparkF = S(<path d="M12 2.5c.6 3.9 1.7 6.1 3.3 7.7 1.6 1.6 3.8 2.6 6.2 3.3-3.9.6-6.1 1.7-7.7 3.3-1.6 1.6-2.6 3.8-3.3 6.2-.6-3.9-1.7-6.1-3.3-7.7-1.6-1.6-3.8-2.6-6.2-3.3 3.9-.6 6.1-1.7 7.7-3.3 1.6-1.6 2.6-3.8 3.3-6.2Z" />, true);
export const IMinus = S(<path d="M5 12h14" />);
export const ISquare = S(<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />);
export const IPip = S(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><rect x="12" y="12" width="6.5" height="4.8" rx="1.2" fill="currentColor" stroke="none" /></>);

export const ISidebar = S(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>);
export const IChevronUp = S(<path d="m6 14 6-6 6 6" />);
export const IChevronDown = S(<path d="m6 10 6 6 6-6" />);
export const IRestore = S(<><rect x="4" y="8" width="12" height="12" rx="1.5" /><path d="M8 5V4h12v12h-1" /></>);
export const ITheater = S(<><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M6.5 5v14M17.5 5v14" /></>);
export const INext = S(<><path d="M5 5v14l10-7Z" fill="currentColor" stroke="none" /><path d="M18 5v14" /></>);
export const ISun = S(<><circle cx="12" cy="12" r="3.4" /><path d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" /></>);
export const IMoon = S(<path d="M16.5 13.2A6.6 6.6 0 0 1 10.2 5 6.8 6.8 0 1 0 16.5 13.2Z" />);

export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="logo-x-night" x1="4" y1="0" x2="60" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#06465b" />
          <stop offset="1" stopColor="#002837" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="17.455" fill="url(#logo-x-night)" />
      <rect x=".65" y=".65" width="62.7" height="62.7" rx="16.8" fill="none" stroke="#60cdff" strokeOpacity=".14" strokeWidth=".8" />
      <g transform="translate(-2.909091 -2.909091) scale(1.4545455)">
        <path d="M14 13v22M14 24h10M24 13v22" stroke="#60cdff" strokeWidth="4.4" strokeLinecap="round" fill="none" />
        <path d="M31 17.5c3.2 0 5.5 2.6 5.5 6.5S34.2 30.5 31 30.5" stroke="#60cdff" strokeWidth="4" strokeLinecap="round" fill="none" />
      </g>
      <path d="M40 27.2 46.3 31.9 40 36.6Z" fill="#b1f5dc" />
      <path d="M46.7 11.3 52.5 17.1M52.5 11.3 46.7 17.1" stroke="#b1f5dc" strokeWidth="2.9" strokeLinecap="round" />
    </svg>
  );
}
export const IList = S(<><path d="M8.5 6.5h11" /><path d="M8.5 12h11" /><path d="M8.5 17.5h11" /><circle cx="4.6" cy="6.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="4.6" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="4.6" cy="17.5" r="1.2" fill="currentColor" stroke="none" /></>);
export const IFileText = S(<><path d="M6.5 3.5h7.2l3.8 3.8v13.2H6.5z" /><path d="M13.7 3.5v3.8h3.8" /><path d="M9.4 12.2h5.2" /><path d="M9.4 15.6h5.2" /></>);
export const IInfo = S(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.2" /><circle cx="12" cy="8.1" r="0.9" fill="currentColor" stroke="none" /></>);

export const IBroom = S(<><path d="M14.5 4.5 9 10" /><path d="m9.6 8.6 5.8 5.8" /><path d="M8.4 13.6c-2 1.1-3.2 2.9-3.6 5.4 2.5-.4 4.3-1.6 5.4-3.6" /><path d="m11.6 11.4-1.2 1.2" /></>);
export const ILayers = S(<><path d="m12 3.6 8.4 4.4L12 12.4 3.6 8Z" /><path d="m3.6 12.4 8.4 4.4 8.4-4.4" /><path d="m3.6 16.6 8.4 4.2 8.4-4.2" /></>);
export const ITag = S(<><path d="M3.8 11.4V5.2A1.4 1.4 0 0 1 5.2 3.8h6.2a1.4 1.4 0 0 1 1 .41l7.4 7.4a1.4 1.4 0 0 1 0 1.98l-6.2 6.2a1.4 1.4 0 0 1-1.98 0l-7.4-7.4a1.4 1.4 0 0 1-.42-1Z" /><circle cx="8.2" cy="8.2" r="1.35" fill="currentColor" stroke="none" /></>);
export const IFilm = S(<><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M3.5 9h17" /><path d="m8.8 4.5-1.8 4.5" /><path d="m14.8 4.5-1.8 4.5" /><path d="m10.4 11.8 4.4 2.5-4.4 2.5Z" fill="currentColor" stroke="none" /></>);
export const ISpark = S(<><path d="M11 3.5c.5 3.3 1.4 5.1 2.8 6.5 1.4 1.4 3.2 2.3 6.5 2.8-3.3.5-5.1 1.4-6.5 2.8-1.4 1.4-2.3 3.2-2.8 6.5-.5-3.3-1.4-5.1-2.8-6.5-1.4-1.4-3.2-2.3-6.5-2.8 3.3-.5 5.1-1.4 6.5-2.8C9.6 8.6 10.5 6.8 11 3.5Z" /><path d="M18.5 3.5v3M17 5h3" /></>);
export const IAward = S(<><path d="m4 8.2 4.1 3.5L12 5.6l3.9 6.1L20 8.2l-1.7 10.3H5.7Z" /><path d="M6.5 21h11" /></>);
export const IFlame = S(<path d="M12.5 3c.2 2.5 1.3 4.2 2.8 5.8 1.6 1.7 3.2 3.5 3.2 6.2a6.5 6.5 0 0 1-13 0c0-2.2 1-4.1 2.4-5.5.4 1.2 1.1 2 2 2.4.1-3.1 1-6.5 2.6-8.9Z" />);
export const IGlobe = S(
  <>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M3.4 12h17.2" />
    <path d="M12 3.2c2.6 2.4 4 5.5 4 8.8s-1.4 6.4-4 8.8c-2.6-2.4-4-5.5-4-8.8s1.4-6.4 4-8.8Z" />
  </>,
);
