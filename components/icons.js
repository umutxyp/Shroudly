/*
 * Shroudly icon set: Lucide (lucide.dev, ISC license), one consistent 24×24
 * line style with stroke="currentColor". Size them with Tailwind (h-4 w-4 …);
 * they are aria-hidden and `shrink-0` so they align with text in flex rows.
 */

import {
  ArrowDown, ArrowUp, Bug, ChartColumn, Check, ChevronDown, CircleCheck, CircleX, Clock, Code, Copy, Database,
  Download, ExternalLink, FileText, Globe, Heart, Info, Languages, Link, LoaderCircle, Lock, Minus, Power, RefreshCw,
  Palette, ScrollText, Scissors, Search, Settings, Shield, ShieldAlert, ShieldCheck, Shuffle, Square, Trash2,
  TriangleAlert, Type, Users, X, Zap,
} from 'lucide-react';

function wrap(Lucide, strokeWidth = 1.75) {
  function Icon({ className = 'h-4 w-4', ...rest }) {
    return <Lucide className={`shrink-0 ${className}`} strokeWidth={strokeWidth} aria-hidden focusable="false" {...rest} />;
  }
  Icon.displayName = Lucide.displayName;
  return Icon;
}

export const ShieldIcon = wrap(Shield);
export const ShieldCheckIcon = wrap(ShieldCheck);
export const ShieldAlertIcon = wrap(ShieldAlert);
export const ChartIcon = wrap(ChartColumn);
export const SettingsIcon = wrap(Settings);
export const LogsIcon = wrap(ScrollText);
export const InfoIcon = wrap(Info);
export const ChevronDownIcon = wrap(ChevronDown, 2);
export const CheckIcon = wrap(Check, 2);
export const MinusIcon = wrap(Minus);
export const SquareIcon = wrap(Square);
export const CloseIcon = wrap(X);
export const PowerIcon = wrap(Power, 2);
export const SpinnerIcon = wrap(LoaderCircle, 2);
export const TrashIcon = wrap(Trash2);
export const CopyIcon = wrap(Copy);
export const SearchIcon = wrap(Search);
export const PaletteIcon = wrap(Palette);
export const LanguagesIcon = wrap(Languages);
export const ArrowDownIcon = wrap(ArrowDown);
export const ArrowUpIcon = wrap(ArrowUp);
export const LinkIcon = wrap(Link);
export const DatabaseIcon = wrap(Database);
export const ClockIcon = wrap(Clock);
export const AlertTriangleIcon = wrap(TriangleAlert);
export const CheckCircleIcon = wrap(CircleCheck);
export const XCircleIcon = wrap(CircleX);
export const LockIcon = wrap(Lock);
export const ZapIcon = wrap(Zap);
export const ScissorsIcon = wrap(Scissors);
export const ShuffleIcon = wrap(Shuffle);
export const GlobeIcon = wrap(Globe);
export const TypeIcon = wrap(Type);
export const CodeIcon = wrap(Code);
export const ExternalLinkIcon = wrap(ExternalLink);
export const RefreshIcon = wrap(RefreshCw);
export const DownloadIcon = wrap(Download);
export const BugIcon = wrap(Bug);
export const FileTextIcon = wrap(FileText);
export const UsersIcon = wrap(Users);
export const HeartIcon = wrap(Heart);
