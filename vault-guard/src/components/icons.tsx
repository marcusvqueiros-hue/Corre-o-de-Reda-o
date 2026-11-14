import type { ReactNode, SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>, d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>{d}</svg>
);
export const ShieldIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9.5 12l2 2 3.5-4" /></>);
export const LockIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>);
export const PlusIcon = (p: SVGProps<SVGSVGElement>) => base(p, <path d="M12 5v14M5 12h14" />);
export const SearchIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></>);
export const DotsIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>);
export const CogIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>);
export const DiceIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" /><circle cx="15" cy="15" r="1" /><circle cx="15" cy="9" r="1" /><circle cx="9" cy="15" r="1" /></>);
export const EyeIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const EyeOffIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><path d="M3 3l18 18" /><path d="M10 6.2A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.3 4M6.5 7.5C3.8 9.3 2 12 2 12s4 7 10 7a9.6 9.6 0 004-.9" /></>);
export const CopyIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 012-2h9" /></>);
export const CloseIcon = (p: SVGProps<SVGSVGElement>) => base(p, <path d="M6 6l12 12M18 6L6 18" />);
export const RefreshIcon = (p: SVGProps<SVGSVGElement>) => base(p, <><path d="M20 11a8 8 0 00-14-4L4 9" /><path d="M4 4v5h5M4 13a8 8 0 0014 4l2-2" /><path d="M20 20v-5h-5" /></>);
