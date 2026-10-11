/*
 * Shroudly icon set — Lucide-style 24×24 line icons, stroke="currentColor".
 * Size them with Tailwind (h-4 w-4 …); they are aria-hidden by default and
 * align with text via `shrink-0` + flex `items-center` at the call site.
 */

function make(paths, { strokeWidth = 1.75 } = {}) {
  function Icon({ className = 'h-4 w-4', title, ...rest }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`shrink-0 ${className}`}
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        focusable="false"
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {paths}
      </svg>
    );
  }
  return Icon;
}

const SHIELD = 'M12 3.5l6.5 2.4v5.3c0 4.1-2.7 7.9-6.5 9-3.8-1.1-6.5-4.9-6.5-9V5.9L12 3.5z';

export const ShieldIcon = make(<path d={SHIELD} />);
export const ShieldCheckIcon = make(<><path d={SHIELD} /><path d="M9 12l2 2 4-4" /></>);
export const ShieldAlertIcon = make(<><path d={SHIELD} /><path d="M12 8.5v3.5" /><path d="M12 15.5h.01" /></>);

export const ChartIcon = make(<path d="M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3" />);
export const SettingsIcon = make(
  <>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 12a7.4 7.4 0 00-.1-1.1l2-1.6-2-3.4-2.4 1a7.3 7.3 0 00-1.9-1.1l-.4-2.5h-4l-.4 2.5c-.7.3-1.3.6-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.2l-2 1.6 2 3.4 2.4-1c.6.5 1.2.8 1.9 1.1l.4 2.5h4l.4-2.5c.7-.3 1.3-.6 1.9-1.1l2.4 1 2-3.4-2-1.6c.1-.4.1-.7.1-1.1z" />
  </>
);
export const LogsIcon = make(<path d="M7 8h10M7 12h10M7 16h6M5 3.5h14v17H5z" />);
export const InfoIcon = make(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11.5v4.5M12 8h.01" /></>);

export const ChevronDownIcon = make(<path d="M6 9l6 6 6-6" />, { strokeWidth: 2 });
export const CheckIcon = make(<path d="M20 6L9 17l-5-5" />, { strokeWidth: 2 });
export const MinusIcon = make(<path d="M5 12h14" />, { strokeWidth: 1.5 });
export const SquareIcon = make(<rect x="5.5" y="5.5" width="13" height="13" rx="2" />, { strokeWidth: 1.5 });
export const CloseIcon = make(<path d="M6 6l12 12M18 6L6 18" />, { strokeWidth: 1.5 });

export const PowerIcon = make(<><path d="M12 2.5v9" /><path d="M18.4 6.6a9 9 0 11-12.77.04" /></>, { strokeWidth: 2 });
export const SpinnerIcon = make(<path d="M21 12a9 9 0 11-6.22-8.56" />, { strokeWidth: 2 });
export const TrashIcon = make(
  <>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
    <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </>
);
export const SearchIcon = make(<><circle cx="11" cy="11" r="7.5" /><path d="M20.5 20.5l-4.2-4.2" /></>);
export const LanguagesIcon = make(
  <>
    <path d="M5 8l6 6" />
    <path d="M4 14l6-6 2-3" />
    <path d="M2 5h12" />
    <path d="M7 2h1" />
    <path d="M22 22l-5-10-5 10" />
    <path d="M14 18h6" />
  </>
);

export const ArrowDownIcon = make(<><path d="M12 5v14" /><path d="M19 12l-7 7-7-7" /></>);
export const ArrowUpIcon = make(<><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></>);
export const LinkIcon = make(
  <>
    <path d="M9 17H7A5 5 0 017 7h2" />
    <path d="M15 7h2a5 5 0 010 10h-2" />
    <path d="M8 12h8" />
  </>
);
export const DatabaseIcon = make(
  <>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </>
);
export const ClockIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);

export const AlertTriangleIcon = make(
  <>
    <path d="M10.3 3.9L2.4 17.6A2 2 0 004.1 20.6h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>
);
export const CheckCircleIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>);
export const XCircleIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></>);
export const LockIcon = make(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>);
export const ZapIcon = make(<path d="M13 2L4.5 13.5H12L11 22l8.5-11.5H12L13 2z" />);

/* "How it works" technique icons */
export const ScissorsIcon = make(
  <>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4L8.12 15.88" />
    <path d="M14.47 14.48L20 20" />
    <path d="M8.12 8.12L12 12" />
  </>
);
export const ShuffleIcon = make(
  <>
    <path d="M18 14l4 4-4 4" />
    <path d="M18 2l4 4-4 4" />
    <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
    <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
    <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
  </>
);
export const GlobeIcon = make(
  <>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 2.5a14.5 14.5 0 000 19 14.5 14.5 0 000-19" />
    <path d="M2.5 12h19" />
  </>
);
export const TypeIcon = make(<><path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" /></>);
export const CodeIcon = make(<><path d="M8.5 7.5L4 12l4.5 4.5" /><path d="M15.5 7.5L20 12l-4.5 4.5" /><path d="M13.5 5l-3 14" /></>);
export const ExternalLinkIcon = make(<><path d="M14 4.5h5.5V10" /><path d="M19.5 4.5L11 13" /><path d="M18 13.5V19a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 19V8a1.5 1.5 0 011.5-1.5H11" /></>);
export const RefreshIcon = make(<><path d="M20 11.5A8 8 0 006.1 6.4L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M4 12.5a8 8 0 0013.9 5.1L20 15.5" /><path d="M20 20v-4.5h-4.5" /></>);
export const DownloadIcon = make(<><path d="M12 4v11" /><path d="M7.5 10.5L12 15l4.5-4.5" /><path d="M4.5 19.5h15" /></>);
export const BugIcon = make(<><rect x="7.5" y="8" width="9" height="12" rx="4.5" /><path d="M12 12v8M9 8a3 3 0 016 0M4 13h3.5M16.5 13H20M5 8.5l2.6 1.7M19 8.5l-2.6 1.7M5 18.5l2.7-1.7M19 18.5l-2.7-1.7" /></>);
export const FileTextIcon = make(<><path d="M14 3.5H7A1.5 1.5 0 005.5 5v14A1.5 1.5 0 007 20.5h10a1.5 1.5 0 001.5-1.5V8z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6" /></>);
