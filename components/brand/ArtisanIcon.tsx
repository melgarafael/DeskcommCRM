import type { SVGProps } from "react";

export type ArtisanSymbol =
  | "conversation"
  | "pipeline"
  | "agent"
  | "people"
  | "calendar"
  | "spark"
  | "tools"
  | "settings"
  | "instagram"
  | "whatsapp";
const strokes: Record<ArtisanSymbol, React.ReactNode> = {
  conversation: (
    <>
      <path d="M5 5.5c4-2 12-2 15 1 2 3 1 9-2 11-3 2-7 1-10 1l-5 3 1.5-6C2 12 2 8 5 5.5Z" />
      <path d="M7 9.5h9M7 13h6" />
    </>
  ),
  pipeline: (
    <>
      <path d="m3 4 6 .5 6-.5 6 .5v15l-6 .5-6-.5-6 .5Z" />
      <path d="M9 5v14M15 5v14M5 9h2m4 4h2m4-5h2" />
    </>
  ),
  agent: (
    <>
      <path d="M6 6c3-1 10-1 13 1l1 12c-4 1-11 2-16-1L5 8Z" />
      <path d="m12 5 1-3M8 11v2m8-2v2m-7 3c2 1 4 1 6 0M3 11l-1 4m20-4v4" />
    </>
  ),
  people: (
    <>
      <path d="M6 6c1-3 6-3 7 0s-1 6-3 6-5-3-4-6Zm-3 14c0-8 14-8 14 0M17 4c5 0 5 7 1 8m1 3c3 1 3 3 3 5" />
    </>
  ),
  calendar: (
    <>
      <path d="m4 5 16-1 1 16-17 1L3 6M7 2v5m10-5v5M4 10h16m-13 4h2m4 0h2m-8 3h2" />
    </>
  ),
  spark: (
    <>
      <path d="m4 20 13-14M9 5l9-1 1 9M4 4l1 3m-3-1h5M18 18l1 4m-3-2h6" />
    </>
  ),
  tools: (
    <>
      <path d="m3 3 7 1-1 6H3Zm12 1 6-1v7l-6-1ZM3 15l7-1v7H3Zm12-1 6 1-1 6-6-1Z" />
    </>
  ),
  settings: (
    <>
      <path d="M3 6h18M3 12h18M3 18h18" />
      <path d="M7 3v6m9 0v6m-6 0v6" />
    </>
  ),
  instagram: (
    <>
      <path d="M7 3c3-1 9-1 12 1 2 2 2 13 0 15-2 2-13 2-15 0C2 17 2 6 4 4Z" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r=".7" fill="currentColor" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M5 5C9 1 17 2 20 7c4 7-2 15-10 13l-7 2 2-6C2 12 2 8 5 5Z" />
      <path d="m8 7-1 3c1 4 3 6 7 7l3-2-3-2-2 1-2-3 1-2Z" />
    </>
  ),
};
/** Original, slightly irregular strokes; decorative with names supplied by the control. */
export function ArtisanIcon({
  symbol,
  ...props
}: SVGProps<SVGSVGElement> & { symbol: ArtisanSymbol }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {strokes[symbol]}
    </svg>
  );
}
